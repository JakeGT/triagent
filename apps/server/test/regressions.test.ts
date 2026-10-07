// Regression tests for problems found in review of the first version of this server.

import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword } from "../src/security.ts";
import { ADMIN_PASSWORD, report, testApp } from "./helpers.ts";

async function withMember(role: "editor" | "admin") {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "org" } });
    await t.request("/api/v1/w/org/projects", { method: "POST", session: admin, body: { slug: "app" } });
    await t.request("/api/v1/instance/users", { method: "POST", session: admin, body: { username: "bob", password: "temporary-pass-1" } });
    const bob = await t.signIn("bob", "temporary-pass-1");
    await t.request("/api/v1/me/password", {
        method: "POST",
        session: bob,
        body: { current: "temporary-pass-1", password: "his-own-pass-2" },
    });
    await t.request("/api/v1/w/org/settings/members", { method: "POST", session: admin, body: { username: "bob", role } });
    const bobId = (await t.services.store.users.byUsername("bob"))?.id as string;
    return { t, admin, bob, bobId };
}

test("a sign-in that was checking the old password can't bring it back after a change", async () => {
    const t = await testApp();
    const { accounts, store } = t.services;
    const user = await store.users.byUsername("admin");
    assert.ok(user);
    const newHash = await hashPassword("a-brand-new-password");
    // The sign-in reads the account, then spends ~100 ms checking the password; the change lands meanwhile.
    const pending = accounts.signIn("admin", ADMIN_PASSWORD, "10.0.0.1");
    await store.users.put({ ...user, passwordHash: newHash });
    const result = await pending;
    assert.ok("retryAfter" in result, "the sign-in should fail: the password changed while it was being checked");
    assert.equal((await store.users.get(user.id))?.passwordHash, newHash);
});

test("saving notification settings from an old copy of the account keeps a newer password", async () => {
    const t = await testApp();
    const { accounts, store } = t.services;
    const stale = await store.users.byUsername("admin");
    assert.ok(stale);
    const newHash = await hashPassword("a-brand-new-password");
    await store.users.put({ ...stale, passwordHash: newHash });
    await accounts.setNotify(stale, { scope: "all" });
    const now = await store.users.get(stale.id);
    assert.equal(now?.passwordHash, newHash);
    assert.equal(now?.notify.scope, "all");
});

test("removing a member revokes the tokens acting for them and closes their live connections", async () => {
    const { t, admin, bob, bobId } = await withMember("admin");
    const token = (
        await t.request("/api/v1/w/org/settings/tokens", { method: "POST", session: bob, body: { name: "bobs-agent", scope: "full" } })
    ).body.token;
    assert.equal((await t.request("/api/v1/w/org/p/app/issues", { token })).status, 200);
    let closed = 0;
    const org = await t.services.store.workspaces.bySlug("org");
    t.services.events.subscribe({
        workspaceId: org?.id as string,
        userKey: `user:${bobId}`,
        permissions: new Set(["read"]),
        send: () => {},
        close: () => closed++,
    });
    assert.equal((await t.request(`/api/v1/w/org/settings/members/${bobId}`, { method: "DELETE", session: admin })).status, 200);
    assert.equal(closed, 1);
    assert.equal((await t.request("/api/v1/w/org/p/app/issues", { token })).status, 401);
});

test("a note's author is an account or token, not a name: a token named like a person can't edit their notes", async () => {
    const { t, admin } = await withMember("editor");
    await t.request("/api/v1/w/org/p/app/reports", {
        method: "POST",
        session: admin,
        body: { branch: "main", report: report("src/a.ts") },
    });
    const issue = (await t.request("/api/v1/w/org/p/app/issues", { session: admin })).body.items[0];
    await t.request(`/api/v1/w/org/p/app/issues/${issue.id}`, { method: "PATCH", session: admin, body: { note: "Written by the admin." } });
    const note = (await t.request(`/api/v1/w/org/p/app/issues/${issue.id}`, { session: admin })).body.notes[0];
    const impostor = (
        await t.request("/api/v1/w/org/settings/tokens", { method: "POST", session: admin, body: { name: "admin", scope: "write" } })
    ).body.token;
    const res = await t.request(`/api/v1/w/org/p/app/issues/${issue.id}/notes/${note.id}`, {
        method: "PATCH",
        token: impostor,
        body: { text: "Forged." },
    });
    assert.equal(res.status, 403);
});

test("token names are unique in a workspace, ignoring case", async () => {
    const { t, admin } = await withMember("editor");
    assert.equal(
        (await t.request("/api/v1/w/org/settings/tokens", { method: "POST", session: admin, body: { name: "CI", scope: "read" } })).status,
        201,
    );
    assert.equal(
        (await t.request("/api/v1/w/org/settings/tokens", { method: "POST", session: admin, body: { name: "ci", scope: "read" } })).status,
        409,
    );
});

test("a refused upload leaves its link usable; a revoked token's links stop working", async () => {
    const { t, admin } = await withMember("editor");
    const token = (
        await t.request("/api/v1/w/org/settings/tokens", { method: "POST", session: admin, body: { name: "ci", scope: "upload" } })
    ).body.token;
    const link = (await t.request("/api/v1/w/org/p/app/upload-links", { method: "POST", token, body: { branch: "main" } })).body
        .url as string;
    const path = new URL(link).pathname;
    const send = (body: unknown) =>
        t.app.request(`http://triagent.test${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    assert.equal((await send({ not: "a report" })).status, 422);
    assert.equal((await send(report("src/a.ts"))).status, 200);
    assert.equal((await send(report("src/a.ts"))).status, 410);

    const second = (await t.request("/api/v1/w/org/p/app/upload-links", { method: "POST", token, body: { branch: "feature" } })).body
        .url as string;
    const id = (await t.request("/api/v1/w/org/settings/tokens", { session: admin })).body.items.find(
        (x: { name: string }) => x.name === "ci",
    ).id;
    await t.request(`/api/v1/w/org/settings/tokens/${id}`, { method: "DELETE", session: admin });
    const res = await t.app.request(`http://triagent.test${new URL(second).pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report("src/b.ts")),
    });
    assert.equal(res.status, 410);
});

test("an unknown upload link is refused before its body is read", async () => {
    const t = await testApp();
    const res = await t.app.request("http://triagent.test/api/v1/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(30 * 1024 * 1024) },
        body: "{",
    });
    assert.equal(res.status, 410);
});

test("a deleted branch's triage is archived with its report", async () => {
    const { t, admin } = await withMember("editor");
    await t.request("/api/v1/w/org/p/app/reports", { method: "POST", session: admin, body: { branch: "old", report: report("src/a.ts") } });
    const issue = (await t.request("/api/v1/w/org/p/app/issues?branch=old", { session: admin })).body.items[0];
    await t.request(`/api/v1/w/org/p/app/issues/${issue.id}?branch=old`, {
        method: "PATCH",
        session: admin,
        body: { status: "wont_fix", note: "Intended." },
    });
    assert.equal(
        (await t.request("/api/v1/w/org/p/app/branches/delete", { method: "POST", session: admin, body: { branch: "old" } })).status,
        200,
    );
    const project = await t.services.store.projects.bySlug((await t.services.store.workspaces.bySlug("org"))?.id as string, "app");
    const archived = await t.services.store.reports.archived(project?.id as string, "old");
    assert.equal(archived[0]?.triage?.[0]?.status, "wont_fix");
});

test("guessing someone's password from elsewhere doesn't lock them out of where they usually sign in", async () => {
    const t = await testApp();
    const { accounts } = t.services;
    assert.ok("cookie" in (await accounts.signIn("admin", ADMIN_PASSWORD, "192.0.2.1")));
    for (let ip = 0; ip < 25; ip++) for (let i = 0; i < 4; i++) await accounts.signIn("admin", `wrong-${i}`, `198.51.100.${ip}`);
    assert.ok("cookie" in (await accounts.signIn("admin", ADMIN_PASSWORD, "192.0.2.1")), "the usual address still gets in");
    const elsewhere = await accounts.signIn("admin", ADMIN_PASSWORD, "203.0.113.9");
    assert.ok("retryAfter" in elsewhere && elsewhere.retryAfter > 0, "a new address is still throttled");
});

test("read-only access sees whether model keys are set, not their hints", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    await t.request("/api/v1/w/admin/settings/review-model/keys/openrouter", {
        method: "PUT",
        session: admin,
        body: { key: "sk-or-0123456789abcdef" },
    });
    const read = (
        await t.request("/api/v1/w/admin/settings/tokens", { method: "POST", session: admin, body: { name: "reader", scope: "read" } })
    ).body.token;
    const view = await t.request("/api/v1/w/admin/settings/review-model", { token: read });
    const key = view.body.providers.find((p: { id: string }) => p.id === "openrouter").key;
    assert.equal(key.set, true);
    assert.equal(key.hint, null);
    assert.equal(key.setBy, null);
});
