// The review queue on the server: taking turns between workspaces, the concurrency caps, waiting for a
// review model, leases and lost runners, replacing and cancelling, redacting runners' logs, and who may
// use the runner API. Runners are played by calls to the service (or HTTP, for the API's checks).

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Actor } from "../src/services/core.ts";
import { createServices } from "../src/services/index.ts";
import { budget, type RunnerHello, specForBranch, specForPull } from "../src/services/runs.ts";
import type { Project } from "../src/store/types.ts";
import { ADMIN_PASSWORD } from "./helpers.ts";
import { MODEL_KEY, PAT, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const ADMIN: Actor = { name: "admin", userId: null, via: "web" };
const runner = (id: string, slots = 1): RunnerHello => ({ id: `runner-${id}-0000`, name: id, version: "1", slots });

async function projectOf(env: ReviewEnv, ws: string): Promise<Project> {
    const w = await env.t.services.store.workspaces.bySlug(ws);
    return (await env.t.services.store.projects.bySlug(w?.id as string, "app")) as Project;
}

const pull = (n: number, sha: string) =>
    specForPull({
        number: n,
        title: `PR ${n}`,
        state: "open",
        html_url: `https://github.com/acme/app/pull/${n}`,
        user: { login: "octo" },
        head: { ref: `b${n}`, sha, repo: { full_name: "acme/app" } },
        base: { ref: "main", sha: "0".repeat(40), repo: { full_name: "acme/app" } },
    });

describe("taking turns, caps and readiness", () => {
    let env: ReviewEnv;
    before(async () => {
        env = await reviewEnv({ env: { REVIEW_CONCURRENCY: "1", REVIEW_CONCURRENCY_PER_WORKSPACE: "1" } });
        await patProject(env, "alpha", { token: PAT(1) });
        await patProject(env, "beta", { token: PAT(2) });
        await patProject(env, "gamma", { token: PAT(3), key: false });
    });
    after(() => env.close());

    test("each workspace takes its turn, oldest first within it; one at a time on this instance", async () => {
        const runs = env.t.services.runs;
        const [a, b, c] = [await projectOf(env, "alpha"), await projectOf(env, "beta"), await projectOf(env, "gamma")];
        const a1 = await runs.enqueue(ADMIN, a, specForBranch("full", "a1", null));
        const a2 = await runs.enqueue(ADMIN, a, specForBranch("full", "a2", null));
        const a3 = await runs.enqueue(ADMIN, a, specForBranch("full", "a3", null));
        const c1 = await runs.enqueue(ADMIN, c, specForBranch("full", "c1", null));
        const b1 = await runs.enqueue(ADMIN, b, specForBranch("full", "b1", null));
        const order: string[] = [];
        for (let i = 0; i < 4; i++) {
            const job = await runs.claim(runner("r1"));
            assert.ok(job, `claim ${i + 1}`);
            order.push(job.id);
            // The instance runs one review at a time.
            assert.equal(await runs.claim(runner("r2")), null);
            await runs.finish(runner("r1"), job.id, { status: "failed", error: "test" });
        }
        assert.deepEqual(order, [a1.id, b1.id, a2.id, a3.id]);
        // Gamma has no model key: its review waits, and says why.
        assert.equal(await runs.claim(runner("r1")), null);
        const list = (await env.t.request("/api/v1/w/gamma/runs", { session: env.admin })).body;
        assert.equal(list.queued[0].id, c1.id);
        assert.equal(list.ready, false);
        assert.match(list.waiting, /Add an OpenRouter API key in Settings → Review model & keys/);
        assert.match(list.queued[0].waiting, /OpenRouter API key/);
        // Once it has a key, it runs.
        await env.t.request("/api/v1/w/gamma/settings/review-model/keys/openrouter", {
            method: "PUT",
            session: env.admin,
            body: { key: MODEL_KEY },
        });
        assert.equal((await runs.claim(runner("r1")))?.id, c1.id);
        await runs.finish(runner("r1"), c1.id, { status: "failed", error: "test" });
    });
});

describe("per-workspace cap", () => {
    let env: ReviewEnv;
    before(async () => {
        env = await reviewEnv({ env: { REVIEW_CONCURRENCY: "4", REVIEW_CONCURRENCY_PER_WORKSPACE: "1" } });
        await patProject(env, "alpha", { token: PAT(1) });
        await patProject(env, "beta", { token: PAT(2) });
    });
    after(() => env.close());

    test("a workspace runs one review at a time, while others still get theirs", async () => {
        const runs = env.t.services.runs;
        const [a, b] = [await projectOf(env, "alpha"), await projectOf(env, "beta")];
        await runs.enqueue(ADMIN, a, specForBranch("full", "x", null));
        await runs.enqueue(ADMIN, a, specForBranch("full", "y", null));
        await runs.enqueue(ADMIN, b, specForBranch("full", "z", null));
        const first = await runs.claim(runner("r1", 4));
        const second = await runs.claim(runner("r1", 4));
        assert.equal(first?.title, "Full scan of x");
        assert.equal(second?.title, "Full scan of z");
        assert.equal(await runs.claim(runner("r1", 4)), null);
        const list = (await env.t.request("/api/v1/w/alpha/runs", { session: env.admin })).body;
        assert.equal(list.counts.running, 1);
        assert.match(list.queued[0].waiting, /this workspace's running review/);
        // A claimed job carries what the runner needs, including this job's credentials.
        assert.equal(first?.git.token, PAT(1));
        assert.equal(first?.model.apiKey, MODEL_KEY);
        assert.equal(first?.repository.cloneUrl, `${env.fake.url}/acme/app.git`);
        assert.equal(first?.timeoutMinutes, 120);
    });
});

describe("leases, replacing, cancelling and redaction", () => {
    let env: ReviewEnv;
    let project: Project;
    before(async () => {
        env = await reviewEnv({ env: { REVIEW_CONCURRENCY: "5", REVIEW_CONCURRENCY_PER_WORKSPACE: "5" } });
        await patProject(env, "acme");
        project = await projectOf(env, "acme");
        env.fake.repo("acme/app");
    });
    after(() => env.close());

    test("a runner that stops renewing its lease loses the job, which fails saying so", async () => {
        const runs = env.t.services.runs;
        const job = await runs.enqueue(ADMIN, project, specForBranch("full", "lease", null));
        const claimed = await runs.claim(runner("r1"));
        assert.equal(claimed?.id, job.id);
        const renewed = await runs.heartbeat(runner("r1"), job.id);
        assert.equal(renewed.cancel, false);
        assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.now() + 50_000);
        // Time passes without word from the runner (it crashed, or was restarted).
        const stored = await env.t.services.store.jobs.get(job.id);
        await env.t.services.store.jobs.put({
            ...(stored as NonNullable<typeof stored>),
            leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        });
        assert.equal(await runs.sweep(), 1);
        const after = await env.t.services.store.jobs.get(job.id);
        assert.equal(after?.status, "failed");
        assert.match(after?.error ?? "", /The runner stopped responding/);
        assert.equal(after?.credentials, null);
        await assert.rejects(runs.heartbeat(runner("r1"), job.id), (e: { status?: number }) => e.status === 409);
        await assert.rejects(
            runs.finish(runner("r1"), job.id, { status: "done", report: { comments: [] } }),
            (e: { status?: number }) => e.status === 409,
        );
        // Another runner can't act on someone else's job either.
        const next = await runs.enqueue(ADMIN, project, specForBranch("full", "lease2", null));
        await runs.claim(runner("r1"));
        await assert.rejects(runs.events(runner("r2"), next.id, { lines: [{ line: "hi" }] }), (e: { status?: number }) => e.status === 409);
        await runs.finish(runner("r1"), next.id, { status: "failed", error: "x" });
        const wsId = project.workspaceId;
        const failed = (await env.t.services.history.list({ workspaceId: wsId })).find((r) =>
            r.details.error?.includes("stopped responding"),
        );
        assert.equal(failed?.status, "failed");
    });

    test("a newer commit replaces a queued review; the same commit isn't queued twice", async () => {
        const runs = env.t.services.runs;
        const first = await runs.enqueue(ADMIN, project, pull(5, "a".repeat(40)));
        const again = await runs.enqueue(ADMIN, project, pull(5, "a".repeat(40)));
        assert.equal(again.id, first.id);
        const newer = await runs.enqueue(ADMIN, project, pull(5, "b".repeat(40)));
        assert.notEqual(newer.id, first.id);
        const replaced = await env.t.services.store.jobs.get(first.id);
        assert.equal(replaced?.status, "cancelled");
        assert.match(replaced?.error ?? "", /Replaced by a newer request \(commit bbbbbbb\)/);
        const c = await env.t.request(`/api/v1/w/acme/runs/${newer.id}/cancel`, { method: "POST", session: env.admin, body: {} });
        assert.equal(c.body.status, "cancelled");
        assert.match(c.body.error, /Cancelled by admin before it started/);
        assert.equal(
            (await env.t.request(`/api/v1/w/acme/runs/${newer.id}/cancel`, { method: "POST", session: env.admin, body: {} })).status,
            409,
        );
        assert.equal(
            (await env.t.request("/api/v1/w/acme/runs/nope/cancel", { method: "POST", session: env.admin, body: {} })).status,
            404,
        );
    });

    test("cancelling a running review tells its runner, which stops", async () => {
        const runs = env.t.services.runs;
        const job = await runs.enqueue(ADMIN, project, specForBranch("full", "stop-me", null));
        await runs.claim(runner("r1"));
        const c = await env.t.request(`/api/v1/w/acme/runs/${job.id}/cancel`, { method: "POST", session: env.admin, body: {} });
        assert.equal(c.body.status, "running");
        assert.equal(c.body.cancelRequested.by, "admin");
        assert.equal((await runs.heartbeat(runner("r1"), job.id)).cancel, true);
        assert.equal((await runs.events(runner("r1"), job.id, { lines: [] })).cancel, true);
        await runs.finish(runner("r1"), job.id, { status: "cancelled" });
        const done = await env.t.services.store.jobs.get(job.id);
        assert.equal(done?.status, "cancelled");
        assert.equal(done?.error, "Cancelled by admin.");
    });

    test("every secret handed to the runner is redacted from its log, by any server process", async () => {
        const runs = env.t.services.runs;
        const job = await runs.enqueue(ADMIN, project, specForBranch("full", "secrets", null));
        const claimed = await runs.claim(runner("r1"));
        assert.ok(claimed);
        const token = claimed.git.token;
        const key = claimed.model.apiKey;
        const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
        const lines = [
            `token ${token} here`,
            `header: Authorization: Basic ${basic}`,
            `url https://x-access-token:${token}@github.com/acme/app.git`,
            `model key ${key}`,
            `encoded ${encodeURIComponent(key)}`,
            "an installation token ghs_abcdefghijklmnopqrstuvwxyz0123456789 leaked",
        ];
        await runs.events(runner("r1"), job.id, {
            lines: lines.slice(0, 3).map((line) => ({ line })),
            progress: { phase: "reviewing", files: 3, nonsense: "x" },
        });
        // Another server process (fresh caches, same database) still knows what to redact.
        const other = createServices(env.t.services.config, env.t.services.store);
        await other.runs.events(runner("r1"), job.id, { lines: lines.slice(3).map((line) => ({ line })) });
        const stored = (await env.t.services.store.jobs.log(job.id, 0, 100)).map((l) => l.line);
        const text = stored.join("\n");
        assert.ok(!text.includes(token) && !text.includes(key) && !text.includes(basic) && !text.includes("ghs_abcdefghijklmnop"), text);
        assert.equal(stored.length, 6);
        assert.equal((text.match(/\[redacted\]/g) ?? []).length >= 6, true);
        const j = await env.t.services.store.jobs.get(job.id);
        assert.deepEqual(j?.progress, { phase: "reviewing", files: 3 });
        // Finishing with an error that quotes a secret is redacted too.
        await runs.finish(runner("r1"), job.id, { status: "failed", error: `git said: bad token ${token}` });
        assert.equal((await env.t.services.store.jobs.get(job.id))?.error, "git said: bad token [redacted]");
    });
});

describe("what runners send: every form of a secret, every string of a report, and reports that aren't OCR's", () => {
    let env: ReviewEnv;
    let project: Project;
    before(async () => {
        env = await reviewEnv({ env: { REVIEW_CONCURRENCY: "5", REVIEW_CONCURRENCY_PER_WORKSPACE: "5" } });
        await patProject(env, "acme");
        project = await projectOf(env, "acme");
        env.fake.repo("acme/app");
    });
    after(() => env.close());

    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const hex = (s: string) => Buffer.from(s).toString("hex");

    test("encoded secrets, progress and every string in a report are redacted before they're kept or posted", async () => {
        const runs = env.t.services.runs;
        const job = await runs.enqueue(ADMIN, project, specForBranch("full", "encoded", null));
        const claimed = await runs.claim(runner("r1"));
        assert.ok(claimed);
        const key = claimed.model.apiKey;
        const token = claimed.git.token;
        const forms = [
            b64(`a${key}`),
            b64(`ab${key}`),
            b64(`user:${key}`),
            hex(key),
            hex(`>${token}<`).toUpperCase(),
            [...key].map((c) => `%${c.charCodeAt(0).toString(16)}`).join(""),
            JSON.stringify(key).replace(/[a-z]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`),
            `mid${key}mid`,
        ];
        await runs.events(runner("r1"), job.id, {
            lines: forms.map((f) => ({ line: `seen ${f} here` })),
            progress: { phase: "reviewing", message: `progress ${key}`, current: `src/${b64(`q${key}`)}` },
        });
        const stored = (await env.t.services.store.jobs.log(job.id, 0, 100)).map((l) => l.line);
        assert.equal(stored.length, forms.length);
        // What surrounds the secret is kept (base64 of "user:", say), down to a character carrying bits of both.
        for (const [i, line] of stored.entries()) {
            assert.match(line, /^seen \S*\[redacted\]\S* here$/, `form ${i}: ${forms[i]}`);
            for (const part of [key, token, b64(key).slice(4, -4), hex(key).slice(4, -4)]) assert.ok(!line.includes(part), line);
        }
        const progress = JSON.stringify((await env.t.services.store.jobs.get(job.id))?.progress);
        assert.ok(!progress.includes(key) && !progress.includes(b64(`q${key}`).slice(4, -4)), progress);

        await runs.finish(runner("r1"), job.id, {
            status: "done",
            report: {
                comments: [{ path: "src/a.ts", content: `This line holds the key ${key} in plain sight.`, severity: "high" }],
                warnings: [{ type: "review_round_failed", file: `src/${key}.ts`, message: `401 with ${b64(`u:${key}`)}` }],
            },
        });
        const done = await env.t.services.store.jobs.get(job.id);
        assert.equal(done?.status, "partial");
        const everything = JSON.stringify([done, await env.t.services.store.reports.get(project.id, "encoded")]);
        for (const f of [key, b64(`u:${key}`).slice(4, -4)]) assert.ok(!everything.includes(f), `${f} was kept`);
        assert.match(String((done?.result?.gaps as { note?: string } | undefined)?.note), /src\/\[redacted\]\.ts/);
    });

    test("characters Postgres can't hold are dropped from log lines, progress and errors", async () => {
        const runs = env.t.services.runs;
        const job = await runs.enqueue(ADMIN, project, specForBranch("full", "nul", null));
        assert.ok(await runs.claim(runner("r1")));
        await runs.events(runner("r1"), job.id, { lines: [{ line: "before\u0000after" }], progress: { current: "a\u0000b" } });
        await runs.events(runner("r1"), job.id, { lines: [{ line: "still delivered" }] });
        assert.deepEqual(
            (await env.t.services.store.jobs.log(job.id, 0, 10)).map((l) => l.line),
            ["beforeafter", "still delivered"],
        );
        assert.equal((await env.t.services.store.jobs.get(job.id))?.progress.current, "ab");
        await runs.finish(runner("r1"), job.id, { status: "failed", error: "it\u0000broke" });
        assert.equal((await env.t.services.store.jobs.get(job.id))?.error, "itbroke");
    });

    test("a report that isn't shaped like OCR's ends the job, saying so, instead of leaving it running", async () => {
        const runs = env.t.services.runs;
        for (const report of [
            { comments: [null] },
            { comments: [1, 2] },
            { comments: [{ path: 5, content: "x" }] },
            { comments: [{ path: "a.ts", content: "x", severity: { toString: 1 } }] },
            { comments: [], warnings: [null, 7, { type: "review_round_failed", file: { a: 1 }, message: ["x"] }] },
            { comments: [], summary: { total_tokens: 1e308 } },
            { comments: "not a list" },
        ]) {
            const job = await runs.enqueue(ADMIN, project, specForBranch("full", "odd", null));
            assert.ok(await runs.claim(runner("r1")));
            const res = await fetch(`${env.url}/internal/runner/jobs/${job.id}/finish`, {
                method: "POST",
                headers: { authorization: `Bearer ${env.secret}`, "content-type": "application/json" },
                body: JSON.stringify({ runner: runner("r1"), status: "done", report }),
            });
            assert.equal(res.status, 200, `${JSON.stringify(report)}: ${await res.text()}`);
            const after = await env.t.services.store.jobs.get(job.id);
            assert.notEqual(after?.status, "running", JSON.stringify(report));
            assert.equal(after?.credentials, null);
            assert.equal(after?.leaseExpiresAt, null);
        }
    });
});

describe("the runner API", () => {
    let env: ReviewEnv;
    before(async () => {
        env = await reviewEnv();
    });
    after(() => env.close());

    const call = (path: string, init: { auth?: string; cookie?: string; body?: string } = {}) =>
        fetch(`${env.url}${path}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(init.auth ? { authorization: init.auth } : {}),
                ...(init.cookie ? { cookie: init.cookie, origin: "http://triagent.test" } : {}),
            },
            body: init.body ?? JSON.stringify({ runner: runner("r1") }),
        });

    test("only the runner secret gets in, checked before the body is read", async () => {
        assert.equal((await call("/internal/runner/claim", { auth: `Bearer ${env.secret}` })).status, 200);
        assert.equal((await call("/internal/runner/claim")).status, 401);
        assert.equal((await call("/internal/runner/claim", { auth: `Bearer ${env.secret}x` })).status, 401);
        // Not even a body that isn't JSON is looked at without it.
        assert.equal((await call("/internal/runner/claim", { auth: "Bearer wrong", body: "{not json" })).status, 401);
        assert.equal((await call("/internal/runner/claim", { auth: `Bearer ${env.secret}`, body: "{not json" })).status, 400);
        // A session or an API token is no use.
        const admin = await env.t.signIn("admin", ADMIN_PASSWORD);
        assert.equal((await call("/internal/runner/claim", { cookie: admin.cookie })).status, 401);
        const ws = await env.t.request("/api/v1/w/admin/settings/tokens", {
            method: "POST",
            session: admin,
            body: { name: "t", scope: "manage" },
        });
        assert.equal((await call("/internal/runner/claim", { auth: `Bearer ${ws.body.token}` })).status, 401);
    });

    test("without a runner secret configured, there's no runner API", async () => {
        const plain = await (await import("./helpers.ts")).testApp();
        const res = await plain.app.request("http://triagent.test/internal/runner/claim", {
            method: "POST",
            headers: { authorization: "Bearer anything-at-all-anything-at-all-123", "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(res.status, 404);
    });
});

test("a run's token budget: the project's, or what's left of an instance allowance if that's less", () => {
    assert.equal(budget(null, null), null);
    assert.equal(budget(50_000, null), 50_000);
    assert.equal(budget(null, 20_000), 20_000);
    assert.equal(budget(50_000, 20_000), 20_000);
    assert.equal(budget(50_000, 10_000), 10_000);
    assert.equal(budget(null, 10_000), 10_000);
});
