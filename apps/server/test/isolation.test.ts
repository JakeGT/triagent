// Workspaces never see each other: every route, called with another workspace's ids, fails, whether the
// caller is a member elsewhere or holds a token for another workspace. Live events stay in their workspace.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { MAX_BATCH } from "../src/mcp/server.ts";
import { EventBus, type LiveEvent } from "../src/services/events.ts";
import type { ActivityRow } from "../src/store/types.ts";
import { ADMIN_PASSWORD, report, type Session, type TestApp, testApp } from "./helpers.ts";

let t: TestApp;
let outsider: Session;
let outsiderToken: string;
let issueId: string;

before(async () => {
    t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    // The admin owns "victim", with a project, a report and secrets.
    assert.equal((await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "victim" } })).status, 201);
    assert.equal(
        (await t.request("/api/v1/w/victim/projects", { method: "POST", session: admin, body: { slug: "secret-app" } })).status,
        201,
    );
    assert.equal(
        (
            await t.request("/api/v1/w/victim/p/secret-app/reports", {
                method: "POST",
                session: admin,
                body: { branch: "main", report: report("src/a.ts") },
            })
        ).status,
        200,
    );
    issueId = (await t.request("/api/v1/w/victim/p/secret-app/issues", { session: admin })).body.items[0].id;

    // Someone else, with their own organisation and a manage token for it.
    const created = await t.request("/api/v1/instance/users", {
        method: "POST",
        session: admin,
        body: { username: "mallory", password: "hunter2-hunter2-one" },
    });
    assert.equal(created.status, 201);
    outsider = await t.signIn("mallory", "hunter2-hunter2-one");
    assert.equal(
        (
            await t.request("/api/v1/me/password", {
                method: "POST",
                session: outsider,
                body: { current: "hunter2-hunter2-one", password: "hunter2-hunter2-two" },
            })
        ).status,
        200,
    );
    assert.equal((await t.request("/api/v1/workspaces", { method: "POST", session: outsider, body: { slug: "mallory-org" } })).status, 201);
    const token = await t.request("/api/v1/w/mallory-org/settings/tokens", {
        method: "POST",
        session: outsider,
        body: { name: "m", scope: "manage" },
    });
    assert.equal(token.status, 201);
    outsiderToken = token.body.token;
});

function concrete(path: string): string {
    return path
        .replace("{workspace}", "victim")
        .replace("{project}", "secret-app")
        .replace("{id}", issueId)
        .replace(/\{\w+\}/g, "x");
}

test("no workspace or project route works for an outsider, with a session or a token", async () => {
    const scoped = t.routes.filter((r) => r.scope === "workspace" || r.scope === "project");
    assert.ok(scoped.length > 30);
    for (const r of scoped) {
        const path = `${concrete(r.path)}?branch=main`;
        const body = r.method === "GET" ? undefined : {};
        for (const [who, auth] of [
            ["session", { session: outsider }],
            ["token", { token: outsiderToken }],
        ] as const) {
            const res = await t.request(path, { method: r.method, body, ...auth });
            assert.ok(
                res.status === 404 || res.status === 403,
                `${who}: ${r.method} ${r.path} answered ${res.status}: ${res.text.slice(0, 200)}`,
            );
            assert.ok(!res.text.includes("secret-app") || res.status === 404, `${who}: ${r.method} ${r.path} leaked the project`);
            assert.ok(!res.text.includes(issueId), `${who}: ${r.method} ${r.path} leaked an issue id`);
        }
    }
});

test("the same paths work for the workspace's owner (so the refusals above aren't just bad paths)", async () => {
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const reads = t.routes.filter(
        (r) =>
            (r.scope === "workspace" || r.scope === "project") &&
            r.method === "GET" &&
            !/\{(?!workspace|project|id\})\w+\}/.test(r.path) &&
            r.produces !== "event-stream",
    );
    assert.ok(reads.length > 15);
    for (const r of reads) {
        const res = await t.request(`${concrete(r.path)}?branch=main&head=main`, { session: admin });
        assert.ok(
            res.status === 200 ||
                (r.path.includes("compare") && res.status === 400) ||
                (r.path.includes("/tasks/{id}") && /No task/.test(res.text)),
            `${r.method} ${r.path} answered ${res.status} for its owner: ${res.text.slice(0, 200)}`,
        );
    }
});

test("the MCP endpoint only reaches the token's own workspace", async () => {
    const res = await t.request("/mcp", {
        method: "POST",
        token: outsiderToken,
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_issues", arguments: { project: "secret-app" } } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, true);
    assert.ok(!res.text.includes(issueId));
});

test("an MCP batch is answered in order, and a huge one is refused", async () => {
    const ping = (id: number) => ({ jsonrpc: "2.0", id, method: "ping" });
    const ok = await t.request("/mcp", { method: "POST", token: outsiderToken, body: [ping(1), ping(2), ping(3)] });
    assert.equal(ok.status, 200);
    assert.deepEqual(
        ok.body.map((r: { id: number }) => r.id),
        [1, 2, 3],
    );
    // Notifications get no reply, not even for a method that doesn't exist.
    const quiet = await t.request("/mcp", { method: "POST", token: outsiderToken, body: { jsonrpc: "2.0", method: "no/such" } });
    assert.equal(quiet.status, 202);
    const big = await t.request("/mcp", {
        method: "POST",
        token: outsiderToken,
        body: Array.from({ length: MAX_BATCH + 1 }, (_, i) => ping(i)),
    });
    assert.equal(big.status, 400);
    assert.equal(big.body.error.code, -32600);
});

test("live events only reach subscribers in the same workspace, and admin-only kinds only reach admins", () => {
    const bus = new EventBus();
    const got: Record<string, LiveEvent[]> = { a: [], b: [], viewer: [] };
    bus.subscribe({
        workspaceId: "A",
        userKey: "a",
        permissions: new Set(["read", "members"]),
        send: (e) => got.a?.push(e),
        close: () => {},
    });
    bus.subscribe({
        workspaceId: "B",
        userKey: "b",
        permissions: new Set(["read", "members"]),
        send: (e) => got.b?.push(e),
        close: () => {},
    });
    bus.subscribe({
        workspaceId: "A",
        userKey: "viewer",
        permissions: new Set(["read"]),
        send: (e) => got.viewer?.push(e),
        close: () => {},
    });
    const row = (kind: string): ActivityRow => ({
        id: "1",
        workspaceId: "A",
        projectId: null,
        branch: null,
        at: "",
        actor: "x",
        actorUserId: null,
        via: "web",
        kind,
        itemId: "i",
        changes: {},
    });
    bus.publish(row("issue"), "p");
    bus.publish(row("member"), null);
    assert.equal(got.a?.length, 2);
    assert.equal(got.b?.length, 0);
    assert.equal(got.viewer?.length, 1);
});

test("another workspace's runs, installations, invites and projects can't be reached through your own workspace's paths", async () => {
    const { reviewEnv, patProject, PAT } = await import("./review-helpers.ts");
    const { specForBranch } = await import("../src/services/runs.ts");
    const env = await reviewEnv();
    try {
        // The admin belongs to both, so every refusal below is about the ids, not who's asking.
        await patProject(env, "victim");
        await patProject(env, "attacker", { token: PAT(9) });
        const s = env.t.services;
        const victim = await s.store.workspaces.bySlug("victim");
        const project = await s.store.projects.bySlug(victim?.id as string, "app");
        assert.ok(victim && project);
        const job = await s.runs.enqueue({ name: "admin", userId: null, via: "web" }, project, specForBranch("full", "main", null));
        await s.store.githubInstallations.put({
            id: 4242,
            workspaceId: victim.id,
            accountLogin: "victim",
            accountType: "Organization",
            repositorySelection: "all",
            suspended: false,
            linkedBy: "admin",
            linkedAt: new Date().toISOString(),
        });
        // Invites are for AUTH_MODE=oidc; one is put straight into the store here.
        const inviteId = "inv-victim-1";
        await s.store.invites.put({
            id: inviteId,
            email: "someone@example.com",
            workspaceId: victim.id,
            role: "editor",
            createdBy: null,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            acceptedAt: null,
            acceptedBy: null,
        });
        const tries: [string, string, object?][] = [
            ["GET", `/api/v1/w/attacker/runs/${job.id}`],
            ["POST", `/api/v1/w/attacker/runs/${job.id}/cancel`, {}],
            ["DELETE", "/api/v1/w/attacker/github/installations/4242"],
            ["PUT", "/api/v1/w/attacker/p/app/settings/github/repository", { installationId: 4242, repositoryId: 1 }],
            ["DELETE", `/api/v1/w/attacker/settings/invites/${inviteId}`],
            ["GET", `/api/v1/w/attacker/analytics?project=${project.id}`],
        ];
        for (const [method, path, body] of tries) {
            const r = await env.t.request(path, { method, session: env.admin, ...(body ? { body } : {}) });
            assert.equal(r.status, 404, `${method} ${path}: ${r.status} ${r.text.slice(0, 200)}`);
        }
        assert.equal((await s.store.jobs.get(job.id))?.status, "queued");
        assert.ok(await s.store.githubInstallations.get(4242));
        assert.ok(await s.store.invites.get(inviteId));
    } finally {
        await env.close();
    }
});
