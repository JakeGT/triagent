// The storage contract for instance settings, model grants and tokens summed per workspace: the same
// tests against the in-memory store and, when TRIAGENT_TEST_DATABASE_URL is set, the Postgres store.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MemoryStore } from "../src/store/memory.ts";
import type { ReviewRecord, Store } from "../src/store/types.ts";
import { postgresStore, TEST_DATABASE_URL } from "./helpers.ts";

const kinds: { name: string; make: () => Promise<Store>; skip?: string }[] = [
    { name: "memory", make: async () => new MemoryStore() },
    {
        name: "postgres",
        make: () => postgresStore(),
        ...(TEST_DATABASE_URL ? {} : { skip: "set TRIAGENT_TEST_DATABASE_URL to run against Postgres" }),
    },
];

async function workspace(store: Store, id: string) {
    await store.workspaces.put({ id, slug: id, name: id, kind: "org", createdAt: "2026-01-01T00:00:00.000Z" });
}

const review = (id: string, workspaceId: string, at: string, total: number, keySource: ReviewRecord["keySource"]): ReviewRecord => ({
    id,
    workspaceId,
    projectId: null,
    branch: "main",
    at,
    source: "run",
    kind: "pr",
    status: "done",
    model: "m",
    provider: "openrouter",
    keySource,
    tokens: total ? { input: total, output: 0, cacheRead: 0, total } : null,
    details: {},
});

for (const kind of kinds) {
    describe(`${kind.name} store: instance settings and grants`, { skip: kind.skip ?? false }, () => {
        test("instance settings: missing is null, put replaces, values round-trip", async () => {
            const store = await kind.make();
            assert.equal(await store.instanceSettings.get("x"), null);
            await store.instanceSettings.put("x", { a: 1, list: ["b"], nested: { c: null } });
            assert.deepEqual(await store.instanceSettings.get("x"), { a: 1, list: ["b"], nested: { c: null } });
            await store.instanceSettings.put("x", { a: 2 });
            assert.deepEqual(await store.instanceSettings.get("x"), { a: 2 });
            assert.equal(await store.instanceSettings.get("y"), null);
        });

        test("model grants: one per workspace, listed, deleted, and gone with their workspace", async () => {
            const store = await kind.make();
            await workspace(store, "w1");
            await workspace(store, "w2");
            const g1 = { workspaceId: "w1", monthlyTokens: 2_000_000, grantedBy: "admin", grantedAt: "2026-02-01T00:00:00.000Z" };
            const g2 = { workspaceId: "w2", monthlyTokens: 5_000_000_000, grantedBy: "admin", grantedAt: "2026-02-02T00:00:00.000Z" };
            await store.modelGrants.put(g1);
            await store.modelGrants.put(g2);
            assert.deepEqual(await store.modelGrants.get("w1"), g1);
            assert.deepEqual(await store.modelGrants.list(), [g1, g2]);
            await store.modelGrants.put({ ...g1, monthlyTokens: 10 });
            assert.equal((await store.modelGrants.get("w1"))?.monthlyTokens, 10);
            await store.modelGrants.delete("w1");
            assert.equal(await store.modelGrants.get("w1"), null);
            await store.workspaces.delete("w2");
            assert.deepEqual(await store.modelGrants.list(), []);
        });

        test("a grant written in a failed transaction is not kept", async () => {
            const store = await kind.make();
            await workspace(store, "w1");
            await assert.rejects(
                store.transaction(async (tx) => {
                    await tx.modelGrants.put({
                        workspaceId: "w1",
                        monthlyTokens: 5,
                        grantedBy: "a",
                        grantedAt: "2026-02-01T00:00:00.000Z",
                    });
                    await tx.instanceSettings.put("k", 1);
                    throw new Error("no");
                }),
            );
            assert.equal(await store.modelGrants.get("w1"), null);
            assert.equal(await store.instanceSettings.get("k"), null);
        });

        test("tokens by workspace: summed since a time, by key source", async () => {
            const store = await kind.make();
            await workspace(store, "w1");
            await workspace(store, "w2");
            await store.reviewHistory.add(review("r1", "w1", "2026-03-01T00:00:00.000Z", 100, "instance"));
            await store.reviewHistory.add(review("r2", "w1", "2026-03-02T00:00:00.000Z", 50, "instance"));
            await store.reviewHistory.add(review("r3", "w1", "2026-03-02T00:00:00.000Z", 7, "workspace"));
            await store.reviewHistory.add(review("r4", "w2", "2026-03-03T00:00:00.000Z", 9, "instance"));
            await store.reviewHistory.add(review("r5", "w2", "2026-02-28T23:59:59.999Z", 1000, "instance"));
            await store.reviewHistory.add(review("r6", "w2", "2026-03-04T00:00:00.000Z", 0, null));
            assert.deepEqual(await store.reviewHistory.tokensByWorkspace("2026-03-01T00:00:00.000Z", "instance"), { w1: 150, w2: 9 });
            assert.deepEqual(await store.reviewHistory.tokensByWorkspace("2026-03-01T00:00:00.000Z"), { w1: 157, w2: 9 });
            assert.deepEqual(await store.reviewHistory.tokensByWorkspace("2026-03-01T00:00:00.000Z", null), {});
            assert.deepEqual(await store.reviewHistory.tokensByWorkspace("2026-04-01T00:00:00.000Z", "instance"), {});
        });

        test("a project's reviews can be forgotten, leaving the rest", async () => {
            const store = await kind.make();
            await workspace(store, "w1");
            await workspace(store, "w2");
            const of = (id: string, workspaceId: string, projectId: string | null) => ({
                ...review(id, workspaceId, "2026-03-01T00:00:00.000Z", 10, null),
                projectId,
            });
            await store.reviewHistory.add(of("a", "w1", "p1"));
            await store.reviewHistory.add(of("b", "w1", "p2"));
            await store.reviewHistory.add(of("c", "w2", "p1"));
            await store.reviewHistory.removeProject("w1", "p1");
            assert.deepEqual(
                (await store.reviewHistory.list({ workspaceId: "w1" }, 10)).map((r) => r.id),
                ["b"],
            );
            assert.deepEqual(
                (await store.reviewHistory.list({ workspaceId: "w2" }, 10)).map((r) => r.id),
                ["c"],
            );
        });
    });
}
