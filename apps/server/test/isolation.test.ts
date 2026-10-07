// Workspaces never see each other: every route, called with another workspace's ids, fails, whether the
// caller is a member elsewhere or holds a token for another workspace. Live events stay in their workspace.

import assert from "node:assert/strict";
import { before, test } from "node:test";
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
