// Deploys that don't interrupt anything: a runner that finishes what it has before it stops, a server
// that gives runners time to be heard from after it starts, a previous version's runner still understood,
// and the whole of it together: a review started before a deploy finishes after it.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { serve } from "@hono/node-server";
import { loadConfig as runnerConfig } from "../../runner/src/config.ts";
import { LEASE_SECONDS } from "../src/services/runs.ts";
import { PostgresStore } from "../src/store/postgres.ts";
import { sameDatabase, TEST_DATABASE_URL, testApp, testStore } from "./helpers.ts";
import { eventually, finished, patProject, type ReviewEnv, reviewEnv, setModel } from "./review-helpers.ts";

const start = async (env: ReviewEnv, ws: string, body: object) => {
    const r = await env.t.request(`/api/v1/w/${ws}/p/app/reviews`, { method: "POST", session: env.admin, body });
    assert.equal(r.status, 201, r.text);
    return r.body as { id: string };
};
const running = (env: ReviewEnv, id: string) =>
    eventually(async () => (await env.t.services.store.jobs.get(id))?.status === "running", `review ${id} to start`);
const runnersOf = async (env: ReviewEnv) =>
    (await env.t.request("/api/v1/instance/reviews", { session: env.admin })).body.runners as {
        name: string;
        slots: number;
        busy: number;
        draining: boolean;
    }[];

describe("a runner that's asked to stop", () => {
    let env: ReviewEnv;
    const ws = "acme";

    before(async () => {
        env = await reviewEnv({ env: { REVIEW_CONCURRENCY: "4", REVIEW_CONCURRENCY_PER_WORKSPACE: "4" } });
        await patProject(env, ws);
        await env.fake.gitRepo("acme/app", { "src/a.ts": "export const a = 1;\n" });
    });
    after(() => env.close());

    test("finishes the review it has, takes no more, and says so; a runner beside it takes what's queued", async () => {
        const old = env.runner();
        await setModel(env, ws, "fake/sleep-3");
        await env.fake.commit("acme/app", "slow", { "src/slow.ts": "x\n" }, "slow", "main");
        const first = await start(env, ws, { kind: "full", branch: "slow" });
        await running(env, first.id);

        let drained = false;
        const draining = old.drain().then(() => {
            drained = true;
        });
        // The server hears at the runner's next word, and counts it as having no room.
        const seen = await eventually(
            async () => (await runnersOf(env)).find((r) => r.draining),
            "the server to hear the runner is draining",
        );
        assert.deepEqual([seen.busy, seen.slots], [1, 1]);

        // Queued meanwhile: not for the one on its way out.
        await setModel(env, ws, "fake/model");
        await env.fake.commit("acme/app", "quick", { "src/quick.ts": "x\n" }, "quick", "main");
        const second = await start(env, ws, { kind: "full", branch: "quick" });
        const list = (await env.t.request(`/api/v1/w/${ws}/runs`, { session: env.admin })).body;
        assert.match(list.queued[0].waiting, /finishing its reviews before it stops/);
        assert.equal(drained, false);

        const fresh = env.runner();
        const quick = await finished(env, ws, second.id);
        assert.equal(quick.status, "done", quick.error);
        assert.equal((await env.t.services.store.jobs.get(second.id))?.runnerId, fresh.id);

        // The first carries on to its end, on the runner that started it, and only then is that runner done.
        const slow = await finished(env, ws, first.id);
        assert.equal(slow.status, "done", slow.error);
        assert.ok(slow.result.total >= 1);
        assert.equal((await env.t.services.store.jobs.get(first.id))?.runnerId, old.id);
        await draining;
        assert.equal(old.running, 0);
        await fresh.stop();
    });

    test("asked a second time, it stops the review now and reports it as stopped", async () => {
        const runner = env.runner();
        await setModel(env, ws, "fake/sleep-30");
        await env.fake.commit("acme/app", "long", { "src/long.ts": "x\n" }, "long", "main");
        const job = await start(env, ws, { kind: "full", branch: "long" });
        await running(env, job.id);
        const draining = runner.drain();
        await eventually(async () => (await runnersOf(env)).some((r) => r.draining), "the runner to be draining");
        await runner.stop();
        await draining;
        const run = await finished(env, ws, job.id);
        assert.equal(run.status, "cancelled");
        await setModel(env, ws, "fake/model");
    });

    test("RUNNER_STOP chooses what the first signal does", () => {
        const base = { TRIAGENT_SERVER_URL: "http://server:8080", TRIAGENT_RUNNER_SECRET: "s".repeat(40) };
        assert.equal(runnerConfig(base).stopMode, "drain");
        assert.equal(runnerConfig({ ...base, RUNNER_STOP: "cancel" }).stopMode, "cancel");
        assert.throws(() => runnerConfig({ ...base, RUNNER_STOP: "now" }), /RUNNER_STOP must be "drain" or "cancel"/);
    });
});

describe("a server that has just started", () => {
    test("gives a runner one lease period to be heard from before giving its review up", async () => {
        const env = await reviewEnv();
        try {
            await patProject(env, "acme");
            await env.fake.gitRepo("acme/app", { "src/a.ts": "x\n" });
            const { runs, store } = env.t.services;
            const job = await start(env, "acme", { kind: "full" });
            const hello = { id: "runner-abcdefgh", name: "r1", version: "0.1.0", slots: 1, capacity: 1 };
            assert.equal((await runs.claim(hello))?.id, job.id);
            // The server was away for longer than a lease: what it finds when it comes back.
            const held = await store.jobs.get(job.id);
            await store.jobs.put({ ...(held as NonNullable<typeof held>), leaseExpiresAt: new Date(Date.now() - 5000).toISOString() });

            runs.startupGraceMs = LEASE_SECONDS * 1000;
            assert.equal(await runs.sweep(), 0);
            assert.equal((await store.jobs.get(job.id))?.status, "running");
            // The runner gets through, and the review is its own again.
            await runs.heartbeat(hello, job.id);
            assert.ok(Date.parse((await store.jobs.get(job.id))?.leaseExpiresAt as string) > Date.now());

            // Once the grace is over, a runner that never came back loses its review as before.
            const again = await store.jobs.get(job.id);
            await store.jobs.put({ ...(again as NonNullable<typeof again>), leaseExpiresAt: new Date(Date.now() - 5000).toISOString() });
            runs.startupGraceMs = 0;
            assert.equal(await runs.sweep(), 1);
            assert.equal((await store.jobs.get(job.id))?.status, "failed");
        } finally {
            await env.close();
        }
    });
});

describe("the previous version's runner", () => {
    // What a runner from the release before this one sends, word for word: no `capacity`, no `draining`,
    // no log lines of its own, one model's report at the top of `finish`. Kept when the messages change, so an
    // old runner can always finish what it has against a new server.
    test("is still understood: claim, heartbeat, events and finish", async () => {
        const env = await reviewEnv();
        try {
            await patProject(env, "acme");
            await env.fake.gitRepo("acme/app", { "src/a.ts": "x\n" });
            const job = await start(env, "acme", { kind: "full" });
            const runner = { id: "runner-previous1", name: "desktop-1", version: "0.1.0", slots: 1 };
            const post = (path: string, body: object) =>
                env.t.request(`/internal/runner${path}`, {
                    method: "POST",
                    body: { runner, ...body },
                    headers: { authorization: `Bearer ${env.secret}` },
                });

            const claimed = await post("/claim", {});
            assert.equal(claimed.status, 200, claimed.text);
            assert.equal(claimed.body.job.id, job.id);
            // What it reads from the job hasn't moved.
            for (const key of ["id", "kind", "title", "leaseSeconds", "repository", "git", "model", "maxTokensBudget"])
                assert.ok(key in claimed.body.job, `the job still has ${key}`);

            const beat = await post(`/jobs/${job.id}/heartbeat`, {});
            assert.deepEqual([beat.status, beat.body.cancel], [200, false]);
            const events = await post(`/jobs/${job.id}/events`, {
                lines: [{ at: new Date().toISOString(), line: "[triagent] Fetching main…" }],
                progress: { phase: "reviewing", toolCalls: 3, tokens: 1200 },
            });
            assert.deepEqual([events.status, events.body.cancel], [200, false]);
            const done = await post(`/jobs/${job.id}/finish`, {
                status: "done",
                report: {
                    status: "completed",
                    comments: [{ path: "src/a.ts", content: "A problem.", severity: "high", category: "bug", start_line: 1, end_line: 1 }],
                },
                error: null,
                headSha: null,
                baseSha: null,
            });
            assert.deepEqual([done.status, done.body.ok], [200, true]);
            const run = await finished(env, "acme", job.id);
            assert.equal(run.status, "done", run.error);
            assert.equal(run.result.total, 1);
            // It's listed with the room it has, worked out from what it holds.
            const listed = (await runnersOf(env)).find((r) => r.name === "desktop-1");
            assert.deepEqual([listed?.slots, listed?.draining], [1, false]);
        } finally {
            await env.close();
        }
    });
});

/** Something in front of the servers that sends every request to whichever is live, as the proxy does in a deploy. */
async function front(target: () => string): Promise<{ url: string; server: Server }> {
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers))
                if (typeof v === "string" && k !== "host" && k !== "connection") headers.set(k, v);
            fetch(`${target()}${req.url}`, {
                method: req.method ?? "GET",
                headers,
                ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
            })
                .then(async (r) => {
                    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
                    res.end(Buffer.from(await r.arrayBuffer()));
                })
                .catch(() => {
                    // Between one server stopping and the next answering: a runner tries again.
                    res.writeHead(502).end();
                });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe("a deploy", () => {
    test("a review started before it finishes after it, on the old runner, and its findings land", async () => {
        // The same secrets key for both servers, as two versions of one instance have.
        const key = randomBytes(32).toString("base64");
        const shared = { TRIAGENT_SECRETS_KEY: key, REVIEW_CONCURRENCY: "4", REVIEW_CONCURRENCY_PER_WORKSPACE: "4" };
        const store = await testStore();
        const blue = await reviewEnv({ store, env: shared });
        let live = blue.url;
        const proxy = await front(() => live);
        blue.url = proxy.url;
        let greenServer: ReturnType<typeof serve> | null = null;
        try {
            await patProject(blue, "acme");
            await blue.fake.gitRepo("acme/app", { "src/a.ts": "export const a = 1;\n" });
            const oldRunner = blue.runner();
            await setModel(blue, "acme", "fake/sleep-4");
            await blue.fake.commit("acme/app", "slow", { "src/slow.ts": "x\n" }, "slow", "main");
            const before = await start(blue, "acme", { kind: "full", branch: "slow" });
            await running(blue, before.id);

            // The deploy. The new server starts beside the old one, on the same database…
            const green = await testApp(store instanceof PostgresStore ? sameDatabase(store) : store, {
                env: { ...shared, GITHUB_API_URL: blue.fake.apiUrl, GITHUB_URL: blue.fake.url, TRIAGENT_RUNNER_SECRET: blue.secret },
            });
            // …with the grace a real one has, so nothing it finds running is given up on sight.
            green.services.runs.startupGraceMs = LEASE_SECONDS * 1000;
            greenServer = serve({ fetch: green.app.fetch, port: 0, hostname: "127.0.0.1" });
            await new Promise<void>((resolve) => greenServer?.once("listening", () => resolve()));
            // …traffic moves to it, and the old one stops.
            live = `http://127.0.0.1:${(greenServer.address() as AddressInfo).port}`;
            blue.t.services.automation.stop();
            // The new runner starts beside the old one, which is told to finish up.
            const newRunner = blue.runner();
            const drained = oldRunner.drain();

            // A review asked for after the deploy goes to the new runner, through the new server.
            const session = await green.signIn("admin", "correct-horse-battery-staple");
            const patch = await green.request("/api/v1/w/acme/settings/review-model", {
                method: "PATCH",
                session,
                body: { model: "fake/model" },
            });
            assert.equal(patch.status, 200, patch.text);
            await blue.fake.commit("acme/app", "quick", { "src/quick.ts": "x\n" }, "quick", "main");
            const queued = await green.request("/api/v1/w/acme/p/app/reviews", {
                method: "POST",
                session,
                body: { kind: "full", branch: "quick" },
            });
            assert.equal(queued.status, 201, queued.text);
            const ended = (id: string) =>
                eventually(async () => {
                    const r = await green.request(`/api/v1/w/acme/runs/${id}`, { session });
                    return ["done", "partial", "failed", "cancelled"].includes(r.body.status) ? r.body : null;
                }, `run ${id} to finish`);
            const after = await ended(queued.body.id);
            assert.equal(after.status, "done", after.error);
            assert.equal((await green.services.store.jobs.get(queued.body.id))?.runnerId, newRunner.id);

            // The one from before the deploy finishes on the old runner, told to the new server, findings and all.
            const run = await ended(before.id);
            assert.equal(run.status, "done", run.error);
            assert.ok(run.result.total >= 1);
            assert.equal((await green.services.store.jobs.get(before.id))?.runnerId, oldRunner.id);
            const issues = await green.request("/api/v1/w/acme/p/app/issues?branch=slow", { session });
            assert.ok(issues.body.items.length >= 1);
            await drained;
            await green.services.runs.settled();
            green.services.automation.stop();
        } finally {
            await blue.close();
            await new Promise<void>((resolve) => (greenServer ? greenServer.close(() => resolve()) : resolve()));
            await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
        }
    });

    test("two servers on one database: only one of them polls GitHub", {
        skip: !TEST_DATABASE_URL && "needs Postgres (TRIAGENT_TEST_DATABASE_URL)",
    }, async () => {
        const store = (await testStore()) as PostgresStore;
        const a = await testApp(store);
        const b = await testApp(sameDatabase(store));
        const ticked: string[] = [];
        // Reaching past the type, to count the passes that do any work.
        for (const [name, t] of [
            ["a", a],
            ["b", b],
        ] as const)
            (t.services.automation as unknown as { tickProject(): Promise<void> }).tickProject = async () => void ticked.push(name);
        await a.request("/api/v1/workspaces", {
            method: "POST",
            session: await a.signIn("admin", "correct-horse-battery-staple"),
            body: { slug: "acme" },
        });
        await a.request("/api/v1/w/acme/projects", {
            method: "POST",
            session: await a.signIn("admin", "correct-horse-battery-staple"),
            body: { slug: "app", repoUrl: "https://github.com/acme/app" },
        });
        for (let i = 0; i < 3; i++) await Promise.all([a.services.automation.tick(), b.services.automation.tick()]);
        assert.ok(ticked.length > 0, "someone polls");
        assert.equal(new Set(ticked).size, 1, `only one of them does: ${ticked.join(",")}`);
        a.services.automation.stop();
        b.services.automation.stop();
    });
});
