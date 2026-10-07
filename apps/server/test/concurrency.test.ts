// Many agents at once: claims and revisions must hold when requests really overlap. Against Postgres
// (TRIAGENT_TEST_DATABASE_URL) these transactions run in parallel and collide; in memory they queue.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveEvent } from "../src/services/events.ts";
import type { Store } from "../src/store/types.ts";
import { ADMIN_PASSWORD, postgresStore, report, TEST_DATABASE_URL, testApp } from "./helpers.ts";

const N = 8;

/**
 * Hold the next `n` reads of a branch's triage until all `n` have arrived, so every request has read the
 * same state before any of them writes. (The memory store runs one transaction at a time, so it can only
 * ever have one waiting: there the hold just times out.)
 */
function overlap(store: Store, n: number): void {
    const read = store.triage.forBranch;
    const waiting: (() => void)[] = [];
    let held = 0;
    store.triage.forBranch = async (projectId, branch) => {
        const rows = await read(projectId, branch);
        if (held < n) {
            held++;
            const arrived = new Promise<void>((resolve) => {
                waiting.push(resolve);
                setTimeout(resolve, TEST_DATABASE_URL ? 2000 : 20);
            });
            if (waiting.length === n) for (const go of waiting) go();
            await arrived;
        }
        return rows;
    };
}

async function setUp(issues: number) {
    // A pool as large as the number of parallel requests, so they really do overlap.
    const t = await testApp(TEST_DATABASE_URL ? await postgresStore({ max: N }) : undefined);
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "org" } });
    await t.request("/api/v1/w/org/projects", { method: "POST", session: admin, body: { slug: "app" } });
    const paths = Array.from({ length: issues }, (_, i) => `src/file${i}.ts`);
    const uploaded = await t.request("/api/v1/w/org/p/app/reports", { method: "POST", session: admin, body: { report: report(...paths) } });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    const workspaceId = (await t.services.store.workspaces.bySlug("org"))?.id as string;
    const events: LiveEvent[] = [];
    t.services.events.subscribe({
        workspaceId,
        userKey: "user:observer",
        permissions: new Set(["read"]),
        send: (e) => events.push(e),
        close: () => {},
    });
    return { t, admin, events };
}

test("parallel claims on one branch hand out different issues, each announced once", async () => {
    const { t, admin, events } = await setUp(N + 2);
    overlap(t.services.store, N);
    const claims = await Promise.all(
        Array.from({ length: N }, (_, i) =>
            t.request("/api/v1/w/org/p/app/issues/claim?branch=main", { method: "POST", session: admin, body: { assignee: `agent-${i}` } }),
        ),
    );
    for (const c of claims) assert.equal(c.status, 200, JSON.stringify(c.body));
    const ids = claims.map((c) => c.body.issue?.id);
    assert.ok(ids.every(Boolean), "every claim got an issue");
    assert.equal(new Set(ids).size, N, "no issue was handed out twice");

    const listed = (await t.request("/api/v1/w/org/p/app/issues?branch=main&limit=100", { session: admin })).body.items as {
        id: string;
        status: string;
        assignee: string | null;
    }[];
    const claimed = listed.filter((x) => x.status === "in_progress");
    assert.equal(claimed.length, N);
    assert.equal(new Set(claimed.map((x) => x.assignee)).size, N);
    // A retried transaction doesn't announce its change twice.
    assert.equal(events.filter((e) => e.kind === "issue").length, N);
});

test("parallel updates sent with the same revision: one succeeds, the rest get 409", async () => {
    const { t, admin, events } = await setUp(1);
    const [issue] = (await t.request("/api/v1/w/org/p/app/issues?branch=main", { session: admin })).body.items;
    overlap(t.services.store, N);
    const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
            t.request(`/api/v1/w/org/p/app/issues/${issue.id}?branch=main`, {
                method: "PATCH",
                session: admin,
                body: { note: `Attempt ${i}`, rev: issue.rev },
            }),
        ),
    );
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, ...Array(N - 1).fill(409)]);
    for (const r of results.filter((x) => x.status === 409)) assert.equal(r.body.current?.rev, issue.rev + 1);
    const after = (await t.request(`/api/v1/w/org/p/app/issues/${issue.id}?branch=main`, { session: admin })).body;
    assert.equal(after.rev, issue.rev + 1);
    assert.equal(after.notes.length, 1);
    assert.equal(events.filter((e) => e.kind === "issue").length, 1);
});
