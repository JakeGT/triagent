// Serving the built web app, and the skill file for agents.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { serveWeb } from "../src/http/static.ts";
import { testApp } from "./helpers.ts";

function fakeBuild(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "triagent-web-"));
    mkdirSync(path.join(dir, "assets"));
    mkdirSync(path.join(dir, ".vite"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Triagent</title>");
    writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
    writeFileSync(path.join(dir, "theme-init.js"), "// theme");
    writeFileSync(path.join(dir, ".vite", "manifest.json"), "{}");
    writeFileSync(path.join(dir, "notes.secret"), "not a web file");
    return dir;
}

function appWith(dir: string) {
    const app = new Hono();
    app.get("/api/v1/thing", (c) => c.json({ ok: true }));
    assert.equal(serveWeb(app, dir), true);
    app.notFound((c) => c.json({ error: "not found" }, 404));
    return app;
}

test("fingerprinted assets are cached for good; the page and other files are revalidated", async () => {
    const app = appWith(fakeBuild());
    const asset = await app.request("/assets/index-abc123.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(asset.headers.get("content-type") ?? "", /^text\/javascript/);
    const page = await app.request("/");
    assert.equal(page.headers.get("cache-control"), "no-cache");
    assert.match(await page.text(), /<title>Triagent<\/title>/);
    assert.equal((await app.request("/theme-init.js")).headers.get("cache-control"), "no-cache");
});

test("an unchanged file is a 304", async () => {
    const app = appWith(fakeBuild());
    const first = await app.request("/assets/index-abc123.js");
    const etag = first.headers.get("etag") as string;
    assert.ok(etag);
    const again = await app.request("/assets/index-abc123.js", { headers: { "if-none-match": etag } });
    assert.equal(again.status, 304);
});

test("app routes get the page; API paths, missing assets and files outside the build don't", async () => {
    const app = appWith(fakeBuild());
    for (const p of ["/w/acme/p/app/issues", "/sign-in", "/w/acme/settings/members"]) {
        const res = await app.request(p);
        assert.equal(res.status, 200, p);
        assert.match(res.headers.get("content-type") ?? "", /^text\/html/, p);
    }
    assert.deepEqual(await (await app.request("/api/v1/thing")).json(), { ok: true });
    for (const p of [
        "/api/v1/nothing",
        "/auth/whatever",
        "/mcp",
        "/llms.txt",
        "/healthz",
        "/assets/missing.js",
        "/.vite/manifest.json",
        "/notes.secret",
        "/assets/../index.html.bak",
        "/%2e%2e/package.json",
    ]) {
        assert.equal((await app.request(p)).status, 404, p);
    }
    // Dot segments are resolved before matching: this is just an app route, so it gets the page.
    assert.match(await (await app.request("/../../etc/passwd")).text(), /<title>Triagent<\/title>/);
});

test("without a build the server still starts and serves the API", async () => {
    const app = new Hono();
    assert.equal(serveWeb(app, path.join(tmpdir(), "no-such-triagent-build")), false);
});

test("the skill for agents is public Markdown", async () => {
    const t = await testApp();
    const res = await t.request("/api/v1/skill.md");
    assert.equal(res.status, 200);
    assert.match(res.text, /^---\nname: triagent/);
});
