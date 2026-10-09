// An API token acts for a member of its workspace and never has more access than they do: its scope,
// capped by their role now. It can't be made with more, loses what they lose, stops when they leave, and
// one acting for nobody isn't accepted. Nor does it reach their other workspaces, or anything that needs
// a person in the browser.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { before, test } from "node:test";
import { ADMIN_PASSWORD, report, type Session, type TestApp, testApp } from "./helpers.ts";

let t: TestApp;
let admin: Session;
let samId: string;
let sam: Session;

const ok = (r: { status: number; text: string }, status = 200) => assert.equal(r.status, status, r.text);

before(async () => {
    t = await testApp();
    admin = await t.signIn("admin", ADMIN_PASSWORD);
    ok(await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "org" } }), 201);
    ok(await t.request("/api/v1/w/org/projects", { method: "POST", session: admin, body: { slug: "app" } }), 201);
    ok(
        await t.request("/api/v1/w/org/p/app/reports", {
            method: "POST",
            session: admin,
            body: { branch: "main", report: report("src/a.ts") },
        }),
    );
    ok(await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "other" } }), 201);
    ok(await t.request("/api/v1/w/other/projects", { method: "POST", session: admin, body: { slug: "hidden" } }), 201);
    const created = await t.request("/api/v1/instance/users", {
        method: "POST",
        session: admin,
        body: { username: "sam", password: "correct-horse-one" },
    });
    ok(created, 201);
    samId = created.body.user?.id ?? created.body.id;
    sam = await t.signIn("sam", "correct-horse-one");
    ok(
        await t.request("/api/v1/me/password", {
            method: "POST",
            session: sam,
            body: { current: "correct-horse-one", password: "correct-horse-two" },
        }),
    );
    ok(
        await t.request("/api/v1/w/org/settings/members", { method: "POST", session: admin, body: { username: "sam", role: "admin" } }),
        201,
    );
});

const makeToken = (name: string, scope: string, ownerUserId?: string | null) =>
    t.request("/api/v1/w/org/settings/tokens", {
        method: "POST",
        session: admin,
        body: { name, scope, ...(ownerUserId !== undefined ? { ownerUserId } : {}) },
    });
const setRole = (role: string) => t.request(`/api/v1/w/org/settings/members/${samId}`, { method: "PATCH", session: admin, body: { role } });

test("a token can't be made with more access than the member it acts for, nor for nobody", async () => {
    ok(await setRole("editor"));
    const tooMuch = await makeToken("too-much", "manage", samId);
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.text, /role here is editor.*read.*write/);
    ok(await makeToken("sams-write", "write", samId), 201);
    const nobody = await makeToken("nobody", "read", null);
    assert.equal(nobody.status, 400);
    assert.match(nobody.text, /acts for a member/);
    // Handing an existing token to someone with less access is refused the same way.
    const manage = await makeToken("admins-manage", "manage");
    ok(manage, 201);
    const moved = await t.request(`/api/v1/w/org/settings/tokens/${manage.body.record.id}`, {
        method: "PATCH",
        session: admin,
        body: { ownerUserId: samId },
    });
    assert.equal(moved.status, 400, moved.text);
    ok(await setRole("admin"));
});

test("a token loses what its member loses, at once, and stops when they leave", async () => {
    ok(await setRole("admin"));
    const made = await makeToken("sams-manage", "manage", samId);
    ok(made, 201);
    const token = made.body.token as string;
    const configure = () => t.request("/api/v1/w/org/p/app/settings/automation", { method: "PATCH", token, body: { pollMinutes: 5 } });
    ok(await configure());
    const mcpTools = async () =>
        (await t.request("/mcp", { method: "POST", token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).body.result.tools.map(
            (x: { name: string }) => x.name,
        ) as string[];
    assert.ok((await mcpTools()).includes("configure_project"));

    // Sam becomes a viewer: the manage token can only read now, over the API and MCP alike.
    ok(await setRole("viewer"));
    const refused = await configure();
    assert.equal(refused.status, 403);
    assert.match(refused.text, /acts for sam, whose role here is viewer/);
    ok(await t.request("/api/v1/w/org/p/app/issues?branch=main", { token }));
    const issue = (await t.request("/api/v1/w/org/p/app/issues?branch=main", { token })).body.items[0];
    assert.equal(
        (await t.request(`/api/v1/w/org/p/app/issues/${issue.id}?branch=main`, { method: "PATCH", token, body: { status: "resolved" } }))
            .status,
        403,
    );
    const tools = await mcpTools();
    assert.ok(tools.includes("list_issues"));
    assert.ok(!tools.includes("update_issue") && !tools.includes("configure_project") && !tools.includes("claim_next_issue"));

    // And back: the token's own scope is the ceiling again.
    ok(await setRole("admin"));
    ok(await configure());

    // An upload link made with the token stops working when Sam can no longer upload.
    const link = (await t.request("/api/v1/w/org/p/app/upload-links", { method: "POST", token, body: { branch: "main" } })).body
        .url as string;
    ok(await setRole("viewer"));
    const sent = await t.app.request(`http://triagent.test${new URL(link).pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report("src/b.ts")),
    });
    assert.equal(sent.status, 410);

    // Sam leaves: the token is gone.
    ok(await t.request(`/api/v1/w/org/settings/members/${samId}`, { method: "DELETE", session: admin }));
    assert.equal((await t.request("/api/v1/w/org/projects", { token })).status, 401);
    ok(
        await t.request("/api/v1/w/org/settings/members", { method: "POST", session: admin, body: { username: "sam", role: "admin" } }),
        201,
    );
});

test("a token acting for nobody (made before every token had to) isn't accepted", async () => {
    const raw = `tri_${randomBytes(32).toString("base64url")}`;
    const workspace = await t.services.store.workspaces.bySlug("org");
    await t.services.store.tokens.put({
        id: "legacy0token",
        workspaceId: workspace?.id as string,
        ownerUserId: null,
        name: "legacy",
        scope: "manage",
        hash: createHash("sha256").update(raw).digest("hex"),
        prefix: raw.slice(0, 10),
        createdAt: new Date().toISOString(),
        createdBy: "admin",
        expiresAt: null,
        lastUsedAt: null,
    });
    const res = await t.request("/api/v1/w/org/projects", { token: raw });
    assert.equal(res.status, 401);
    assert.match(res.text, /no longer a member|Invalid/);
});

test("a token reaches only its own workspace, even where its member belongs to others, and nothing browser-only", async () => {
    const made = await makeToken("admins-read", "read");
    ok(made, 201);
    const token = made.body.token as string;
    // The admin owns "other" too; the token for "org" still can't see it.
    assert.equal((await t.request("/api/v1/w/other/projects", { token })).status, 404);
    assert.equal((await t.request("/api/v1/w/other/p/hidden/issues", { token })).status, 404);
    assert.deepEqual(
        (await t.request("/api/v1/workspaces", { token })).body.items.map((w: { slug: string }) => w.slug),
        ["org"],
    );
    // People, tokens, secrets, the instance: never through a token, whatever its scope.
    for (const [method, path] of [
        ["GET", "/api/v1/w/org/settings/tokens"],
        ["POST", "/api/v1/w/org/settings/tokens"],
        ["POST", "/api/v1/w/org/settings/members"],
        ["GET", "/api/v1/instance/users"],
        ["POST", "/api/v1/workspaces"],
        ["PUT", "/api/v1/w/org/settings/review-model/keys/openrouter"],
    ] as const) {
        const res = await t.request(path, { method, token, ...(method === "GET" ? {} : { body: {} }) });
        assert.ok([401, 403].includes(res.status), `${method} ${path}: ${res.status}`);
    }
});

test("changing a member's role closes their tokens' live streams too, so they reconnect with the new access", async () => {
    ok(await setRole("admin"));
    const made = await makeToken("sams-stream", "full", samId);
    ok(made, 201);
    const closed: string[] = [];
    const original = t.services.events.disconnect.bind(t.services.events);
    t.services.events.disconnect = (key: string, workspaceId?: string) => {
        closed.push(key);
        original(key, workspaceId);
    };
    try {
        ok(await setRole("editor"));
        assert.ok(closed.includes(`user:${samId}`));
        assert.ok(closed.includes(`token:${made.body.record.id}`));
        // And the stream's own check sees the token as it is now.
        const now = await t.services.accounts.tokenNow(made.body.record.id);
        assert.equal(now?.kind === "token" ? now.role : null, "editor");
    } finally {
        t.services.events.disconnect = original;
        ok(await setRole("admin"));
    }
});
