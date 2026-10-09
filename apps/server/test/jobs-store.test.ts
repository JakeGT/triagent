// The storage contract for review runs and GitHub state, against both stores.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MemoryStore } from "../src/store/memory.ts";
import type { Job, Store } from "../src/store/types.ts";
import { postgresStore, TEST_DATABASE_URL } from "./helpers.ts";

let clock = Date.UTC(2026, 3, 1);
const at = () => {
    clock += 1000;
    return new Date(clock).toISOString();
};

async function seed(store: Store) {
    for (const w of ["w1", "w2"]) {
        await store.workspaces.put({ id: w, slug: w, name: w, kind: "org", createdAt: at() });
        await store.projects.put({
            id: `${w}-p`,
            workspaceId: w,
            slug: "p",
            name: "p",
            repoUrl: null,
            defaultBranch: "main",
            webhookId: `hook-${w}`,
            createdAt: at(),
        });
    }
}

export const job = (id: string, workspaceId = "w1", extra: Partial<Job> = {}): Job => ({
    id,
    workspaceId,
    projectId: `${workspaceId}-p`,
    kind: "pr",
    dedupeKey: `pr:${id}`,
    title: `Review ${id}`,
    branch: "feature",
    gitRef: null,
    baseRef: "main",
    headSha: "a".repeat(40),
    baseSha: null,
    pr: { number: 1, title: "A change", url: null, headRef: "feature", author: "octo" },
    requestedBy: { name: "admin", userId: "u1", tokenId: null },
    requestedModels: null,
    source: "person",
    status: "queued",
    queuedAt: at(),
    startedAt: null,
    finishedAt: null,
    runnerId: null,
    leaseExpiresAt: null,
    cancelRequested: null,
    progress: {},
    result: null,
    error: null,
    model: null,
    credentials: null,
    repository: { id: 42, fullName: "acme/app" },
    logLines: 0,
    logDropped: 0,
    ...extra,
});

const kinds: { name: string; make: () => Promise<Store>; skip?: string }[] = [
    { name: "memory", make: async () => new MemoryStore() },
    {
        name: "postgres",
        make: () => postgresStore(),
        ...(TEST_DATABASE_URL ? {} : { skip: "set TRIAGENT_TEST_DATABASE_URL to run against Postgres" }),
    },
];

for (const kind of kinds) {
    describe(`jobs and GitHub state (${kind.name} store)`, { ...(kind.skip ? { skip: kind.skip } : {}) }, () => {
        test("jobs are saved, listed newest first and filtered, and active ones listed oldest first", async () => {
            const store = await kind.make();
            await seed(store);
            await store.jobs.put(job("j1"));
            await store.jobs.put(job("j2", "w2"));
            await store.jobs.put(job("j3", "w1", { status: "running", startedAt: at(), progress: { phase: "reviewing" } }));
            await store.jobs.put(job("j4", "w1", { status: "done", startedAt: at(), finishedAt: at(), result: { total: 3 } }));
            assert.deepEqual(
                (await store.jobs.list({ workspaceId: "w1" }, 10)).map((j) => j.id),
                ["j4", "j3", "j1"],
            );
            assert.deepEqual(
                (await store.jobs.list({ statuses: ["queued"] }, 10)).map((j) => j.id),
                ["j2", "j1"],
            );
            assert.deepEqual(await store.jobs.list({ statuses: [] }, 10), []);
            // The models a run was asked to use come back as given, and who asked is unchanged by them.
            const asked = job("j5", "w2", { status: "cancelled", requestedModels: ["fav-1", "instance"] });
            await store.jobs.put(asked);
            assert.deepEqual(await store.jobs.get("j5"), asked);
            assert.deepEqual((await store.jobs.get("j1"))?.requestedModels, null);
            assert.deepEqual(
                (await store.jobs.active()).map((j) => j.id),
                ["j1", "j2", "j3"],
            );
            const j3 = await store.jobs.get("j3");
            assert.deepEqual(j3?.progress, { phase: "reviewing" });
            assert.deepEqual(j3?.pr, job("x").pr);
            assert.deepEqual(j3?.repository, { id: 42, fullName: "acme/app" });
            assert.equal((await store.jobs.get("j4"))?.result?.total, 3);
            const started = await store.jobs.lastStarted();
            assert.ok(started.get("w1"));
            assert.equal(started.get("w2"), undefined);
        });

        test("a job's log keeps its newest lines under the cap, with seq as a stable cursor", async () => {
            const store = await kind.make();
            await seed(store);
            await store.jobs.put(job("j1"));
            const line = (n: number) => ({ at: at(), line: `line ${n} ${"x".repeat(90)}` }); // 98-99 bytes
            await store.jobs.appendLog("j1", [line(1), line(2), line(3)], 1000);
            assert.deepEqual(
                (await store.jobs.log("j1", 0, 10)).map((l) => l.seq),
                [1, 2, 3],
            );
            assert.deepEqual(
                (await store.jobs.log("j1", 2, 10)).map((l) => l.line.split(" ")[1]),
                ["3"],
            );
            await store.jobs.appendLog(
                "j1",
                Array.from({ length: 12 }, (_, i) => line(i + 4)),
                1000,
            );
            const all = await store.jobs.log("j1", 0, 100);
            assert.ok(all.length <= 10 && all.length >= 9, `kept ${all.length}`);
            assert.equal(all.at(-1)?.seq, 15);
            const j = await store.jobs.get("j1");
            assert.equal(j?.logLines, 15);
            assert.equal(j?.logDropped, 15 - all.length);
            // Saving the job again (with stale counters) leaves the log's counters alone.
            await store.jobs.put({ ...job("j1"), status: "running" });
            assert.equal((await store.jobs.get("j1"))?.logLines, 15);
        });

        test("a failed transaction leaves no log lines behind", async () => {
            const store = await kind.make();
            await seed(store);
            await store.jobs.put(job("j1"));
            await assert.rejects(
                store.transaction(async (tx) => {
                    await tx.jobs.appendLog("j1", [{ at: at(), line: "lost" }], 1000);
                    throw new Error("boom");
                }),
            );
            assert.equal((await store.jobs.log("j1", 0, 10)).length, 0);
            assert.equal((await store.jobs.get("j1"))?.logLines, 0);
        });

        test("installations, GitHub state and deliveries, and what goes with a project or workspace", async () => {
            const store = await kind.make();
            await seed(store);
            await store.githubInstallations.put({
                id: 42,
                workspaceId: "w1",
                accountLogin: "acme",
                accountType: "Organization",
                repositorySelection: "selected",
                suspended: false,
                linkedBy: "admin",
                linkedAt: at(),
            });
            assert.equal((await store.githubInstallations.get(42))?.accountLogin, "acme");
            assert.equal((await store.githubInstallations.forWorkspace("w1")).length, 1);
            assert.equal((await store.githubInstallations.forWorkspace("w2")).length, 0);

            await store.githubState.put("w1-p", { prs: { 1: { title: "x" } } });
            assert.deepEqual(await store.githubState.get("w1-p"), { prs: { 1: { title: "x" } } });
            assert.equal(await store.githubState.get("w2-p"), null);

            for (let i = 0; i < 5; i++)
                await store.githubDeliveries.add(
                    {
                        workspaceId: "w1",
                        projectId: "w1-p",
                        at: at(),
                        event: "push",
                        deliveryId: `d${i}`,
                        what: null,
                        outcome: "received",
                        detail: `n${i}`,
                    },
                    3,
                );
            await store.githubDeliveries.add(
                {
                    workspaceId: null,
                    projectId: null,
                    at: at(),
                    event: "ping",
                    deliveryId: null,
                    what: null,
                    outcome: "refused",
                    detail: "x",
                },
                3,
            );
            assert.deepEqual(
                (await store.githubDeliveries.list("w1-p", 10)).map((d) => d.detail),
                ["n4", "n3", "n2"],
            );
            assert.equal((await store.githubDeliveries.list(null, 10)).length, 1);

            await store.jobs.put(job("j1"));
            await store.jobs.appendLog("j1", [{ at: at(), line: "hello" }], 1000);
            await store.projects.delete("w1-p");
            assert.equal(await store.jobs.get("j1"), null);
            assert.equal(await store.githubState.get("w1-p"), null);
            assert.equal((await store.githubDeliveries.list("w1-p", 10)).length, 0);
            await store.workspaces.delete("w1");
            assert.equal(await store.githubInstallations.get(42), null);
        });

        test("runners are remembered by id", async () => {
            const store = await kind.make();
            await store.runners.seen({ id: "r1", name: "runner-a", version: "1", slots: 1, lastSeenAt: at() });
            await store.runners.seen({ id: "r1", name: "runner-a", version: "1", slots: 2, lastSeenAt: at() });
            const list = await store.runners.list();
            assert.equal(list.length, 1);
            assert.equal(list[0]?.slots, 2);
        });

        test("one holder of a named lock at a time", async () => {
            const store = await kind.make();
            assert.equal(await store.holdLock("poller"), true);
            assert.equal(await store.holdLock("poller"), true, "the holder keeps it");
        });
    });
}

describe("postgres locks", { skip: TEST_DATABASE_URL ? false : "set TRIAGENT_TEST_DATABASE_URL to run against Postgres" }, () => {
    test("a second process sharing the database doesn't get a lock the first holds", async () => {
        const { sameDatabase } = await import("./helpers.ts");
        const a = await postgresStore();
        const b = sameDatabase(a);
        assert.equal(await a.holdLock("poller"), true);
        assert.equal(await b.holdLock("poller"), false);
        assert.equal(await b.holdLock("other"), true);
    });

    test("a holder whose session ended no longer has the lock", async () => {
        const { sameDatabase } = await import("./helpers.ts");
        const a = await postgresStore();
        const b = sameDatabase(a);
        assert.equal(await a.holdLock("poller"), true);
        await b.sql`
            select pg_terminate_backend(pid) from pg_locks
            where locktype = 'advisory' and pid <> pg_backend_pid()
                and ((classid::bigint << 32) | objid::bigint) = hashtextextended(${`triagent:${a.schema}:poller`}, 0)`;
        await new Promise((r) => setTimeout(r, 200)); // let a notice its connection closing
        assert.equal(await b.holdLock("poller"), true);
        assert.equal(await a.holdLock("poller"), false);
    });
});
