// Instance allowances while reviews run: reviews running at the same time share what's left of the
// allowance (each is given a budget out of it, and those budgets are set aside until they finish), and
// every review paid with the instance key counts, including those that end without a report: the
// tokens OCR said it used, or, when nothing was said at all, the budget the review was given.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Actor } from "../src/services/core.ts";
import type { RunModel } from "../src/services/models.ts";
import { type RunnerHello, specForBranch } from "../src/services/runs.ts";
import type { Project, ReviewRecord, Workspace } from "../src/store/types.ts";
import { PAT, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const ADMIN: Actor = { name: "admin", userId: null, via: "web" };
const runner = (id: string): RunnerHello => ({ id: `runner-${id}-0000`, name: id, version: "1", slots: 1 });
const instanceKey = () => `sk-or-${randomBytes(16).toString("hex")}`;

describe("instance allowances and running reviews", () => {
    let env: ReviewEnv;
    let n = 0;
    before(async () => {
        env = await reviewEnv({ env: { REVIEW_CONCURRENCY: "10", REVIEW_CONCURRENCY_PER_WORKSPACE: "10" } });
        await env.t.services.allowances.setKey(ADMIN, "openrouter", instanceKey());
    });
    after(() => env.close());

    /** A workspace paying with the instance key: an allowance, no key of its own, and a project budget. */
    async function granted(monthlyTokens: number, projectBudget: number | null): Promise<{ w: Workspace; p: Project }> {
        const slug = `ws-${++n}`;
        await patProject(env, slug, { key: false, token: PAT(n) });
        const w = (await env.t.services.store.workspaces.bySlug(slug)) as Workspace;
        const p = (await env.t.services.store.projects.bySlug(w.id, "app")) as Project;
        await env.t.services.allowances.setGrant(ADMIN, w.id, monthlyTokens);
        await env.t.services.settings.setAutomation(ADMIN, p, { maxTokensBudget: projectBudget });
        return { w, p };
    }

    const history = async (w: Workspace): Promise<ReviewRecord[]> => env.t.services.history.list({ workspaceId: w.id });

    test("reviews running at once share what's left of the allowance; none starts with less than 10,000 tokens", async () => {
        const { w, p } = await granted(100_000, 30_000);
        const runs = env.t.services.runs;
        for (let i = 0; i < 5; i++) await runs.enqueue(ADMIN, p, specForBranch("full", `b${i}`, null));
        const claimed = [];
        for (let i = 0; i < 5; i++) claimed.push(await runs.claim(runner(`c${i}`)));
        assert.deepEqual(
            claimed.map((j) => j?.maxTokensBudget ?? null),
            [30_000, 30_000, 30_000, 10_000, null],
        );
        const waiting = await env.t.services.models.forRun(w);
        assert.equal(waiting.ready, false);
        assert.match(
            (waiting as { reason: string }).reason,
            /^Less than 10,000 tokens of this month's allowance are left once the reviews running now are counted\. The next review starts when one finishes/,
        );

        // The 10,000-token review uses 2,000: 8,000 more is free, still too little for another.
        const [j1, j2, j3, j4] = claimed;
        assert.ok(j1 && j2 && j3 && j4);
        await runs.finish(runner("c3"), j4.id, { status: "done", report: { comments: [], summary: { total_tokens: 2_000 } } });
        assert.equal(await runs.claim(runner("c3")), null);
        // A 30,000-token review uses 1,000: 100,000 - 3,000 used - 60,000 set aside leaves 37,000, so the next starts.
        await runs.finish(runner("c0"), j1.id, { status: "done", report: { comments: [], summary: { total_tokens: 1_000 } } });
        const next = await runs.claim(runner("c0"));
        assert.equal(next?.maxTokensBudget, 30_000);
        // That leaves 7,000: the rest wait.
        assert.equal((await env.t.services.models.forRun(w)).ready, false);
        for (const [r, j] of [
            ["c1", j2],
            ["c2", j3],
            ["c0", next],
        ] as const)
            if (j) await runs.finish(runner(r), j.id, { status: "done", report: { comments: [], summary: { total_tokens: 0 } } });
    });

    test("a review is never given a budget of less than 10,000 tokens: the allowance is used up instead", async () => {
        const { w, p } = await granted(100_000, null);
        const runs = env.t.services.runs;
        await runs.enqueue(ADMIN, p, specForBranch("full", "main", null));
        const job = await runs.claim(runner("u1"));
        assert.ok(job);
        await runs.finish(runner("u1"), job.id, { status: "done", report: { comments: [], summary: { total_tokens: 95_000 } } });
        await runs.enqueue(ADMIN, p, specForBranch("full", "main", null));
        assert.equal(await runs.claim(runner("u1")), null);
        const model = await env.t.services.models.forRun(w);
        assert.equal(model.ready, false);
        assert.match((model as { reason: string }).reason, /^Less than 10,000 tokens of this month's allowance are left \(5,000\)/);
        const list = (await env.t.request(`/api/v1/w/${w.slug}/runs`, { session: env.admin })).body;
        assert.match(list.queued[0].waiting, /Less than 10,000 tokens/);
    });

    test("reviews that end without a report still count: what OCR said it used, or else the whole budget", async () => {
        const { w, p } = await granted(10_000_000, 50_000);
        const runs = env.t.services.runs;
        const start = async (branch: string) => {
            await runs.enqueue(ADMIN, p, specForBranch("full", branch, null));
            const job = await runs.claim(runner("t1"));
            assert.ok(job);
            assert.equal(job.maxTokensBudget, 50_000);
            return job;
        };

        // Stopped at its time limit, having said how many tokens it used: those count.
        let job = await start("said");
        await runs.events(runner("t1"), job.id, { progress: { phase: "reviewing", tokens: 12_345 } });
        await runs.events(runner("t1"), job.id, { progress: { phase: "reviewing", tokens: 9_000 } });
        await runs.finish(runner("t1"), job.id, { status: "failed", error: "Stopped after 45 minutes." });
        let [record] = await history(w);
        assert.equal(record?.tokens?.total, 12_345);
        assert.equal(record?.details.estimatedTokens, undefined);

        // Finished, but its report says less than it said while running: the larger counts.
        job = await start("more");
        await runs.events(runner("t1"), job.id, { progress: { tokens: 4_000 } });
        await runs.finish(runner("t1"), job.id, {
            status: "done",
            report: { comments: [], summary: { total_tokens: 1_500, input_tokens: 1_200, output_tokens: 300 } },
        });
        [record] = await history(w);
        assert.deepEqual(record?.tokens, { input: 3_700, output: 300, cacheRead: 0, total: 4_000 });

        // Cancelled without a word: the budget it was given counts, marked as an estimate.
        job = await start("silent");
        await runs.finish(runner("t1"), job.id, { status: "cancelled" });
        [record] = await history(w);
        assert.equal(record?.status, "cancelled");
        assert.equal(record?.tokens?.total, 50_000);
        assert.equal(record?.details.estimatedTokens, true);

        // A runner that stopped responding: the same.
        job = await start("lost");
        const stored = await env.t.services.store.jobs.get(job.id);
        await env.t.services.store.jobs.put({
            ...(stored as NonNullable<typeof stored>),
            leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        });
        assert.equal(await runs.sweep(), 1);
        [record] = await history(w);
        assert.equal(record?.status, "failed");
        assert.equal(record?.tokens?.total, 50_000);
        assert.equal(record?.details.estimatedTokens, true);

        // A review that never got as far as OCR (the runner says so: none used) isn't charged.
        job = await start("never");
        await runs.events(runner("t1"), job.id, { progress: { phase: "fetching", tokens: 0 } });
        await runs.finish(runner("t1"), job.id, { status: "failed", error: "Couldn't fetch." });
        [record] = await history(w);
        assert.equal(record?.tokens?.total, 0);
        assert.equal(record?.details.estimatedTokens, undefined);

        const usage = await env.t.services.allowances.usage(w);
        assert.equal(usage.used, 12_345 + 4_000 + 50_000 + 50_000);
        const model = (await env.t.services.models.forRun(w)) as RunModel;
        assert.equal(model.allowance?.used, usage.used);

        // Analytics say which totals are estimates.
        const analytics = (await env.t.request(`/api/v1/w/${w.slug}/analytics?days=7`, { session: env.admin })).body;
        assert.equal(analytics.reviews.tokens.estimated, 2);
        assert.equal(analytics.reviews.tokens.estimatedTotal, 100_000);
        const silent = analytics.reviews.latest.find((r: { branch: string }) => r.branch === "silent");
        assert.equal(silent.tokensEstimated, true);
    });

    test("a review paid with the workspace's own key isn't charged an estimate", async () => {
        const slug = `own-${++n}`;
        await patProject(env, slug, { token: PAT(n) });
        const w = (await env.t.services.store.workspaces.bySlug(slug)) as Workspace;
        const p = (await env.t.services.store.projects.bySlug(w.id, "app")) as Project;
        await env.t.services.runs.enqueue(ADMIN, p, specForBranch("full", "main", null));
        const job = await env.t.services.runs.claim(runner("o1"));
        assert.ok(job);
        await env.t.services.runs.finish(runner("o1"), job.id, { status: "cancelled" });
        const [record] = await history(w);
        assert.equal(record?.tokens, null);
        assert.equal(record?.details.estimatedTokens, undefined);
    });
});
