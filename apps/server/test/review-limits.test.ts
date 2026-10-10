// How many reviews run at once, set in the app: the instance's two limits and a workspace's own, read
// live by the queue; what runners say they can take; and claims that race for the last place. Against
// Postgres (TRIAGENT_TEST_DATABASE_URL) the racing claims really overlap; in memory they queue.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Actor } from "../src/services/core.ts";
import { createServices } from "../src/services/index.ts";
import { type RunnerHello, specForBranch } from "../src/services/runs.ts";
import type { Project, Store } from "../src/store/types.ts";
import { postgresStore, type Session, TEST_DATABASE_URL } from "./helpers.ts";
import { PAT, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const ADMIN: Actor = { name: "admin", userId: null, via: "web" };
/** A runner as one that says how many it works on at once (`capacity`), or as an older one that doesn't. */
const runner = (id: string, slots = 1, capacity?: number): RunnerHello => ({
    id: `runner-${id}-0000`,
    name: id,
    version: "1",
    slots,
    ...(capacity === undefined ? {} : { capacity }),
});

async function projectOf(env: ReviewEnv, ws: string): Promise<Project> {
    const w = await env.t.services.store.workspaces.bySlug(ws);
    return (await env.t.services.store.projects.bySlug(w?.id as string, "app")) as Project;
}

const workspaceId = async (env: ReviewEnv, slug: string) => (await env.t.services.store.workspaces.bySlug(slug))?.id as string;

/** Queue `n` full scans in the workspace, each of a branch of its own. */
async function queue(env: ReviewEnv, ws: string, n: number, tag: string) {
    const project = await projectOf(env, ws);
    const jobs = [];
    for (let i = 0; i < n; i++) jobs.push(await env.t.services.runs.enqueue(ADMIN, project, specForBranch("full", `${tag}-${i}`, null)));
    return jobs;
}

/** End every running review, and cancel what's queued, so the next test starts with nothing going. */
async function clear(env: ReviewEnv) {
    const store = env.t.services.store;
    for (const j of await store.jobs.active())
        await store.jobs.put({ ...j, status: "cancelled", finishedAt: new Date().toISOString(), leaseExpiresAt: null });
}

const running = async (env: ReviewEnv, ws?: string) => {
    const id = ws ? await workspaceId(env, ws) : null;
    return (await env.t.services.store.jobs.active()).filter((j) => j.status === "running" && (!id || j.workspaceId === id)).length;
};

const setLimits = (env: ReviewEnv, instance: unknown, perWorkspace: unknown, session: Session = env.admin) =>
    env.t.request("/api/v1/instance/reviews", { method: "PUT", session, body: { instance, perWorkspace } });

const setOwn = async (env: ReviewEnv, ws: string, limit: unknown) =>
    env.t.request(`/api/v1/instance/workspaces/${await workspaceId(env, ws)}/review-limit`, {
        method: limit === null ? "DELETE" : "PUT",
        session: env.admin,
        ...(limit === null ? {} : { body: { limit } }),
    });

describe("limits set in the app", () => {
    let env: ReviewEnv;
    before(async () => {
        env = await reviewEnv({ env: { REVIEW_CONCURRENCY: "3", REVIEW_CONCURRENCY_PER_WORKSPACE: "2" } });
        await patProject(env, "alpha", { token: PAT(1) });
        await patProject(env, "beta", { token: PAT(2) });
    });
    after(() => env.close());

    test("until limits are saved the environment's apply, and the page says they're the defaults", async () => {
        const view = await env.t.request("/api/v1/instance/reviews", { session: env.admin });
        assert.equal(view.status, 200, view.text);
        assert.deepEqual(view.body.limits, { instance: 3, perWorkspace: 2 });
        assert.deepEqual(view.body.defaults, { instance: 3, perWorkspace: 2 });
        assert.equal(view.body.saved, null);
        assert.deepEqual(view.body.runners, []);
        assert.deepEqual([view.body.running, view.body.queued], [0, 0]);
        await queue(env, "alpha", 3, "env");
        for (let i = 0; i < 2; i++) assert.ok(await env.t.services.runs.claim(runner("r1", 5)));
        assert.equal(await env.t.services.runs.claim(runner("r1", 5)), null, "two at once in one workspace");
        const list = (await env.t.request("/api/v1/w/alpha/runs", { session: env.admin })).body;
        assert.deepEqual(list.concurrency, { instance: 3, workspace: 2 });
        assert.match(list.queued[0].waiting, /one of this workspace's running reviews to finish \(it runs 2 at once\)/);
        await clear(env);
    });

    test("saved limits apply to the very next claim, with no restart, and to another server process", async () => {
        const saved = await setLimits(env, 2, 1);
        assert.equal(saved.status, 200, saved.text);
        assert.deepEqual(saved.body.limits, { instance: 2, perWorkspace: 1 });
        assert.deepEqual(saved.body.defaults, { instance: 3, perWorkspace: 2 }, "the environment's are still shown as the defaults");
        assert.equal(saved.body.saved.by, "admin");
        await queue(env, "alpha", 2, "live-a");
        await queue(env, "beta", 2, "live-b");
        const runs = env.t.services.runs;
        assert.ok(await runs.claim(runner("r1", 5)));
        assert.ok(await runs.claim(runner("r1", 5)));
        assert.equal(await runs.claim(runner("r1", 5)), null);
        assert.deepEqual([await running(env, "alpha"), await running(env, "beta")], [1, 1]);
        // Raised: the next claim sees it.
        assert.equal((await setLimits(env, 4, 2)).status, 200);
        assert.ok(await runs.claim(runner("r1", 5)));
        // A second server on the same store (its own configuration says 3 and 2) reads the saved limits too.
        const other = createServices(env.t.services.config, env.t.services.store);
        assert.ok(await other.runs.claim(runner("r2", 5)));
        assert.equal(await other.runs.claim(runner("r2", 5)), null);
        assert.equal(await running(env), 4);
        const list = (await env.t.request("/api/v1/w/alpha/runs", { session: env.admin })).body;
        assert.deepEqual(list.concurrency, { instance: 4, workspace: 2 });
        await clear(env);
    });

    test("lowering a limit below what's running stops nothing: no more start until enough have finished", async () => {
        await setLimits(env, 4, 4);
        const jobs = await queue(env, "alpha", 5, "lower");
        const runs = env.t.services.runs;
        for (let i = 0; i < 3; i++) assert.ok(await runs.claim(runner("r1", 5)));
        assert.equal((await setLimits(env, 2, 2)).status, 200);
        assert.equal(await running(env), 3, "the three running carry on");
        for (const j of jobs.slice(0, 3)) assert.equal((await runs.heartbeat(runner("r1", 5), j.id)).cancel, false);
        assert.equal(await runs.claim(runner("r1", 5)), null);
        // One finishes: still two running, which is the limit.
        await runs.finish(runner("r1", 5), jobs[0]?.id as string, { status: "failed", error: "test" });
        assert.equal(await runs.claim(runner("r1", 5)), null);
        const list = (await env.t.request("/api/v1/w/alpha/runs", { session: env.admin })).body;
        assert.equal(list.counts.running, 2);
        assert.match(list.queued[0].waiting, /this workspace's running reviews to finish/);
        // Another finishes: one place is free.
        await runs.finish(runner("r1", 5), jobs[1]?.id as string, { status: "failed", error: "test" });
        assert.equal((await runs.claim(runner("r1", 5)))?.id, jobs[3]?.id);
        assert.equal(await runs.claim(runner("r1", 5)), null);
        await clear(env);
    });

    test("a workspace's own limit can be lower or higher than the others', but never lets the instance's be passed", async () => {
        await setLimits(env, 3, 1);
        const own = await setOwn(env, "alpha", 5);
        assert.equal(own.status, 200, own.text);
        assert.deepEqual(own.body, { workspaceId: await workspaceId(env, "alpha"), reviewLimit: 5 });
        await queue(env, "alpha", 5, "own-a");
        await queue(env, "beta", 2, "own-b");
        const runs = env.t.services.runs;
        const started: string[] = [];
        for (let i = 0; i < 6; i++) {
            const job = await runs.claim(runner("r1", 9));
            if (job) started.push(job.title);
        }
        // Alpha may run five, but the instance runs three, and beta still gets its turn (one at a time).
        assert.equal(started.length, 3);
        assert.deepEqual([await running(env, "alpha"), await running(env, "beta")], [2, 1]);
        // What each workspace is told is its own limit, capped by the instance's, and nothing of the other's.
        const alpha = (await env.t.request("/api/v1/w/alpha/runs", { session: env.admin })).body;
        const beta = (await env.t.request("/api/v1/w/beta/runs", { session: env.admin })).body;
        assert.deepEqual(alpha.concurrency, { instance: 3, workspace: 3 });
        assert.deepEqual(beta.concurrency, { instance: 3, workspace: 1 });
        assert.match(alpha.queued[0].waiting, /the instance is running as many reviews as it allows/);
        assert.match(beta.queued[0].waiting, /this workspace's running review to finish/);
        await clear(env);

        // Lower than the others': alpha one at a time while beta runs two.
        await setLimits(env, 10, 2);
        await setOwn(env, "alpha", 1);
        await queue(env, "alpha", 3, "low-a");
        await queue(env, "beta", 3, "low-b");
        for (let i = 0; i < 6; i++) await runs.claim(runner("r1", 9));
        assert.deepEqual([await running(env, "alpha"), await running(env, "beta")], [1, 2]);
        await clear(env);

        // Taken away: the one for every workspace applies again.
        const removed = await setOwn(env, "alpha", null);
        assert.equal(removed.status, 200, removed.text);
        assert.equal(removed.body.reviewLimit, null);
        await queue(env, "alpha", 3, "back-a");
        for (let i = 0; i < 3; i++) await runs.claim(runner("r1", 9));
        assert.equal(await running(env, "alpha"), 2);
        await clear(env);
    });

    test("the workspaces list says which have a limit of their own; saving the instance's limits keeps them", async () => {
        await setOwn(env, "beta", 7);
        await setLimits(env, 6, 3);
        const list = await env.t.request("/api/v1/instance/workspaces", { session: env.admin });
        assert.deepEqual(list.body.reviewLimits, { instance: 6, perWorkspace: 3 });
        const row = (slug: string) => list.body.items.find((x: { slug: string }) => x.slug === slug);
        assert.equal(row("beta").reviewLimit, 7);
        assert.equal(row("alpha").reviewLimit, null);
        await setOwn(env, "beta", null);
    });

    test("limits are whole numbers from 1 to 100, refused in words otherwise, and nothing is saved", async () => {
        await setLimits(env, 6, 3);
        for (const [instance, perWorkspace] of [
            [0, 1],
            [101, 1],
            [1.5, 1],
            [-1, 1],
            [1, 0],
            [1, 101],
            [2, 2.5],
            ["4", 1],
            [null, 1],
            [3, undefined],
        ]) {
            const res = await setLimits(env, instance, perWorkspace);
            assert.equal(res.status, 400, `${JSON.stringify([instance, perWorkspace])}: ${res.text}`);
        }
        assert.equal(
            (await setLimits(env, 0, 1)).body.error,
            "The number of reviews at once on this instance must be a whole number from 1 to 100.",
        );
        assert.equal(
            (await setLimits(env, 1, 101)).body.error,
            "The number of reviews at once in one workspace must be a whole number from 1 to 100.",
        );
        for (const bad of [0, 101, 2.5, "3"]) assert.equal((await setOwn(env, "alpha", bad)).status, 400, String(bad));
        assert.equal(
            (await setOwn(env, "alpha", 0)).body.error,
            "A workspace's number of reviews at once must be a whole number from 1 to 100.",
        );
        assert.equal(
            (
                await env.t.request("/api/v1/instance/workspaces/nope/review-limit", {
                    method: "PUT",
                    session: env.admin,
                    body: { limit: 2 },
                })
            ).status,
            404,
        );
        const view = (await env.t.request("/api/v1/instance/reviews", { session: env.admin })).body;
        assert.deepEqual(view.limits, { instance: 6, perWorkspace: 3 });
        // The edges are fine, and one workspace may be allowed more than the instance: the instance's limit still caps it.
        assert.equal((await setLimits(env, 1, 100)).status, 200);
        assert.equal((await setLimits(env, 100, 1)).status, 200);
        const list = (await env.t.request("/api/v1/w/alpha/runs", { session: env.admin })).body;
        assert.deepEqual(list.concurrency, { instance: 100, workspace: 1 });
    });

    test("every change is audited, for the instance and for the workspace it's about; saving the same again isn't", async () => {
        const store = env.t.services.store;
        await setLimits(env, 8, 4);
        const count = async () => (await store.audit.list({ workspaceId: null }, { limit: 200 })).length;
        const before = await count();
        await setLimits(env, 8, 4);
        assert.equal(await count(), before, "the same numbers again aren't a change");
        await setLimits(env, 9, 4);
        const instanceAudit = await store.audit.list({ workspaceId: null }, { limit: 200 });
        const latest = instanceAudit.find((a) => a.target === "instance:review-limits");
        assert.deepEqual(latest?.changes, { instance: { from: 8, to: 9 } });
        assert.equal(latest?.actor, "admin");
        assert.equal(latest?.kind, "settings");
        const alphas = async () =>
            (await store.audit.list({ workspaceId: await workspaceId(env, "alpha") }, { limit: 200 })).filter(
                (a) => a.target === "review-limit",
            );
        const betas = async () =>
            (await store.audit.list({ workspaceId: await workspaceId(env, "beta") }, { limit: 200 })).filter(
                (a) => a.target === "review-limit",
            ).length;
        const betaBefore = await betas();
        const ownBefore = (await alphas()).length;
        await setOwn(env, "alpha", 3);
        await setOwn(env, "alpha", 3);
        await setOwn(env, "alpha", null);
        // Newest first: set to three (once: the same again isn't a change), then taken away.
        const about = (await store.audit.list({ workspaceId: null }, { limit: 200 })).filter(
            (a) => a.target === "workspace:alpha:review-limit",
        );
        assert.deepEqual(
            about.slice(0, 2).map((a) => a.changes),
            [{ reviewLimit: { from: 3, to: null } }, { reviewLimit: { from: null, to: 3 } }],
        );
        assert.equal((await alphas()).length, ownBefore + 2);
        // Beta's log says nothing of alpha's limit.
        assert.equal(await betas(), betaBefore);
    });

    test("only instance admins see or set limits: members, workspace admins and API tokens are refused", async () => {
        await env.t.request("/api/v1/instance/users", {
            method: "POST",
            session: env.admin,
            body: { username: "mia", password: "member-password-one" },
        });
        let mia = await env.t.signIn("mia", "member-password-one");
        await env.t.request("/api/v1/me/password", {
            method: "POST",
            session: mia,
            body: { current: "member-password-one", password: "member-password-two" },
        });
        mia = await env.t.signIn("mia", "member-password-two");
        // An admin of alpha, and nothing in beta.
        await env.t.request("/api/v1/w/alpha/settings/members", {
            method: "POST",
            session: env.admin,
            body: { username: "mia", role: "admin" },
        });
        const alphaId = await workspaceId(env, "alpha");
        const token = (
            await env.t.request("/api/v1/w/alpha/settings/tokens", {
                method: "POST",
                session: env.admin,
                body: { name: "manager", scope: "manage" },
            })
        ).body.token as string;
        assert.ok(token);
        await setLimits(env, 5, 2);
        await setOwn(env, "beta", 9);
        for (const who of [{ session: mia }, { token }]) {
            for (const [method, path, body] of [
                ["GET", "/api/v1/instance/reviews", undefined],
                ["PUT", "/api/v1/instance/reviews", { instance: 50, perWorkspace: 50 }],
                ["GET", "/api/v1/instance/workspaces", undefined],
                ["PUT", `/api/v1/instance/workspaces/${alphaId}/review-limit`, { limit: 50 }],
                ["DELETE", `/api/v1/instance/workspaces/${alphaId}/review-limit`, undefined],
            ] as const) {
                const res = await env.t.request(path, { method, ...who, ...(body ? { body } : {}) });
                assert.ok([401, 403, 404].includes(res.status), `${method} ${path}: ${res.status} ${res.text}`);
                assert.ok(!res.text.includes("perWorkspace") && !res.text.includes("beta"), res.text);
            }
        }
        assert.deepEqual((await env.t.request("/api/v1/instance/reviews", { session: env.admin })).body.limits, {
            instance: 5,
            perWorkspace: 2,
        });
        // What a member is told is their own workspace's limit: nothing of beta's own (9), nor the runners' names.
        const theirs = await env.t.request("/api/v1/w/alpha/runs", { session: mia });
        assert.equal(theirs.status, 200);
        assert.deepEqual(theirs.body.concurrency, { instance: 5, workspace: 2 });
        assert.deepEqual(theirs.body.runners, []);
        assert.ok(!theirs.text.includes("beta") && !theirs.text.includes('"workspaces"'));
        assert.equal((await env.t.request("/api/v1/w/beta/runs", { session: mia })).status, 404);
        await setOwn(env, "beta", null);
    });

    test("a deleted workspace's own limit goes the next time one is saved", async () => {
        await patProject(env, "gone", { token: PAT(3) });
        const goneId = await workspaceId(env, "gone");
        await setOwn(env, "gone", 4);
        await env.t.services.store.workspaces.delete(goneId);
        assert.equal((await env.t.services.reviewLimits.read()).workspaces[goneId], 4);
        await setOwn(env, "alpha", 2);
        assert.deepEqual(Object.keys((await env.t.services.reviewLimits.read()).workspaces), [await workspaceId(env, "alpha")]);
        await setOwn(env, "alpha", null);
    });

    test("a setting that isn't limits is read as none: the environment's apply", async () => {
        const store = env.t.services.store;
        const kept = await store.instanceSettings.get("review-limits");
        await store.instanceSettings.put("review-limits", { instance: 0, perWorkspace: "9", workspaces: { x: 1000, y: 2 }, saved: 3 });
        const limits = await env.t.services.reviewLimits.read();
        assert.deepEqual(limits, { instance: 3, perWorkspace: 2, workspaces: { y: 2 }, saved: null });
        await store.instanceSettings.put("review-limits", kept);
    });
});

describe("what runners can take", () => {
    let env: ReviewEnv;
    before(async () => {
        env = await reviewEnv({ env: { REVIEW_CONCURRENCY: "10", REVIEW_CONCURRENCY_PER_WORKSPACE: "10" } });
        await patProject(env, "alpha", { token: PAT(1) });
    });
    after(() => env.close());

    test("a runner is never handed more than it works on at once, whatever room it says it has", async () => {
        const runs = env.t.services.runs;
        await queue(env, "alpha", 6, "cap");
        // No room: nothing.
        assert.equal(await runs.claim(runner("two", 0, 2)), null);
        assert.ok(await runs.claim(runner("two", 2, 2)));
        assert.ok(await runs.claim(runner("two", 1, 2)));
        // It holds two, which is all it works on: saying it has room changes nothing.
        assert.equal(await runs.claim(runner("two", 1, 2)), null);
        assert.equal(await runs.claim(runner("two", 2, 2)), null);
        // Another runner still gets work, up to what it works on.
        assert.ok(await runs.claim(runner("one", 1, 1)));
        assert.equal(await runs.claim(runner("one", 1, 1)), null);
        assert.equal(await running(env), 3);
        // An older runner only says how many more it can take: that's believed, as it always was.
        assert.ok(await runs.claim(runner("old", 1)));
        assert.equal(await runs.claim(runner("old", 0)), null);
        await clear(env);
    });

    test("the limits can pass what the runners can do: reviews then wait for a runner slot, and say so", async () => {
        const runs = env.t.services.runs;
        const store = env.t.services.store;
        await queue(env, "alpha", 3, "slots");
        const a = runner("slot-a", 1, 1);
        assert.ok(await runs.claim(a));
        assert.equal(await runs.claim({ ...a, slots: 0 }), null);
        // Runners seen in earlier tests have gone quiet; this one is the only one connected, and it's full.
        for (const r of await store.runners.list())
            if (r.id !== a.id) await store.runners.seen({ ...r, lastSeenAt: new Date(Date.now() - 600_000).toISOString() });
        const list = (await env.t.request("/api/v1/w/alpha/runs", { session: env.admin })).body;
        assert.deepEqual(list.concurrency, { instance: 10, workspace: 10 });
        assert.equal(list.counts.running, 1);
        assert.equal(list.queued[0].waiting, "Waiting for a free runner slot: every connected runner is busy.");
        assert.deepEqual(
            list.runners.map((r: { name: string; slots: number; busy: number }) => [r.name, r.slots, r.busy]),
            [["slot-a", 1, 1]],
        );
        const view = (await env.t.request("/api/v1/instance/reviews", { session: env.admin })).body;
        assert.deepEqual(
            view.runners.map((r: { name: string; version: string; slots: number; busy: number }) => [r.name, r.version, r.slots, r.busy]),
            [["slot-a", "1", 1, 1]],
        );
        assert.ok(view.runners[0].lastSeenAt);
        assert.deepEqual([view.running, view.queued], [1, 2]);
        await clear(env);
    });

    test("an older runner's slots are worked out from what it has room for and what it holds", async () => {
        const runs = env.t.services.runs;
        const [job] = await queue(env, "alpha", 1, "old");
        // Its first word is a claim with room for three; a fresh server process hears it holding one and with room for two.
        assert.equal((await runs.claim(runner("older", 3)))?.id, job?.id);
        const other = createServices(env.t.services.config, env.t.services.store);
        await other.runs.heartbeat(runner("older", 2), job?.id as string);
        const view = await other.runs.runners();
        assert.deepEqual(
            view.runners.filter((r) => r.name === "older").map((r) => [r.slots, r.busy]),
            [[3, 1]],
        );
        await clear(env);
    });

    test("over HTTP a runner may say its capacity or not, and nonsense is refused", async () => {
        const post = (hello: Record<string, unknown>) =>
            env.t.request("/internal/runner/claim", {
                method: "POST",
                headers: { authorization: `Bearer ${env.secret}` },
                body: { runner: { id: "runner-http-0000", name: "http", version: "1", ...hello } },
            });
        assert.equal((await post({ slots: 1 })).status, 200);
        assert.equal((await post({ slots: 1, capacity: 2 })).status, 200);
        assert.equal((await post({ slots: 1, capacity: null })).status, 200);
        // Something a newer runner might add is ignored, not refused.
        assert.equal((await post({ slots: 1, capacity: 2, somethingNew: true })).status, 200);
        assert.equal((await post({ slots: 1, capacity: 0 })).status, 400);
        assert.equal((await post({ slots: 1, capacity: 1000 })).status, 400);
        await queue(env, "alpha", 2, "http");
        assert.ok((await post({ slots: 1, capacity: 1 })).body.job);
        assert.equal((await post({ slots: 1, capacity: 1 })).body.job, null);
        await clear(env);
    });
});

describe("claims racing for the last place", () => {
    const N = 6;
    let env: ReviewEnv;
    let store: Store;
    before(async () => {
        // A pool as large as the number of claims at once, so with Postgres they really do overlap.
        env = await reviewEnv({
            ...(TEST_DATABASE_URL ? { store: await postgresStore({ max: N + 2 }) } : {}),
            env: { REVIEW_CONCURRENCY: "1", REVIEW_CONCURRENCY_PER_WORKSPACE: "1" },
        });
        store = env.t.services.store;
        await patProject(env, "alpha", { token: PAT(1) });
        await patProject(env, "beta", { token: PAT(2) });
        await patProject(env, "gamma", { token: PAT(3) });
    });
    after(() => env.close());

    /**
     * `n` claims at once, each held once it has read the queue until all have (so none sees another's
     * job started). In memory, transactions run one at a time, so there the hold just times out.
     */
    async function race(hellos: RunnerHello[]) {
        // Each runner known already, so the claims below go straight to the queue.
        for (const h of hellos) await env.t.services.runs.claim({ ...h, slots: 0 });
        const read = store.jobs.lastStarted;
        const waiting: (() => void)[] = [];
        let held = 0;
        store.jobs.lastStarted = async () => {
            const out = await read();
            if (held < hellos.length) {
                held++;
                const arrived = new Promise<void>((resolve) => {
                    waiting.push(resolve);
                    setTimeout(resolve, TEST_DATABASE_URL ? 2000 : 20);
                });
                if (waiting.length === hellos.length) for (const go of waiting) go();
                await arrived;
            }
            return out;
        };
        try {
            return (await Promise.all(hellos.map((h) => env.t.services.runs.claim(h)))).filter((j) => j !== null);
        } finally {
            store.jobs.lastStarted = read;
        }
    }
    const many = (tag: string, capacity?: number) => Array.from({ length: N }, (_, i) => runner(`${tag}-${i}`, 1, capacity));

    test("the instance's last place goes to one of them", async () => {
        for (const ws of ["alpha", "beta", "gamma"]) await queue(env, ws, 2, "instance");
        const won = await race(many("inst", 1));
        assert.equal(won.length, 1, "one claim got a job");
        assert.equal(await running(env), 1);
        await clear(env);
    });

    test("a workspace's last place goes to one of them, and its own limit of two to two", async () => {
        await setLimits(env, 10, 1);
        await queue(env, "alpha", 4, "ws");
        assert.equal((await race(many("ws", 1))).length, 1);
        assert.equal(await running(env, "alpha"), 1);
        await clear(env);

        await setOwn(env, "alpha", 2);
        await queue(env, "alpha", 4, "own");
        const won = await race(many("own", 1));
        assert.equal(won.length, 2);
        assert.equal(new Set(won.map((j) => j.id)).size, 2, "never the same job twice");
        assert.equal(await running(env, "alpha"), 2);
        await setOwn(env, "alpha", null);
        await clear(env);
    });

    test("with room for everyone, every claim gets a job of its own", async () => {
        await setLimits(env, 10, 10);
        for (const ws of ["alpha", "beta", "gamma"]) await queue(env, ws, 2, "all");
        const won = await race(many("all", 1));
        assert.equal(won.length, N);
        assert.equal(new Set(won.map((j) => j.id)).size, N);
        await clear(env);
    });

    test("one runner asking twice at once for its last slot gets one job", async () => {
        await setLimits(env, 10, 10);
        await queue(env, "alpha", 3, "twice");
        const one = runner("twice", 1, 1);
        const won = await race([one, one, one]);
        assert.equal(won.length, 1);
        assert.equal(await running(env), 1);
        await clear(env);
    });

    test("a limit lowered while claims are in flight is never passed", async () => {
        await setLimits(env, 10, 10);
        for (const ws of ["alpha", "beta", "gamma"]) await queue(env, ws, 2, "lowered");
        const [won] = await Promise.all([race(many("low", 1)), setLimits(env, 2, 2)]);
        // Each claim saw the old limits or the new ones; either way no more than the old allowed, and none since.
        assert.ok(won.length >= 2 && won.length <= N, String(won.length));
        assert.equal(await env.t.services.runs.claim(runner("late", 1, 1)), null);
        await clear(env);
    });
});
