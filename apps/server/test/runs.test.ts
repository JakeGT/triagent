// Reviews from start to finish: the server queues them, a runner (the real one, with a fake `ocr`)
// fetches the code from a fake GitHub and runs it, and the server uploads the report, records the run,
// and comments and sets a status on the pull request. Against the memory store, or Postgres when
// TRIAGENT_TEST_DATABASE_URL is set.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { COMMENT_MARKER } from "../src/services/github/service.ts";
import { eventually, finished, MODEL_KEY, patProject, type ReviewEnv, reviewEnv, setModel } from "./review-helpers.ts";

describe("reviews end to end (token mode)", () => {
    let env: ReviewEnv;
    const ws = "acme";
    let token: string;

    before(async () => {
        env = await reviewEnv();
        ({ token } = await patProject(env, ws));
        await env.fake.gitRepo("acme/app", {
            "src/a.ts": "export const a = 1;\n",
            "README.md": "# App\n",
            ".opencodereview/rule.json": JSON.stringify({ focus: "security" }),
        });
        env.runner();
    });
    after(() => env.close());

    const start = async (body: object) => {
        const r = await env.t.request(`/api/v1/w/${ws}/p/app/reviews`, { method: "POST", session: env.admin, body });
        assert.equal(r.status, 201, r.text);
        return r.body;
    };

    test("a pull request: reviewed, uploaded, recorded, commented on and given a status", async () => {
        const head = await env.fake.commit(
            "acme/app",
            "feature",
            { "src/b.ts": "export const b = 2;\n", "src/c.ts": "x\n" },
            "Add b and c",
            "main",
        );
        await env.fake.openPull("acme/app", { number: 7, headRef: "feature", title: "Add b and c" });
        const queued = await start({ kind: "pr", number: 7 });
        assert.equal(queued.status, "queued");
        assert.equal(queued.branch, "feature");
        const run = await finished(env, ws, queued.id);
        assert.equal(run.status, "done", run.error);
        assert.equal(run.headSha, head);
        assert.equal(run.result.total, 2);
        assert.equal(run.model.model, "fake/model");

        // The report is on the branch, as a review of the changes only.
        const branches = (await env.t.request(`/api/v1/w/${ws}/p/app/branches`, { session: env.admin })).body;
        const feature = branches.items.find((b: { name: string }) => b.name === "feature");
        assert.equal(feature.scope, "diff");
        assert.equal(feature.commit, head);
        assert.equal(feature.issues, 2);
        assert.equal(feature.uploadedBy, "Open Code Review");

        // One history record, with what analytics needs.
        const [record] = await env.t.services.history.list({
            workspaceId: (await env.t.services.store.workspaces.bySlug(ws))?.id as string,
        });
        assert.equal(record?.source, "run");
        assert.equal(record?.kind, "pr");
        assert.equal(record?.status, "done");
        assert.equal(record?.keySource, "workspace");
        assert.equal(record?.provider, "openrouter");
        assert.deepEqual(record?.tokens, { input: 1200, output: 300, cacheRead: 100, total: 1500 });
        assert.equal(record?.details.prNumber, 7);
        assert.equal(record?.details.commit, head);
        assert.equal(record?.details.ocrVersion, "1.12.12-fake");
        assert.equal(record?.details.findings?.total, 2);
        assert.deepEqual(record?.details.counts, { added: 2, carriedOver: 0, removed: 0, reopened: 0 });
        assert.equal(record?.details.addedIds?.high?.length, 2);
        assert.deepEqual(record?.details.toolCalls, { total: 2, failed: 0, byTool: { file_read: 2 }, failedByTool: {} });

        // GitHub: pending while queued and running, then success; one comment with the findings.
        const statuses = env.fake.repo("acme/app").statuses.filter((s) => s.sha === head);
        assert.ok(statuses.every((s) => s.context === "Triagent"));
        assert.deepEqual(
            statuses.map((s) => s.state),
            ["pending", "pending", "success"],
        );
        assert.match(statuses.at(-1)?.description ?? "", /^2 high$/);
        assert.match(statuses.at(-1)?.target_url ?? "", /\/w\/acme\/p\/app\/issues\?branch=feature$/);
        const comments = env.fake.repo("acme/app").comments.get(7) ?? [];
        assert.equal(comments.length, 1);
        assert.ok(comments[0]?.body.includes(COMMENT_MARKER));
        assert.match(comments[0]?.body ?? "", /2 findings in this pull request/);
        assert.match(comments[0]?.body ?? "", /\| 0 \| 2 \| 0 \| 0 \|/);
        assert.match(comments[0]?.body ?? "", /src\/b\.ts:1/);
        assert.match(comments[0]?.body ?? "", /Reviewed commit `[0-9a-f]{10}`/);
        assert.deepEqual(run.result.github ?? (await finished(env, ws, queued.id)).result.github, ["commit status: done", "comment: done"]);

        // Another review of a new commit updates the same comment.
        await env.fake.commit("acme/app", "feature", { "src/d.ts": "CRITICAL\n" }, "Add d");
        const again = await finished(env, ws, (await start({ kind: "pr", number: 7 })).id);
        assert.equal(again.status, "done");
        assert.equal((env.fake.repo("acme/app").comments.get(7) ?? []).length, 1);
        assert.match(env.fake.repo("acme/app").comments.get(7)?.[0]?.body ?? "", /3 findings/);
        // failOnCritical is on by default.
        const last = env.fake.repo("acme/app").statuses.at(-1);
        assert.equal(last?.state, "failure");
        assert.match(last?.description ?? "", /^1 critical: 1 critical, 2 high$/);
    });

    test("the log is redacted, OCR's environment is the allowlist, and credentials don't outlive the run", async () => {
        await env.fake.commit("acme/app", "logs", { "src/e.ts": "e\n" }, "e", "main");
        const run = await finished(env, ws, (await start({ kind: "changes", branch: "logs" })).id);
        assert.equal(run.status, "done", run.error);
        const lines: string[] = run.logLines.map((l: { line: string }) => l.line);
        const text = lines.join("\n");
        assert.ok(
            lines.some((l) => l === "[fake-ocr] key: [redacted]"),
            "the model key printed by OCR is redacted",
        );
        assert.ok(!text.includes(MODEL_KEY) && !text.includes(token));
        const envLine = lines.find((l) => l.startsWith("[fake-ocr] env: ")) as string;
        const keys = envLine.slice("[fake-ocr] env: ".length).split(",");
        for (const k of keys) assert.match(k, /^(PATH|HOME|TMPDIR|XDG_\w+|LANG|TZ|OCR_\w+|GIT_\w+|_|PWD|SHLVL)$/, `OCR got ${k}`);
        assert.ok(!keys.some((k) => /^OTEL_|TELEMETRY|^ANTHROPIC_|TRIAGENT|DATABASE/.test(k)));
        const job = await env.t.services.store.jobs.get(run.id);
        assert.equal(job?.credentials, null);
        assert.equal(job?.leaseExpiresAt, null);
        assert.ok(run.log.lines > 5);
        // The log can be read from a cursor.
        const later = await env.t.request(`/api/v1/w/${ws}/runs/${run.id}?after=${run.logLines[2].seq}`, { session: env.admin });
        assert.equal(later.body.logLines[0].seq, run.logLines[3].seq);
    });

    test("a pull request can't change the review rules to hide its own changes", async () => {
        await env.fake.commit(
            "acme/app",
            "hide",
            { ".opencodereview/rule.json": JSON.stringify({ exclude: ["src/"] }), "src/hidden.ts": "x\n" },
            "Hide src",
            "main",
        );
        await env.fake.openPull("acme/app", { number: 8, headRef: "hide" });
        const run = await finished(env, ws, (await start({ kind: "pr", number: 8 })).id);
        assert.equal(run.status, "done", run.error);
        const lines: string[] = run.logLines.map((l: { line: string }) => l.line);
        assert.ok(lines.includes('[fake-ocr] rules: {"focus":"security"}'), "OCR saw the base's rules");
        assert.ok(lines.some((l) => /Using main's review rules/.test(l)));
        assert.equal(run.result.total, 1, "src/hidden.ts was reviewed");
    });

    test("a partial review is labelled, saying which files", async () => {
        await setModel(env, ws, "fake/partial");
        try {
            await env.fake.commit("acme/app", "part", { "src/p1.ts": "1\n", "src/p2.ts": "2\n", "src/p3.ts": "3\n" }, "p", "main");
            await env.fake.openPull("acme/app", { number: 9, headRef: "part" });
            const run = await finished(env, ws, (await start({ kind: "pr", number: 9 })).id);
            assert.equal(run.status, "partial");
            assert.deepEqual(run.result.gaps.files, ["src/p2.ts", "src/p3.ts"]);
            assert.match(run.result.gaps.note, /Part of the review didn't finish: 1 file group \(src\/p2\.ts, src\/p3\.ts\)/);
            assert.match(env.fake.repo("acme/app").comments.get(9)?.[0]?.body ?? "", /Partial review/);
            assert.match(env.fake.repo("acme/app").statuses.at(-1)?.description ?? "", /\(partial review\)$/);
        } finally {
            await setModel(env, ws, "fake/model");
        }
    });

    test("a review that finds nothing (OCR writes no comments list) is done, with no findings", async () => {
        await setModel(env, ws, "fake/empty");
        try {
            await env.fake.commit("acme/app", "clean", { "src/clean.ts": "ok\n" }, "clean", "main");
            const run = await finished(env, ws, (await start({ kind: "changes", branch: "clean" })).id);
            assert.equal(run.status, "done", run.error);
            assert.equal(run.result.total, 0);
        } finally {
            await setModel(env, ws, "fake/model");
        }
    });

    test("a failed review: recorded as failed, with OCR's reason, and an error status", async () => {
        await setModel(env, ws, "fake/fail");
        try {
            await env.fake.commit("acme/app", "broken", { "src/x.ts": "x\n" }, "x", "main");
            await env.fake.openPull("acme/app", { number: 10, headRef: "broken" });
            const run = await finished(env, ws, (await start({ kind: "pr", number: 10 })).id);
            assert.equal(run.status, "failed");
            assert.match(
                run.error,
                /^Open Code Review failed \(exit 1\): review failed: all 1 file review\(s\) failed .*; the first model error was: Subtask error for group "src": LLM completion error: .*503 Service Unavailable$/,
            );
            assert.equal(env.fake.repo("acme/app").statuses.at(-1)?.state, "error");
            const wsId = (await env.t.services.store.workspaces.bySlug(ws))?.id as string;
            const records = await env.t.services.history.list({ workspaceId: wsId });
            assert.equal(records[0]?.status, "failed");
            // Tokens spent on a failed review still count.
            assert.equal(records[0]?.tokens?.total, 40);
        } finally {
            await setModel(env, ws, "fake/model");
        }
    });

    test("cancelling a running review stops OCR and everything it started", async () => {
        await setModel(env, ws, "fake/sleep-30-orphan");
        try {
            await env.fake.commit("acme/app", "slow", { "src/slow.ts": "x\n" }, "slow", "main");
            const queued = await start({ kind: "full", branch: "slow" });
            const running = await eventually(async () => {
                const r = await env.t.request(`/api/v1/w/${ws}/runs/${queued.id}`, { session: env.admin });
                return r.body.status === "running" && r.body.progress.toolCalls > 2 ? r.body : null;
            }, "the review to be under way");
            assert.ok(running.progress.phase);
            const orphan = Number(
                running.logLines.map((l: { line: string }) => /orphan: (\d+)/.exec(l.line)?.[1]).find(Boolean) ??
                    (await eventually(async () => {
                        const r = await env.t.request(`/api/v1/w/${ws}/runs/${queued.id}`, { session: env.admin });
                        return r.body.logLines.map((l: { line: string }) => /orphan: (\d+)/.exec(l.line)?.[1]).find(Boolean);
                    }, "the orphan's pid")),
            );
            const t0 = Date.now();
            const c = await env.t.request(`/api/v1/w/${ws}/runs/${queued.id}/cancel`, { method: "POST", session: env.admin, body: {} });
            assert.equal(c.status, 200, c.text);
            const run = await finished(env, ws, queued.id);
            assert.equal(run.status, "cancelled");
            assert.match(run.error, /Cancelled by admin/);
            assert.ok(Date.now() - t0 < 10_000);
            await eventually(
                async () => !existsSync(`/proc/${orphan}`) || readFileSync(`/proc/${orphan}/stat`, "utf8").includes(") Z "),
                "the orphan to be stopped",
                8000,
            );
        } finally {
            await setModel(env, ws, "fake/model");
        }
    });
});
