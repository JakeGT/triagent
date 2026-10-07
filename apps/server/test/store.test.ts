// The storage contract: the same tests run against the in-memory store and, when TRIAGENT_TEST_DATABASE_URL
// is set, the Postgres store, so services can't tell them apart.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import postgres from "postgres";
import type { RawReport, UploadMeta } from "../src/domain/report.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { ActivityRow, ApiToken, AuditRow, Project, Store, TriageRecord, User, Workspace } from "../src/store/types.ts";
import { postgresStore, TEST_DATABASE_URL } from "./helpers.ts";

/** A distinct, increasing timestamp. */
let clock = Date.UTC(2026, 0, 1);
const at = () => {
    clock += 1000;
    return new Date(clock).toISOString();
};

const user = (id: string, extra: Partial<User> = {}): User => ({
    id,
    username: id,
    displayName: id.toUpperCase(),
    email: null,
    passwordHash: null,
    mustChangePassword: false,
    isInstanceAdmin: false,
    issuer: null,
    subject: null,
    notify: { scope: "mine", problemsOnly: false },
    createdAt: at(),
    lastLoginAt: null,
    ...extra,
});

const workspace = (id: string): Workspace => ({ id, slug: id, name: id.toUpperCase(), kind: "org", createdAt: at() });

const project = (id: string, workspaceId: string): Project => ({
    id,
    workspaceId,
    slug: id,
    name: id,
    repoUrl: null,
    defaultBranch: "main",
    webhookId: `hook-${id}`,
    createdAt: at(),
});

const token = (id: string, workspaceId: string, ownerUserId: string | null = null): ApiToken => ({
    id,
    workspaceId,
    ownerUserId,
    name: id,
    scope: "read",
    hash: `hash-${id}`,
    prefix: "tri_abc",
    createdAt: at(),
    createdBy: "admin",
    expiresAt: null,
    lastUsedAt: null,
});

const raw = (...paths: string[]): RawReport => ({
    status: "completed",
    comments: paths.map((path) => ({ path, content: `A problem in ${path}.`, severity: "high", category: "bug" })),
    project_summary: "",
});

const upload = (branch: string): UploadMeta => ({
    id: `u-${branch}-${clock}`,
    branch,
    commit: null,
    fileName: "report.json",
    uploadedAt: at(),
    uploadedBy: "admin",
    sha256: null,
    scope: "full",
});

const triage = (projectId: string, branch: string, itemId: string, extra: Partial<TriageRecord> = {}): TriageRecord => ({
    projectId,
    branch,
    kind: "issue",
    itemId,
    status: "open",
    assignee: null,
    severity: null,
    category: null,
    duplicateOf: null,
    needsDiscussion: false,
    notes: [],
    rev: 1,
    updatedAt: at(),
    updatedBy: "admin",
    ...extra,
});

let ids = 0;
const activity = (workspaceId: string, projectId: string | null, branch: string | null): ActivityRow => ({
    id: `a${++ids}`,
    workspaceId,
    projectId,
    branch,
    at: at(),
    actor: "admin",
    actorUserId: null,
    via: "web",
    kind: "issue",
    itemId: "x",
    changes: { status: { from: "open", to: "resolved" } },
});

const audit = (workspaceId: string | null): AuditRow => ({
    id: `au${++ids}`,
    workspaceId,
    at: at(),
    actor: "admin",
    actorUserId: null,
    via: "web",
    kind: "token",
    target: "t",
    changes: { created: true },
    ip: null,
});

/** A workspace with one project in it. */
async function seed(store: Store, w = "w1", p = "p1") {
    await store.workspaces.put(workspace(w));
    await store.projects.put(project(p, w));
}

const kinds: { name: string; make: () => Promise<Store>; skip?: string }[] = [
    { name: "memory", make: async () => new MemoryStore() },
    {
        name: "postgres",
        make: () => postgresStore(),
        ...(TEST_DATABASE_URL ? {} : { skip: "set TRIAGENT_TEST_DATABASE_URL to run against Postgres" }),
    },
];

for (const kind of kinds) {
    describe(`${kind.name} store`, { skip: kind.skip ?? false }, () => {
        test("users: found by id or by username ignoring case; put replaces; delete removes", async () => {
            const store = await kind.make();
            await store.users.put(user("alice", { username: "Alice", passwordHash: "h1" }));
            await store.users.put(user("bob"));
            assert.equal((await store.users.byUsername("ALICE"))?.id, "alice");
            assert.equal(await store.users.byUsername("carol"), null);
            assert.equal(await store.users.count(), 2);
            const alice = (await store.users.get("alice")) as User;
            const changed: User = { ...alice, displayName: "Alice A", lastLoginAt: at(), notify: { scope: "all", problemsOnly: true } };
            await store.users.put(changed);
            assert.deepEqual(await store.users.get("alice"), changed);
            assert.deepEqual((await store.users.list()).map((u) => u.id).sort(), ["alice", "bob"]);
            await store.users.delete("bob");
            assert.equal(await store.users.get("bob"), null);
            assert.equal(await store.users.count(), 1);
        });

        test("sessions: listed per user, swept when idle or old, and put is a plain upsert", async () => {
            const store = await kind.make();
            await store.users.put(user("u"));
            const base = { userId: "u", csrf: "c", credential: null };
            await store.sessions.put({ ...base, idHash: "fresh", createdAt: 10_000, lastSeenAt: 10_000 });
            await store.sessions.put({ ...base, idHash: "idle", createdAt: 9_000, lastSeenAt: 1_000 });
            await store.sessions.put({ ...base, idHash: "old", createdAt: 1_000, lastSeenAt: 9_500 });
            assert.equal((await store.sessions.listForUser("u")).length, 3);
            assert.equal(await store.sessions.sweep(5_000, 5_000), 2);
            assert.deepEqual(
                (await store.sessions.listForUser("u")).map((s) => s.idHash),
                ["fresh"],
            );
            const s = await store.sessions.get("fresh");
            assert.deepEqual(s, { ...base, idHash: "fresh", createdAt: 10_000, lastSeenAt: 10_000 });
            // Touching re-reads first, so a session deleted meanwhile isn't brought back.
            await store.sessions.delete("fresh");
            await store.transaction(async (tx) => {
                const current = await tx.sessions.get("fresh");
                if (current) await tx.sessions.put({ ...current, lastSeenAt: 20_000 });
            });
            assert.equal(await store.sessions.get("fresh"), null);
        });

        test("workspaces and memberships", async () => {
            const store = await kind.make();
            await store.users.put(user("u"));
            await store.workspaces.put(workspace("w1"));
            await store.workspaces.put(workspace("w2"));
            assert.equal((await store.workspaces.bySlug("w2"))?.id, "w2");
            assert.equal(await store.workspaces.bySlug("nope"), null);
            await store.workspaces.put({ ...((await store.workspaces.get("w1")) as Workspace), name: "Renamed" });
            assert.equal((await store.workspaces.get("w1"))?.name, "Renamed");
            assert.equal((await store.workspaces.list()).length, 2);

            await store.memberships.put({ workspaceId: "w1", userId: "u", role: "viewer", createdAt: at() });
            await store.memberships.put({ workspaceId: "w2", userId: "u", role: "owner", createdAt: at() });
            const m = await store.memberships.get("w1", "u");
            assert.equal(m?.role, "viewer");
            await store.memberships.put({ ...(m as NonNullable<typeof m>), role: "admin" });
            assert.equal((await store.memberships.get("w1", "u"))?.role, "admin");
            assert.equal((await store.memberships.forUser("u")).length, 2);
            assert.deepEqual(
                (await store.memberships.forWorkspace("w2")).map((x) => x.userId),
                ["u"],
            );
            await store.memberships.delete("w1", "u");
            assert.equal(await store.memberships.get("w1", "u"), null);
            assert.equal((await store.memberships.forUser("u")).length, 1);
        });

        test("tokens: found by id, hash and workspace", async () => {
            const store = await kind.make();
            await store.users.put(user("u"));
            await store.workspaces.put(workspace("w1"));
            const t1 = token("t1", "w1", "u");
            await store.tokens.put(t1);
            await store.tokens.put(token("t2", "w1"));
            assert.deepEqual(await store.tokens.get("t1"), t1);
            assert.deepEqual(await store.tokens.byHash("hash-t1"), t1);
            assert.equal(await store.tokens.byHash("hash-none"), null);
            const used = at();
            await store.tokens.put({ ...t1, lastUsedAt: used, expiresAt: used });
            assert.equal((await store.tokens.get("t1"))?.lastUsedAt, used);
            assert.equal((await store.tokens.get("t1"))?.expiresAt, used);
            assert.deepEqual((await store.tokens.forWorkspace("w1")).map((t) => t.id).sort(), ["t1", "t2"]);
            await store.tokens.delete("t1");
            assert.equal(await store.tokens.get("t1"), null);
        });

        test("projects: found by id, slug in a workspace, and webhook id", async () => {
            const store = await kind.make();
            await store.workspaces.put(workspace("w1"));
            await store.workspaces.put(workspace("w2"));
            await store.projects.put(project("p1", "w1"));
            await store.projects.put({ ...project("p2", "w2"), slug: "p1" });
            assert.equal((await store.projects.bySlug("w1", "p1"))?.id, "p1");
            assert.equal((await store.projects.bySlug("w2", "p1"))?.id, "p2");
            assert.equal((await store.projects.byWebhookId("hook-p2"))?.id, "p2");
            assert.equal(await store.projects.byWebhookId("hook-none"), null);
            const p1 = (await store.projects.get("p1")) as Project;
            await store.projects.put({ ...p1, defaultBranch: "trunk", repoUrl: "https://github.com/o/r" });
            assert.deepEqual(await store.projects.get("p1"), { ...p1, defaultBranch: "trunk", repoUrl: "https://github.com/o/r" });
            assert.deepEqual(
                (await store.projects.forWorkspace("w1")).map((p) => p.id),
                ["p1"],
            );
        });

        test("reports: each write gets a higher version, and the archive keeps the newest", async () => {
            const store = await kind.make();
            await seed(store);
            const a = await store.reports.put({ projectId: "p1", branch: "main", report: raw("a.ts"), upload: upload("main") });
            const b = await store.reports.put({ projectId: "p1", branch: "main", report: raw("b.ts"), upload: upload("main") });
            const c = await store.reports.put({ projectId: "p1", branch: "dev", report: raw("c.ts"), upload: upload("dev") });
            assert.ok(a.version < b.version && b.version < c.version);
            const stored = await store.reports.get("p1", "main");
            assert.equal(stored?.version, b.version);
            assert.deepEqual(stored?.report, raw("b.ts"));
            assert.deepEqual((await store.reports.branches("p1")).map((r) => r.branch).sort(), ["dev", "main"]);
            await store.reports.delete("p1", "dev");
            assert.equal(await store.reports.get("p1", "dev"), null);
            const d = await store.reports.put({ projectId: "p1", branch: "dev", report: raw("d.ts"), upload: upload("dev") });
            assert.ok(d.version > c.version);

            for (const n of [1, 2, 3])
                await store.reports.archive(
                    {
                        projectId: "p1",
                        branch: "main",
                        report: raw(`${n}.ts`),
                        upload: upload("main"),
                        archivedAt: at(),
                        reason: "replaced",
                    },
                    2,
                );
            const kept = await store.reports.archived("p1", "main");
            assert.deepEqual(
                kept.map((x) => x.report.comments[0]?.path),
                ["3.ts", "2.ts"],
            );
            assert.equal("triage" in (kept[0] as object), false);
            await store.reports.archive(
                {
                    projectId: "p1",
                    branch: "dev",
                    report: raw("dev.ts"),
                    upload: upload("dev"),
                    archivedAt: at(),
                    reason: "deleted",
                    triage: [triage("p1", "dev", "i1")],
                },
                2,
            );
            assert.equal((await store.reports.archived("p1", "dev"))[0]?.triage?.[0]?.itemId, "i1");
            await store.reports.renameArchive("p1", "main", "dev");
            assert.deepEqual(await store.reports.archived("p1", "main"), []);
            const moved = await store.reports.archived("p1", "dev");
            assert.deepEqual(
                moved.map((x) => [x.branch, x.report.comments[0]?.path]),
                [
                    ["dev", "dev.ts"],
                    ["dev", "3.ts"],
                    ["dev", "2.ts"],
                ],
            );
        });

        test("triage: per item and branch; a renamed branch's records replace any already there", async () => {
            const store = await kind.make();
            await seed(store);
            await store.triage.put(
                triage("p1", "main", "i1", { notes: [{ id: "n1", at: at(), by: "A", authorKey: "user:a", text: "hi" }] }),
            );
            await store.triage.put(triage("p1", "main", "t1", { kind: "task", status: "resolved" }));
            await store.triage.put(triage("p1", "dev", "i1", { status: "wont_fix" }));
            await store.triage.put(triage("p1", "dev", "i2"));
            const i1 = await store.triage.get("p1", "main", "issue", "i1");
            assert.equal(i1?.notes[0]?.text, "hi");
            assert.equal(await store.triage.get("p1", "main", "task", "i1"), null);
            await store.triage.put({ ...(i1 as TriageRecord), status: "in_progress", assignee: "bob", rev: 2 });
            assert.deepEqual(await store.triage.get("p1", "main", "issue", "i1"), {
                ...i1,
                status: "in_progress",
                assignee: "bob",
                rev: 2,
            });
            assert.equal((await store.triage.forBranch("p1", "main")).length, 2);

            await store.triage.renameBranch("p1", "main", "dev");
            assert.deepEqual(await store.triage.forBranch("p1", "main"), []);
            const dev = await store.triage.forBranch("p1", "dev");
            assert.deepEqual(dev.map((r) => `${r.kind}:${r.itemId}:${r.status}`).sort(), [
                "issue:i1:in_progress",
                "issue:i2:open",
                "task:t1:resolved",
            ]);
            await store.triage.deleteBranch("p1", "dev");
            assert.deepEqual(await store.triage.forBranch("p1", "dev"), []);
        });

        test("activity: newest first, filtered, paged with a cursor", async () => {
            const store = await kind.make();
            await seed(store, "w1", "p1");
            await store.projects.put(project("p2", "w1"));
            await seed(store, "w2", "p3");
            const rows = [
                activity("w1", "p1", "main"),
                activity("w1", "p2", "main"),
                activity("w1", "p1", "dev"),
                activity("w2", "p3", "main"),
                activity("w1", "p1", "main"),
                activity("w1", null, null),
            ];
            for (const r of rows) await store.activity.add(r);
            const ids = (list: ActivityRow[]) => list.map((r) => r.id);
            const [r0, r1, r2, , r4, r5] = rows.map((r) => r.id);
            assert.deepEqual(ids(await store.activity.list({ workspaceId: "w1" }, { limit: 10 })), [r5, r4, r2, r1, r0]);
            assert.deepEqual(ids(await store.activity.list({ workspaceId: "w1", projectId: "p1" }, { limit: 10 })), [r4, r2, r0]);
            assert.deepEqual(ids(await store.activity.list({ workspaceId: "w1", projectId: "p1", branch: "main" }, { limit: 10 })), [
                r4,
                r0,
            ]);
            const page1 = await store.activity.list({ workspaceId: "w1" }, { limit: 2 });
            assert.deepEqual(ids(page1), [r5, r4]);
            const page2 = await store.activity.list({ workspaceId: "w1" }, { limit: 2, before: page1.at(-1)?.id as string });
            assert.deepEqual(ids(page2), [r2, r1]);
            const page3 = await store.activity.list({ workspaceId: "w1" }, { limit: 2, before: page2.at(-1)?.id as string });
            assert.deepEqual(ids(page3), [r0]);
            assert.deepEqual(await store.activity.list({ workspaceId: "w1" }, { limit: 2, before: "unknown" }), []);
            assert.deepEqual(await store.activity.list({ workspaceId: "w1" }, { limit: 1 }), [rows[5]]);
        });

        test("audit: newest first, per workspace or instance-wide, paged", async () => {
            const store = await kind.make();
            await store.workspaces.put(workspace("w1"));
            const rows = [audit(null), audit("w1"), audit(null), audit("w1"), audit(null)];
            for (const r of rows) await store.audit.add(r);
            const ids = (list: AuditRow[]) => list.map((r) => r.id);
            const [a0, a1, a2, a3, a4] = rows.map((r) => r.id);
            assert.deepEqual(ids(await store.audit.list({ workspaceId: null }, { limit: 10 })), [a4, a2, a0]);
            assert.deepEqual(ids(await store.audit.list({ workspaceId: "w1" }, { limit: 10 })), [a3, a1]);
            assert.deepEqual(ids(await store.audit.list({ workspaceId: null }, { limit: 1, before: a4 as string })), [a2]);
            assert.deepEqual(await store.audit.list({ workspaceId: "w1" }, { limit: 10 }).then((r) => r[0]), rows[3]);
        });

        test("upload links: counted, swept when expired, and taken once", async () => {
            const store = await kind.make();
            await seed(store);
            const params = {
                branch: "main",
                commit: null,
                confirm: false,
                reopen: true,
                fileName: null,
                actor: "admin",
                actorUserId: null,
                actorTokenId: null,
            };
            await store.uploadLinks.put({ hash: "old", projectId: "p1", params, expiresAt: 1_000 });
            await store.uploadLinks.put({ hash: "new", projectId: "p1", params, expiresAt: 9_000 });
            assert.equal(await store.uploadLinks.count(), 2);
            await store.uploadLinks.sweep(5_000);
            assert.equal(await store.uploadLinks.count(), 1);
            assert.deepEqual(await store.uploadLinks.get("new"), { hash: "new", projectId: "p1", params, expiresAt: 9_000 });
            const taken = await Promise.all(Array.from({ length: 8 }, () => store.uploadLinks.take("new")));
            assert.equal(taken.filter(Boolean).length, 1);
            assert.equal(await store.uploadLinks.get("new"), null);
            assert.equal(await store.uploadLinks.take("new"), null);
        });

        test("upload links: taken once even by concurrent transactions", async () => {
            const store = await kind.make();
            await seed(store);
            const params = {
                branch: "main",
                commit: null,
                confirm: false,
                reopen: true,
                fileName: null,
                actor: "admin",
                actorUserId: null,
                actorTokenId: null,
            };
            await store.uploadLinks.put({ hash: "h", projectId: "p1", params, expiresAt: Date.now() + 60_000 });
            const results = await Promise.all(
                Array.from({ length: 6 }, () =>
                    store.transaction(async (tx) => {
                        const link = await tx.uploadLinks.take("h");
                        if (link) await tx.activity.add(activity("w1", "p1", "main"));
                        return link;
                    }),
                ),
            );
            assert.equal(results.filter(Boolean).length, 1);
            assert.equal((await store.activity.list({ workspaceId: "w1" }, { limit: 10 })).length, 1);
        });

        test("secrets and settings: instance, workspace and project scopes are separate", async () => {
            const store = await kind.make();
            await seed(store);
            const secret = (workspaceId: string | null, projectId: string | null, sealed: string) => ({
                workspaceId,
                projectId,
                name: "key",
                sealed,
                hint: sealed.slice(-2),
                setBy: "admin",
                setAt: at(),
            });
            await store.secrets.put(secret(null, null, "instance"));
            await store.secrets.put(secret("w1", null, "workspace"));
            await store.secrets.put(secret("w1", "p1", "project"));
            await store.secrets.put(secret("w1", "p1", "project-2"));
            assert.equal((await store.secrets.get(null, null, "key"))?.sealed, "instance");
            assert.equal((await store.secrets.get("w1", null, "key"))?.sealed, "workspace");
            assert.equal((await store.secrets.get("w1", "p1", "key"))?.sealed, "project-2");
            assert.equal(await store.secrets.get("w1", "p1", "other"), null);
            assert.deepEqual(
                (await store.secrets.list("w1", null)).map((s) => s.sealed),
                ["workspace"],
            );
            await store.secrets.delete("w1", null, "key");
            assert.equal(await store.secrets.get("w1", null, "key"), null);
            assert.ok(await store.secrets.get(null, null, "key"));
            assert.ok(await store.secrets.get("w1", "p1", "key"));

            await store.settings.put({ workspaceId: "w1", projectId: null, key: "k", value: { a: 1 } });
            await store.settings.put({ workspaceId: "w1", projectId: "p1", key: "k", value: ["x"] });
            await store.settings.put({ workspaceId: "w1", projectId: "p1", key: "k", value: "replaced" });
            assert.deepEqual((await store.settings.get("w1", null, "k"))?.value, { a: 1 });
            assert.deepEqual(await store.settings.get("w1", "p1", "k"), {
                workspaceId: "w1",
                projectId: "p1",
                key: "k",
                value: "replaced",
            });
            assert.equal(await store.settings.get("w1", null, "other"), null);
        });

        test("deleting a project removes everything stored for it, and nothing else", async () => {
            const store = await kind.make();
            await seed(store, "w1", "p1");
            await store.projects.put(project("p2", "w1"));
            for (const p of ["p1", "p2"]) {
                await store.reports.put({ projectId: p, branch: "main", report: raw("a.ts"), upload: upload("main") });
                await store.reports.archive(
                    { projectId: p, branch: "main", report: raw("a.ts"), upload: upload("main"), archivedAt: at(), reason: "replaced" },
                    5,
                );
                await store.triage.put(triage(p, "main", "i1"));
                await store.settings.put({ workspaceId: "w1", projectId: p, key: "automation", value: {} });
                await store.secrets.put({ workspaceId: "w1", projectId: p, name: "s", sealed: "x", hint: "x", setBy: "a", setAt: at() });
                await store.uploadLinks.put({
                    hash: `link-${p}`,
                    projectId: p,
                    params: {
                        branch: "main",
                        commit: null,
                        confirm: false,
                        reopen: true,
                        fileName: null,
                        actor: "a",
                        actorUserId: null,
                        actorTokenId: null,
                    },
                    expiresAt: Date.now() + 60_000,
                });
                await store.activity.add(activity("w1", p, "main"));
            }
            await store.projects.delete("p1");
            assert.equal(await store.projects.get("p1"), null);
            assert.equal(await store.reports.get("p1", "main"), null);
            assert.deepEqual(await store.reports.archived("p1", "main"), []);
            assert.deepEqual(await store.triage.forBranch("p1", "main"), []);
            assert.equal(await store.settings.get("w1", "p1", "automation"), null);
            assert.equal(await store.secrets.get("w1", "p1", "s"), null);
            assert.equal(await store.uploadLinks.get("link-p1"), null);
            // The workspace's history keeps what happened in the project.
            assert.equal((await store.activity.list({ workspaceId: "w1", projectId: "p1" }, { limit: 10 })).length, 1);

            assert.ok(await store.reports.get("p2", "main"));
            assert.equal((await store.reports.archived("p2", "main")).length, 1);
            assert.equal((await store.triage.forBranch("p2", "main")).length, 1);
            assert.ok(await store.settings.get("w1", "p2", "automation"));
            assert.ok(await store.secrets.get("w1", "p2", "s"));
            assert.ok(await store.uploadLinks.get("link-p2"));
        });

        test("deleting a workspace removes everything stored for it, and nothing else", async () => {
            const store = await kind.make();
            await store.users.put(user("u"));
            for (const w of ["w1", "w2"]) {
                await seed(store, w, `p-${w}`);
                await store.memberships.put({ workspaceId: w, userId: "u", role: "owner", createdAt: at() });
                await store.tokens.put(token(`t-${w}`, w, "u"));
                await store.settings.put({ workspaceId: w, projectId: null, key: "review-model", value: { provider: "openrouter" } });
                await store.secrets.put({ workspaceId: w, projectId: null, name: "s", sealed: "x", hint: "x", setBy: "a", setAt: at() });
                await store.reports.put({ projectId: `p-${w}`, branch: "main", report: raw("a.ts"), upload: upload("main") });
                await store.activity.add(activity(w, `p-${w}`, "main"));
                await store.audit.add(audit(w));
            }
            await store.workspaces.delete("w1");
            assert.equal(await store.workspaces.get("w1"), null);
            assert.equal(await store.projects.get("p-w1"), null);
            assert.equal(await store.reports.get("p-w1", "main"), null);
            assert.equal(await store.memberships.get("w1", "u"), null);
            assert.equal(await store.tokens.get("t-w1"), null);
            assert.equal(await store.settings.get("w1", null, "review-model"), null);
            assert.equal(await store.secrets.get("w1", null, "s"), null);
            assert.deepEqual(await store.activity.list({ workspaceId: "w1" }, { limit: 10 }), []);
            // The audit log outlives what it describes.
            assert.equal((await store.audit.list({ workspaceId: "w1" }, { limit: 10 })).length, 1);

            assert.ok(await store.users.get("u"));
            assert.ok(await store.projects.get("p-w2"));
            assert.ok(await store.reports.get("p-w2", "main"));
            assert.equal((await store.memberships.forUser("u")).length, 1);
            assert.ok(await store.tokens.get("t-w2"));
            assert.ok(await store.settings.get("w2", null, "review-model"));
            assert.ok(await store.secrets.get("w2", null, "s"));
            assert.equal((await store.activity.list({ workspaceId: "w2" }, { limit: 10 })).length, 1);
        });

        test("a failed transaction leaves nothing behind", async () => {
            const store = await kind.make();
            const u1 = user("u1", { displayName: "a" });
            await store.users.put(u1);
            await assert.rejects(
                store.transaction(async (tx) => {
                    await tx.users.put({ ...u1, displayName: "changed" });
                    await tx.users.put(user("u2"));
                    await tx.audit.add(audit(null));
                    throw new Error("boom");
                }),
                /boom/,
            );
            assert.equal((await store.users.get("u1"))?.displayName, "a");
            assert.equal(await store.users.get("u2"), null);
            assert.equal((await store.audit.list({ workspaceId: null }, { limit: 10 })).length, 0);
        });

        test("a transaction inside another joins it: an inner failure undoes the outer one's writes too", async () => {
            const store = await kind.make();
            await assert.rejects(
                store.transaction(async (tx) => {
                    await tx.users.put(user("outer"));
                    await store.transaction(async (inner) => {
                        await inner.users.put(user("inner"));
                        // The inner transaction sees the outer one's writes, as does a call made through the store.
                        assert.ok(await inner.users.get("outer"));
                        assert.ok(await store.users.get("inner"));
                        throw new Error("inner failed");
                    });
                }),
                /inner failed/,
            );
            assert.equal(await store.users.get("outer"), null);
            assert.equal(await store.users.get("inner"), null);

            await store.transaction(async () => {
                await store.users.put(user("a"));
                await store.transaction(async (inner) => inner.users.put(user("b")));
            });
            assert.ok(await store.users.get("a"));
            assert.ok(await store.users.get("b"));
        });

        test("after-commit hooks run once the outermost transaction is saved, and never if it fails", async () => {
            const store = await kind.make();
            const ran: string[] = [];
            await store.transaction(async (tx) => {
                await tx.users.put(user("a"));
                store.afterCommit(() => ran.push("outer"));
                await store.transaction(async () => {
                    store.afterCommit(() => ran.push("inner"));
                });
                assert.deepEqual(ran, []);
            });
            assert.deepEqual(ran, ["outer", "inner"]);
            await assert.rejects(
                store.transaction(async () => {
                    store.afterCommit(() => ran.push("failed"));
                    throw new Error("no");
                }),
            );
            assert.deepEqual(ran, ["outer", "inner"]);
        });

        test("transactions behave as if run one at a time: concurrent read-then-write loses nothing", async () => {
            const store = await kind.make();
            await store.workspaces.put(workspace("w1"));
            const n = 8;
            await Promise.all(
                Array.from({ length: n }, () =>
                    store.transaction(async (tx) => {
                        const current = await tx.settings.get("w1", null, "counter");
                        await tx.settings.put({
                            workspaceId: "w1",
                            projectId: null,
                            key: "counter",
                            value: ((current?.value as number) ?? 0) + 1,
                        });
                    }),
                ),
            );
            assert.equal((await store.settings.get("w1", null, "counter"))?.value, n);
        });

        test("changing a value read from the store doesn't change what's stored", async () => {
            const store = await kind.make();
            await store.workspaces.put(workspace("w"));
            const w = (await store.workspaces.get("w")) as Workspace;
            try {
                (w as { name: string }).name = "hacked";
            } catch {
                // the memory store hands out frozen copies
            }
            assert.equal((await store.workspaces.get("w"))?.name, "W");
        });
    });
}

test("the memory store hands out frozen values", async () => {
    const store = new MemoryStore();
    await store.workspaces.put(workspace("w"));
    const w = await store.workspaces.get("w");
    assert.throws(() => {
        (w as { name: string }).name = "hacked";
    });
});

describe("postgres transactions", { skip: TEST_DATABASE_URL ? false : "set TRIAGENT_TEST_DATABASE_URL to run against Postgres" }, () => {
    test("a transaction that loses to a concurrent one is run again, and its hooks run once", async () => {
        const store = await postgresStore();
        await store.workspaces.put(workspace("w1"));
        await store.settings.put({ workspaceId: "w1", projectId: null, key: "n", value: 0 });
        let attempts = 0;
        let hooks = 0;
        let readDone!: () => void;
        const read = new Promise<void>((r) => {
            readDone = r;
        });
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const slow = store.transaction(async (tx) => {
            attempts++;
            const current = (await tx.settings.get("w1", null, "n"))?.value as number;
            store.afterCommit(() => hooks++);
            readDone();
            await gate;
            await tx.settings.put({ workspaceId: "w1", projectId: null, key: "n", value: current + 1 });
        });
        await read;
        // Another change to the same value is saved while the first is still deciding.
        await store.transaction(async (tx) => {
            const current = (await tx.settings.get("w1", null, "n"))?.value as number;
            await tx.settings.put({ workspaceId: "w1", projectId: null, key: "n", value: current + 1 });
        });
        release();
        await slow;
        assert.equal(attempts, 2);
        assert.equal(hooks, 1);
        assert.equal((await store.settings.get("w1", null, "n"))?.value, 2);
    });

    test("a transaction gives up after a bounded number of attempts", async () => {
        const store = await postgresStore({ maxAttempts: 3 });
        let attempts = 0;
        const err = await store
            .transaction(async () => {
                attempts++;
                throw new (postgres.PostgresError as unknown as new (x: object) => Error)({ message: "conflict", code: "40001" });
            })
            .catch((e: unknown) => e);
        assert.ok(err instanceof Error);
        assert.equal(attempts, 3);
    });
});
