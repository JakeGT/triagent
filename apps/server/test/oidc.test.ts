// Signing in through an identity provider (AUTH_MODE=oidc), against the fake provider in fake-oidc.ts:
// the flow and its checks, who may get an account, invites, admin rights from a group, and signing out.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { safeNext } from "../src/services/oidc.ts";
import { ORIGIN, testApp } from "./helpers.ts";
import { ISSUER, oidcTestApp } from "./oidc-helpers.ts";

const admin = { sub: "admin-sub", email: "admin@example.com", email_verified: true, name: "Ada Admin", groups: ["platform-admin"] };
const kim = { sub: "kim-sub", email: "kim@example.com", email_verified: true, name: "Kim" };

test("the whole flow: PKCE, state and nonce out; a verified ID token back; an account, a session and the way back", async () => {
    const t = await oidcTestApp();
    const start = await t.request("/auth/login?next=%2Fw%2Fsomewhere%3Fbranch%3Dmain");
    assert.equal(start.status, 302);
    const authorize = new URL(start.location as string);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${ISSUER}authorize`);
    const q = authorize.searchParams;
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("client_id"), "triagent");
    assert.equal(q.get("redirect_uri"), `${ORIGIN}/auth/callback`);
    assert.equal(q.get("scope"), "openid email profile");
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.match(q.get("code_challenge") ?? "", /^[\w-]{43}$/);
    assert.ok((q.get("state") ?? "").length >= 20);
    assert.ok((q.get("nonce") ?? "").length >= 20);
    // The attempt is remembered in a short-lived cookie the browser can't read (it's encrypted).
    const setCookie = (await t.app.request(`${ORIGIN}/auth/login`)).headers.getSetCookie().join("\n");
    assert.match(setCookie, /triagent_oidc=[\w-]+; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax/);
    const sealed = start.cookies.triagent_oidc as string;
    for (const secret of [q.get("state"), q.get("nonce")])
        assert.ok(
            !Buffer.from(sealed, "base64url")
                .toString("latin1")
                .includes(secret as string),
        );

    const done = await t.signIn(admin, { next: "/w/somewhere?branch=main" });
    assert.equal(done.location, "/w/somewhere?branch=main");
    assert.ok(done.session);
    const me = await t.request("/api/v1/me", { session: done.session });
    assert.equal(me.status, 200);
    assert.equal(me.body.authMode, "oidc");
    assert.equal(me.body.user.displayName, "Ada Admin");
    assert.equal(me.body.user.email, "admin@example.com");
    assert.equal(me.body.user.username, null);
    assert.equal(me.body.user.isInstanceAdmin, true);
    assert.equal(me.body.workspaces.length, 1);
    assert.equal(me.body.workspaces[0].kind, "personal");
    assert.ok(!me.text.includes(t.provider.issued.at(-1) as string), "the ID token is never sent to the browser");
    const user = await t.services.store.users.byIdentity(ISSUER, "admin-sub");
    assert.equal(user?.id, me.body.user.id);
    const session = (await t.services.store.sessions.listForUser(user?.id as string))[0];
    assert.ok(session && Math.abs(session.authAt - Date.now()) < 5000);
});

test("the login state cookie is __Host- and Secure when cookies are secure", async () => {
    const t = await oidcTestApp({ COOKIE_SECURE: "true" });
    const res = await t.app.request(`${ORIGIN}/auth/login`);
    assert.equal(res.status, 302);
    assert.match(
        res.headers.getSetCookie().join("\n"),
        /^__Host-triagent_oidc=[\w-]+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/m,
    );
});

test("a state, nonce or PKCE mismatch, or a missing or altered state cookie, signs no one in", async () => {
    const t = await oidcTestApp();
    const refused = (location: string | null, reason: string) => assert.equal(location, `/sign-in?error=${reason}`);

    let r = await t.signIn(admin, { tamper: { state: "someone-elses-state" } });
    refused(r.location, "failed");
    assert.equal(r.session, null);

    r = await t.signIn(admin, { tamper: { nonce: "another-nonce" } });
    refused(r.location, "failed");
    assert.equal(r.session, null);

    // A code issued for someone else's PKCE challenge (code injection) is refused by the token endpoint.
    r = await t.signIn(admin, { editAuthorize: (u) => u.searchParams.set("code_challenge", "A".repeat(43)) });
    refused(r.location, "failed");
    assert.equal(r.session, null);

    // No cookie (another browser, or too slow), or one that's been altered.
    const start = await t.request("/auth/login");
    const back = new URL((await t.provider.fetch(start.location as string)).headers.get("location") as string);
    refused((await t.request(`/auth/callback${back.search}`)).location, "expired");
    const sealed = start.cookies.triagent_oidc as string;
    const altered = `${sealed.slice(0, 20)}${sealed[20] === "A" ? "B" : "A"}${sealed.slice(21)}`;
    refused((await t.request(`/auth/callback${back.search}`, { cookies: { triagent_oidc: altered } })).location, "expired");
    // The cookie is used once: replaying the callback doesn't work either.
    const once = await t.request(`/auth/callback${back.search}`, { cookies: { triagent_oidc: sealed } });
    assert.equal(once.location, "/");
    assert.equal(once.cookies.triagent_oidc, "");
    refused((await t.request(`/auth/callback${back.search}`, { cookies: { triagent_oidc: sealed } })).location, "failed");
    assert.equal(await t.services.store.users.count(), 1);
});

test("ID tokens with the wrong audience, issuer or azp, expired, or badly signed are refused", async () => {
    const t = await oidcTestApp();
    for (const tamper of [
        { aud: "some-other-client" },
        { aud: ["triagent", "another"], azp: "another" },
        { azp: "another" },
        { iss: "https://evil.example/" },
        { expiresIn: -120 },
        { badSignature: true },
    ]) {
        const r = await t.signIn(admin, { tamper });
        assert.equal(r.location, "/sign-in?error=failed", JSON.stringify(tamper));
        assert.equal(r.session, null);
    }
    assert.equal(await t.services.store.users.count(), 0);
    // The same identity, untampered, is fine.
    assert.ok((await t.signIn(admin)).session);
});

test("the provider refusing, or being unreachable, ends on the sign-in page with a reason", async () => {
    const t = await oidcTestApp();
    assert.equal((await t.signIn(null)).location, "/sign-in?error=denied");
    const services = t.services;
    (services.oidc as NonNullable<typeof services.oidc>).fetch = async () => {
        throw new TypeError("fetch failed");
    };
    // Discovery happened already; a fresh app discovers on first use.
    const fresh = await oidcTestApp();
    (fresh.services.oidc as NonNullable<typeof services.oidc>).fetch = async () => {
        throw new TypeError("fetch failed");
    };
    const res = await fresh.request("/auth/login");
    assert.equal(res.status, 302);
    assert.equal(res.location, "/sign-in?error=unavailable");
    assert.ok(!res.text.includes("fetch failed"));
});

test("next must be a path on this site", async () => {
    for (const bad of [
        "//evil.example/x",
        "https://evil.example/",
        "/\\evil.example",
        "\\\\evil.example",
        "javascript:alert(1)",
        "evil.example",
        "/ok\u0000",
        "/\t/evil.example",
        "",
    ])
        assert.equal(safeNext(bad), "/", JSON.stringify(bad));
    assert.equal(safeNext("/w/acme/p/app/issues?branch=main#x"), "/w/acme/p/app/issues?branch=main#x");
    assert.equal(safeNext("/%2F%2Fevil.example"), "/%2F%2Fevil.example");

    const t = await oidcTestApp();
    for (const next of ["//evil.example/", "https://evil.example/"]) {
        const r = await t.signIn(admin, { next });
        assert.equal(r.location, "/");
    }
    assert.equal((await t.signIn(admin, { next: "/w/x/settings" })).location, "/w/x/settings");
});

test("with invite-only sign-up, someone without an invite gets nothing", async () => {
    const t = await oidcTestApp({ INVITE_HINT: "Ask Jake to add your Google address." });
    // The very first account is allowed (here not an admin), so there's someone to start with.
    assert.ok((await t.signIn({ sub: "first", email: "first@example.com", email_verified: true })).session);
    const before = (await t.services.store.workspaces.list()).length;
    const r = await t.signIn(kim);
    assert.equal(r.location, "/invite-required");
    assert.equal(r.session, null);
    assert.equal(await t.services.store.users.count(), 1);
    assert.equal(await t.services.store.users.byIdentity(ISSUER, "kim-sub"), null);
    assert.equal((await t.services.store.workspaces.list()).length, before);
    const config = await t.request("/auth/config");
    assert.deepEqual(config.body, {
        mode: "oidc",
        providerName: "Test ID",
        inviteHint: "Ask Jake to add your Google address.",
        signupMode: "invite",
    });
    // Members of the admin group never need one.
    assert.ok((await t.signIn(admin)).session);
});

test("with open sign-up, anyone the provider lets in gets an account", async () => {
    const t = await oidcTestApp({ SIGNUP_MODE: "open" });
    assert.ok((await t.signIn({ sub: "first" })).session);
    const r = await t.signIn(kim);
    assert.ok(r.session);
    assert.equal(await t.services.store.users.count(), 2);
});

test("an instance invite lets someone in; a workspace invite also adds them with its role", async () => {
    const t = await oidcTestApp({ INVITE_HINT: "Ask to be added to the allowlist." });
    const a = (await t.signIn(admin)).session as NonNullable<Awaited<ReturnType<typeof t.signIn>>["session"]>;
    const created = await t.request("/api/v1/instance/invites", { method: "POST", session: a, body: { email: " Kim@Example.com " } });
    assert.equal(created.status, 201);
    assert.equal(created.body.invite.email, "kim@example.com");
    assert.equal(created.body.invite.status, "pending");
    assert.equal(created.body.hint, "Ask to be added to the allowlist.");
    assert.equal(
        (await t.request("/api/v1/instance/invites", { method: "POST", session: a, body: { email: "kim@example.com" } })).status,
        409,
    );

    assert.equal((await t.request("/api/v1/workspaces", { method: "POST", session: a, body: { slug: "acme" } })).status, 201);
    const ws = await t.request("/api/v1/w/acme/settings/invites", {
        method: "POST",
        session: a,
        body: { email: "lee@example.com", role: "viewer" },
    });
    assert.equal(ws.status, 201);
    assert.equal(ws.body.invite.role, "viewer");
    // Kim also gets a workspace invite: both are accepted at once.
    assert.equal(
        (
            await t.request("/api/v1/w/acme/settings/invites", {
                method: "POST",
                session: a,
                body: { email: "kim@example.com", role: "editor" },
            })
        ).status,
        201,
    );

    const k = (await t.signIn(kim)).session;
    assert.ok(k);
    const kimMe = await t.request("/api/v1/me", { session: k });
    assert.deepEqual(kimMe.body.workspaces.map((w: { kind: string; slug: string; role: string }) => [w.kind, w.slug, w.role]).sort(), [
        ["org", "acme", "editor"],
        ["personal", "kim", "owner"],
    ]);
    const lee = await t.signIn({ sub: "lee-sub", email: "lee@example.com", email_verified: true, preferred_username: "lee" });
    assert.ok(lee.session);
    const members = await t.request("/api/v1/w/acme/settings/members", { session: a });
    assert.deepEqual(members.body.items.map((m: { role: string }) => m.role).sort(), ["editor", "owner", "viewer"]);

    const list = await t.request("/api/v1/instance/invites", { session: a });
    assert.equal(list.body.items[0].status, "accepted");
    assert.equal(list.body.items[0].acceptedBy.displayName, "Kim");
    const wsList = await t.request("/api/v1/w/acme/settings/invites", { session: a });
    assert.deepEqual(
        wsList.body.items.map((i: { status: string }) => i.status),
        ["accepted", "accepted"],
    );

    // An accepted invite can't be used again or revoked; the audit logs record it all.
    assert.equal((await t.request(`/api/v1/instance/invites/${list.body.items[0].id}`, { method: "DELETE", session: a })).status, 400);
    const audit = await t.request("/api/v1/w/acme/settings/audit", { session: a });
    const kinds = audit.body.items.map((r: { kind: string; changes: Record<string, unknown> }) => `${r.kind}:${Object.keys(r.changes)[0]}`);
    assert.ok(kinds.includes("invite:created") && kinds.includes("invite:accepted") && kinds.includes("member:added"), kinds.join());
});

test("an invite already sent to someone with an account adds them the next time they sign in", async () => {
    const t = await oidcTestApp();
    const a = (await t.signIn(admin)).session as NonNullable<Awaited<ReturnType<typeof t.signIn>>["session"]>;
    await t.request("/api/v1/instance/invites", { method: "POST", session: a, body: { email: "kim@example.com" } });
    await t.signIn(kim);
    await t.request("/api/v1/workspaces", { method: "POST", session: a, body: { slug: "later" } });
    await t.request("/api/v1/w/later/settings/invites", { method: "POST", session: a, body: { email: "kim@example.com", role: "admin" } });
    const again = (await t.signIn(kim)).session;
    const me = await t.request("/api/v1/me", { session: again ?? undefined });
    assert.ok(me.body.workspaces.some((w: { slug: string; role: string }) => w.slug === "later" && w.role === "admin"));
});

test("invites: revoking, expiry, who may send them, and isolation", async () => {
    const t = await oidcTestApp();
    const a = (await t.signIn(admin)).session as NonNullable<Awaited<ReturnType<typeof t.signIn>>["session"]>;
    await t.request("/api/v1/instance/invites", { method: "POST", session: a, body: { email: "kim@example.com" } });
    const k = (await t.signIn(kim)).session as NonNullable<Awaited<ReturnType<typeof t.signIn>>["session"]>;

    // Not an instance admin.
    assert.equal((await t.request("/api/v1/instance/invites", { session: k })).status, 403);
    assert.equal(
        (await t.request("/api/v1/instance/invites", { method: "POST", session: k, body: { email: "x@example.com" } })).status,
        403,
    );
    // Personal workspaces have one member.
    assert.equal(
        (await t.request("/api/v1/w/kim/settings/invites", { method: "POST", session: k, body: { email: "x@example.com" } })).status,
        400,
    );

    await t.request("/api/v1/workspaces", { method: "POST", session: a, body: { slug: "acme" } });
    await t.request("/api/v1/workspaces", { method: "POST", session: k, body: { slug: "kims-org" } });
    const inv = await t.request("/api/v1/w/acme/settings/invites", { method: "POST", session: a, body: { email: "pat@example.com" } });
    assert.equal(inv.body.invite.role, "editor");
    assert.equal(
        (await t.request("/api/v1/w/acme/settings/invites", { method: "POST", session: a, body: { email: "not an address" } })).status,
        400,
    );
    // Kim can't see or revoke acme's invites, from acme (404) or from her own workspace (404).
    assert.equal((await t.request("/api/v1/w/acme/settings/invites", { session: k })).status, 404);
    assert.equal(
        (await t.request(`/api/v1/w/kims-org/settings/invites/${inv.body.invite.id}`, { method: "DELETE", session: k })).status,
        404,
    );
    // Only owners invite owners.
    await t.request("/api/v1/w/acme/settings/invites", { method: "POST", session: a, body: { email: "kim@example.com", role: "admin" } });
    const kimAgain = (await t.signIn(kim)).session as NonNullable<Awaited<ReturnType<typeof t.signIn>>["session"]>;
    assert.equal(
        (
            await t.request("/api/v1/w/acme/settings/invites", {
                method: "POST",
                session: kimAgain,
                body: { email: "o@example.com", role: "owner" },
            })
        ).status,
        400,
    );

    // Revoked: Pat can't get in.
    assert.equal((await t.request(`/api/v1/w/acme/settings/invites/${inv.body.invite.id}`, { method: "DELETE", session: a })).status, 200);
    assert.equal((await t.signIn({ sub: "pat", email: "pat@example.com", email_verified: true })).location, "/invite-required");
    // Expired: neither.
    const again = await t.request("/api/v1/w/acme/settings/invites", { method: "POST", session: a, body: { email: "pat@example.com" } });
    const stored = await t.services.store.invites.get(again.body.invite.id);
    await t.services.store.invites.put({ ...(stored as NonNullable<typeof stored>), expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await t.signIn({ sub: "pat", email: "pat@example.com", email_verified: true })).location, "/invite-required");
    const listed = await t.request("/api/v1/w/acme/settings/invites", { session: a });
    assert.equal(listed.body.items[0].status, "expired");
    // An expired one makes way for a new one.
    assert.equal(
        (await t.request("/api/v1/w/acme/settings/invites", { method: "POST", session: a, body: { email: "pat@example.com" } })).status,
        201,
    );
    const audit = await t.request("/api/v1/w/acme/settings/audit", { session: a });
    assert.ok(audit.body.items.some((r: { kind: string; changes: { revoked?: unknown } }) => r.kind === "invite" && r.changes.revoked));
});

test("invites match only a verified email address, unless the provider's addresses are trusted", async () => {
    for (const trust of [false, true]) {
        const t = await oidcTestApp(trust ? { OIDC_TRUST_EMAIL: "true" } : {});
        const a = (await t.signIn(admin)).session as NonNullable<Awaited<ReturnType<typeof t.signIn>>["session"]>;
        await t.request("/api/v1/instance/invites", { method: "POST", session: a, body: { email: "pat@example.com" } });
        await t.request("/api/v1/instance/invites", { method: "POST", session: a, body: { email: "lou@example.com" } });
        // Said to be unverified, or not said either way (Authentik often leaves it out): only when trusted.
        for (const who of [
            { sub: "pat", email: "pat@example.com", email_verified: false },
            { sub: "lou", email: "lou@example.com" },
        ]) {
            const r = await t.signIn(who);
            if (trust) {
                assert.ok(r.session, who.sub);
                assert.equal((await t.request("/api/v1/me", { session: r.session })).body.user.email, who.email);
            } else {
                assert.equal(r.location, "/invite-required", who.sub);
            }
        }
    }
    // Verified addresses always count.
    const t = await oidcTestApp();
    const a = (await t.signIn(admin)).session as NonNullable<Awaited<ReturnType<typeof t.signIn>>["session"]>;
    await t.request("/api/v1/instance/invites", { method: "POST", session: a, body: { email: "pat@example.com" } });
    assert.ok((await t.signIn({ sub: "pat", email: "pat@example.com", email_verified: true })).session);
});

test("admin rights follow the admin group on every sign-in", async () => {
    const t = await oidcTestApp({ OIDC_ADMIN_GROUP: "triagent-admins", SIGNUP_MODE: "open" });
    const first = await t.signIn({ ...kim, groups: ["platform-admin"] });
    assert.equal((await t.request("/api/v1/me", { session: first.session ?? undefined })).body.user.isInstanceAdmin, false);
    const granted = await t.signIn({ ...kim, groups: ["app-users", "triagent-admins"] });
    assert.equal((await t.request("/api/v1/me", { session: granted.session ?? undefined })).body.user.isInstanceAdmin, true);
    assert.equal((await t.request("/api/v1/instance/users", { session: granted.session ?? undefined })).status, 200);
    const removed = await t.signIn({ ...kim, groups: ["app-users"] });
    assert.equal((await t.request("/api/v1/me", { session: removed.session ?? undefined })).body.user.isInstanceAdmin, false);
    assert.equal((await t.request("/api/v1/instance/users", { session: removed.session ?? undefined })).status, 403);
    const audit = await t.services.store.audit.list({ workspaceId: null }, { limit: 50 });
    assert.equal(audit.filter((r) => r.kind === "user" && "isInstanceAdmin" in r.changes).length, 2);
});

test("accounts are found by the provider's subject, never by email", async () => {
    const t = await oidcTestApp();
    const a = (await t.signIn(admin)).session as NonNullable<Awaited<ReturnType<typeof t.signIn>>["session"]>;
    const id = (await t.request("/api/v1/me", { session: a })).body.user.id;
    // A changed email address and name: the same account, updated.
    const moved = await t.signIn({ ...admin, email: "ada@new.example", name: "Ada Lovelace" });
    const me = await t.request("/api/v1/me", { session: moved.session ?? undefined });
    assert.equal(me.body.user.id, id);
    assert.equal(me.body.user.email, "ada@new.example");
    assert.equal(me.body.user.displayName, "Ada Lovelace");
    // Someone else claiming that address isn't let into the account (and, without an invite, gets nothing).
    const impostor = await t.signIn({ sub: "someone-else", email: "ada@new.example", email_verified: true });
    assert.equal(impostor.location, "/invite-required");
    assert.equal(await t.services.store.users.count(), 1);
    // With an invite for that address they get an account of their own, not Ada's.
    await t.request("/api/v1/instance/invites", { method: "POST", session: a, body: { email: "ada@new.example" } });
    const own = await t.signIn({ sub: "someone-else", email: "ada@new.example", email_verified: true });
    const theirs = await t.request("/api/v1/me", { session: own.session ?? undefined });
    assert.notEqual(theirs.body.user.id, id);
    assert.equal(theirs.body.user.isInstanceAdmin, false);
});

test("password sign-in, password changes and resets are refused with an identity provider", async () => {
    const t = await oidcTestApp();
    const a = (await t.signIn(admin)).session as NonNullable<Awaited<ReturnType<typeof t.signIn>>["session"]>;
    const id = (await t.request("/api/v1/me", { session: a })).body.user.id;
    const login = await t.request("/auth/login", {
        method: "POST",
        body: { username: "admin", password: "x".repeat(20) },
        headers: { origin: ORIGIN },
    });
    assert.equal(login.status, 404);
    assert.match(login.body.error, /Test ID/);
    assert.equal(
        (await t.request("/api/v1/me/password", { method: "POST", session: a, body: { current: "a", password: "b" } })).status,
        404,
    );
    assert.equal((await t.request("/api/v1/instance/users", { method: "POST", session: a, body: { username: "bob" } })).status, 404);
    assert.equal((await t.request(`/api/v1/instance/users/${id}/password`, { method: "POST", session: a, body: {} })).status, 404);
    assert.equal((await t.request("/auth/reauth", { method: "POST", session: a, body: { password: "whatever" } })).status, 404);
    const users = await t.request("/api/v1/instance/users", { session: a });
    assert.equal(users.body.items[0].signsInWith, "provider");
});

test("local mode is unchanged: no provider routes, and invites add existing accounts by username", async () => {
    const t = await testApp();
    assert.equal((await t.request("/auth/login")).status, 404);
    assert.equal((await t.request("/auth/callback?code=x&state=y")).status, 404);
    assert.deepEqual((await t.request("/auth/config")).body, { mode: "local", providerName: null, inviteHint: null, signupMode: "invite" });
    const a = await t.signIn("admin", "correct-horse-battery-staple");
    await t.request("/api/v1/instance/users", {
        method: "POST",
        session: a,
        body: { username: "bob", password: "a-long-enough-password" },
    });
    await t.request("/api/v1/workspaces", { method: "POST", session: a, body: { slug: "acme" } });
    const added = await t.request("/api/v1/w/acme/settings/invites", {
        method: "POST",
        session: a,
        body: { username: "bob", role: "viewer" },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.member.role, "viewer");
    const email = await t.request("/api/v1/w/acme/settings/invites", { method: "POST", session: a, body: { email: "bob@example.com" } });
    assert.equal(email.status, 400);
    assert.equal(
        (await t.request("/api/v1/instance/invites", { method: "POST", session: a, body: { email: "bob@example.com" } })).status,
        400,
    );
    const out = await t.request("/auth/logout", { method: "POST", session: a, body: {} });
    assert.deepEqual(out.body, { ok: true, redirect: null });
});

test("a session from the other mode stops working when the mode changes", async () => {
    const local = await testApp();
    const session = await local.signIn("admin", "correct-horse-battery-staple");
    const oidc = await oidcTestApp({}, local.services.store);
    assert.equal((await oidc.request("/api/v1/me", { session })).status, 401);
});

test("signing out ends the session and returns the provider's sign-out address with the ID token as a hint", async () => {
    const t = await oidcTestApp();
    const a = (await t.signIn(admin)).session as NonNullable<Awaited<ReturnType<typeof t.signIn>>["session"]>;
    const idToken = t.provider.issued.at(-1) as string;
    // The ID token appears nowhere a browser can read, until it's needed for this.
    for (const r of t.routes.filter((x) => x.method === "GET" && x.scope !== "public" && x.produces !== "event-stream")) {
        const path = r.path.replace("{workspace}", "ada").replace(/\{\w+\}/g, "x");
        assert.ok(!(await t.request(path, { session: a })).text.includes(idToken), r.path);
    }
    const out = await t.request("/auth/logout", { method: "POST", session: a, body: {} });
    assert.equal(out.status, 200);
    const redirect = new URL(out.body.redirect);
    assert.equal(`${redirect.origin}${redirect.pathname}`, `${ISSUER}end-session`);
    assert.equal(redirect.searchParams.get("id_token_hint"), idToken);
    assert.equal(redirect.searchParams.get("post_logout_redirect_uri"), ORIGIN);
    assert.equal(redirect.searchParams.get("client_id"), "triagent");
    assert.equal((await t.request("/api/v1/me", { session: a })).status, 401);
});

test("config: OIDC settings are checked with clear messages", () => {
    const base = {
        PUBLIC_ORIGIN: "https://code-review.example.com",
        AUTH_MODE: "oidc",
        OIDC_ISSUER: "https://auth.example.com/application/o/triagent/",
        OIDC_CLIENT_ID: "triagent",
        OIDC_CLIENT_SECRET: "s",
    };
    const ok = loadConfig(base);
    assert.equal(ok.oidc?.scopes, "openid email profile");
    assert.equal(ok.oidc?.adminGroup, "platform-admin");
    assert.equal(ok.oidc?.trustEmail, false);
    assert.equal(ok.signupMode, "invite");
    assert.equal(ok.reauthMinutes, 15);
    const fails = (env: Record<string, string | undefined>, pattern: RegExp) =>
        assert.throws(
            () => loadConfig({ ...base, ...env }),
            (e: unknown) => e instanceof ConfigError && pattern.test(e.message),
        );
    fails({ AUTH_MODE: "saml" }, /AUTH_MODE must be "local" or "oidc"/);
    fails({ OIDC_ISSUER: undefined }, /OIDC_ISSUER must be/);
    fails({ OIDC_ISSUER: "http://auth.example.com/" }, /https/);
    fails({ OIDC_CLIENT_ID: undefined }, /OIDC_CLIENT_ID/);
    fails({ OIDC_CLIENT_SECRET: undefined }, /OIDC_CLIENT_SECRET/);
    fails({ OIDC_SCOPES: "email profile" }, /openid/);
    fails({ PUBLIC_ORIGIN: undefined }, /PUBLIC_ORIGIN/);
    fails({ TRIAGENT_ADMIN_USER: "me", TRIAGENT_ADMIN_PASSWORD: "x" }, /only applies to AUTH_MODE=local/);
    fails({ SIGNUP_MODE: "anyone" }, /SIGNUP_MODE/);
    fails({ OIDC_TRUST_EMAIL: "maybe" }, /OIDC_TRUST_EMAIL/);
    fails({ REAUTH_MINUTES: "0" }, /REAUTH_MINUTES/);
    assert.equal(loadConfig({ ...base, OIDC_ISSUER: "http://127.0.0.1:9000/" }).oidc?.issuer, "http://127.0.0.1:9000/");
});
