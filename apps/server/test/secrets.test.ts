import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SecretBox } from "../src/services/secrets.ts";
import { ADMIN_PASSWORD, testApp } from "./helpers.ts";

const scope = { workspaceId: "w1", projectId: "p1" };

test("a sealed secret opens only with the same key, place and name", () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.seal("github_pat_abc", scope, "github-token");
    assert.ok(!sealed.includes("github_pat_abc"));
    assert.equal(box.open(sealed, scope, "github-token"), "github_pat_abc");
    assert.throws(() => box.open(sealed, { ...scope, workspaceId: "w2" }, "github-token"));
    assert.throws(() => box.open(sealed, scope, "webhook-secret"));
    assert.throws(() => new SecretBox(randomBytes(32)).open(sealed, scope, "github-token"), /stored with key/);
    const tampered = sealed.replace(
        /\.([^.]+)\.([^.]+)$/,
        (_m, ct: string, tag: string) => `.${Buffer.from("x").toString("base64")}${ct.slice(4)}.${tag}`,
    );
    assert.throws(() => box.open(tampered, scope, "github-token"));
});

test("each seal uses a fresh nonce", () => {
    const box = new SecretBox(randomBytes(32));
    assert.notEqual(box.seal("same", scope, "n"), box.seal("same", scope, "n"));
});

test("secrets are never returned by any read the API offers", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const w = "/api/v1/w/admin";
    assert.equal((await t.request(`${w}/projects`, { method: "POST", session: admin, body: { slug: "app" } })).status, 201);
    const githubToken = `github_pat_${randomBytes(30).toString("hex")}`;
    const modelKey = `sk-or-${randomBytes(24).toString("hex")}`;
    assert.equal(
        (await t.request(`${w}/p/app/settings/github/token`, { method: "PUT", session: admin, body: { token: githubToken } })).status,
        200,
    );
    assert.equal(
        (await t.request(`${w}/settings/review-model/keys/openrouter`, { method: "PUT", session: admin, body: { key: modelKey } })).status,
        200,
    );
    const webhook = await t.request(`${w}/p/app/settings/github/webhook-secret`, { method: "POST", session: admin });
    const webhookSecret: string = webhook.body.webhookSecret;

    for (const r of t.routes.filter((x) => x.method === "GET" && x.scope !== "public" && x.produces !== "event-stream")) {
        const path = r.path
            .replace("{workspace}", "admin")
            .replace("{project}", "app")
            .replace(/\{\w+\}/g, "x");
        const res = await t.request(path, { session: admin });
        for (const secret of [githubToken, modelKey, webhookSecret]) assert.ok(!res.text.includes(secret), `${r.path} returned a secret`);
    }
    const audit = await t.request(`${w}/settings/audit`, { session: admin });
    assert.ok(
        audit.body.items.some((a: { kind: string }) => a.kind === "secret"),
        "secret changes are audited",
    );
});

test("secrets can only be set by a person in the browser", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const w = "/api/v1/w/admin";
    await t.request(`${w}/projects`, { method: "POST", session: admin, body: { slug: "app" } });
    const token = (await t.request(`${w}/settings/tokens`, { method: "POST", session: admin, body: { name: "agent", scope: "manage" } }))
        .body.token;
    assert.equal(
        (await t.request(`${w}/p/app/settings/github/token`, { method: "PUT", token, body: { token: `github_pat_${"a".repeat(40)}` } }))
            .status,
        403,
    );
    assert.equal(
        (await t.request(`${w}/settings/review-model/keys/openrouter`, { method: "PUT", token, body: { key: "sk-whatever-key" } })).status,
        403,
    );
    assert.equal((await t.request(`${w}/p/app/settings/github/webhook-secret`, { method: "POST", token })).status, 403);
});
