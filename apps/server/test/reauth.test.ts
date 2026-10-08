// Steps that need a recent sign-in (setting secrets): an older session is asked to confirm it's still
// the same person, with a password (AUTH_MODE=local) or by signing in at the provider again (oidc).

import assert from "node:assert/strict";
import { test } from "node:test";
import { needsRecentSignIn } from "../src/http/route.ts";
import { sha256 } from "../src/security.ts";
import type { Services } from "../src/services/index.ts";
import { ADMIN_PASSWORD, type Session, testApp } from "./helpers.ts";
import { oidcTestApp } from "./oidc-helpers.ts";

/** Make a session look as if it signed in `minutes` ago. */
async function age(services: Services, session: Session, minutes: number) {
    const idHash = sha256(session.cookie.split("=")[1] as string);
    const s = await services.store.sessions.get(idHash);
    assert.ok(s);
    await services.store.sessions.put({ ...s, authAt: Date.now() - minutes * 60_000 });
}

const concrete = (path: string, ws: string) =>
    path
        .replace("{workspace}", ws)
        .replace("{project}", "app")
        .replace(/\{\w+\}/g, "openrouter");

test("every route that sets secrets needs a recent sign-in, and only those that should", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    assert.equal((await t.request("/api/v1/w/admin/projects", { method: "POST", session: admin, body: { slug: "app" } })).status, 201);
    const guarded = t.routes.filter(needsRecentSignIn);
    assert.ok(guarded.length >= 6, `only ${guarded.length} routes need a recent sign-in`);
    for (const r of t.routes) if (r.permission === "secrets") assert.ok(guarded.includes(r), `${r.method} ${r.path}`);
    // Instance-wide secrets (the instance's model keys) too.
    for (const r of t.routes)
        if (r.path.startsWith("/api/v1/instance/model/keys/")) assert.ok(guarded.includes(r), `${r.method} ${r.path}`);

    await age(t.services, admin, 16);
    for (const r of guarded) {
        const res = await t.request(concrete(r.path, "admin"), {
            method: r.method,
            session: admin,
            body: r.method === "GET" ? undefined : {},
        });
        assert.equal(res.status, 401, `${r.method} ${r.path} answered ${res.status}`);
        assert.equal(res.body.code, "reauth_required");
        assert.equal(res.body.method, "password");
    }
    // Still signed in for everything else.
    assert.equal((await t.request("/api/v1/me", { session: admin })).status, 200);
    assert.equal((await t.request("/api/v1/w/admin/p/app/settings/automation", { session: admin })).status, 200);

    // A fresh enough sign-in is fine (just inside the window).
    await age(t.services, admin, 14);
    const set = await t.request("/api/v1/w/admin/settings/review-model/keys/openrouter", {
        method: "PUT",
        session: admin,
        body: { key: "sk-or-a-fairly-long-key" },
    });
    assert.equal(set.status, 200);
});

test("local accounts confirm it's them with their password, slowed down like signing in", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    await age(t.services, admin, 60);
    const put = () =>
        t.request("/api/v1/w/admin/settings/review-model/keys/openrouter", {
            method: "PUT",
            session: admin,
            body: { key: "sk-or-key-1234" },
        });
    assert.equal((await put()).status, 401);

    const wrong = await t.request("/auth/reauth", { method: "POST", session: admin, body: { password: "not-the-password" } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "That password is wrong.");
    // Needs the session's CSRF token like any other write.
    assert.equal(
        (await t.request("/auth/reauth", { method: "POST", session: { ...admin, csrf: "nope" }, body: { password: ADMIN_PASSWORD } }))
            .status,
        403,
    );
    assert.equal((await t.request("/auth/reauth", { method: "POST", session: admin, body: { password: ADMIN_PASSWORD } })).status, 200);
    assert.equal((await put()).status, 200);

    await age(t.services, admin, 60);
    let last = 0;
    for (let i = 0; i < 10; i++)
        last = (await t.request("/auth/reauth", { method: "POST", session: admin, body: { password: `wrong-${i}` } })).status;
    assert.equal(last, 429);
});

test("with an identity provider, confirming it's you is signing in there again, and it keeps your place", async () => {
    const t = await oidcTestApp();
    const ada = { sub: "ada", email: "ada@example.com", email_verified: true, preferred_username: "ada", groups: ["platform-admin"] };
    // The provider says she authenticated an hour ago (an old single sign-on session).
    const first = await t.signIn(ada, { tamper: { authAgo: 3600 } });
    const session = first.session as Session;
    const url = "/api/v1/w/ada/settings/review-model/keys/openrouter";
    const refused = await t.request(url, { method: "PUT", session, body: { key: "sk-or-key-1234" } });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "reauth_required");
    assert.equal(refused.body.method, "provider");
    const reauth = new URL(refused.body.reauthUrl, "http://x");
    assert.equal(reauth.pathname, "/auth/login");
    assert.equal(reauth.searchParams.get("prompt"), "login");
    assert.equal(reauth.searchParams.get("max_age"), "0");
    reauth.searchParams.set("next", "/w/ada/settings/review-model");

    // A provider that doesn't actually check again (an old auth_time despite max_age=0) isn't believed.
    const stale = await t.signIn(ada, { query: reauth.search.slice(1), from: session, tamper: { authAgo: 3600 } });
    assert.equal(stale.location, "/sign-in?error=failed");

    const again = await t.signIn(ada, { query: reauth.search.slice(1), from: session });
    assert.equal(again.authorization.get("prompt"), "login");
    assert.equal(again.authorization.get("max_age"), "0");
    assert.equal(again.location, "/w/ada/settings/review-model");
    const fresh = again.session as Session;
    assert.equal((await t.request(url, { method: "PUT", session: fresh, body: { key: "sk-or-key-1234" } })).status, 200);
    // The old session was replaced, not left behind.
    assert.equal((await t.request("/api/v1/me", { session })).status, 401);
});
