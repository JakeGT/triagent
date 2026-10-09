// The permission table is the single source of truth: every route and tool must use it, and no token
// scope may ever reach a browser-only permission.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_ONLY, PERMISSIONS, ROLE_PERMISSIONS, SCOPE_PERMISSIONS, TOKEN_SCOPES } from "@triagent/shared";
import { z } from "zod";
import { needsBrowser } from "../src/http/route.ts";
import { TOOLS } from "../src/mcp/tools.ts";
import { testApp } from "./helpers.ts";

test("every workspace and project route names a permission from the table", async () => {
    const { routes } = await testApp();
    for (const r of routes) {
        if (r.scope === "workspace" || r.scope === "project") {
            assert.ok(r.permission, `${r.method} ${r.path} has no permission`);
            assert.ok(PERMISSIONS.includes(r.permission), `${r.method} ${r.path}: unknown permission ${r.permission}`);
        }
        if (r.scope === "project") assert.match(r.path, /\{project\}/, `${r.method} ${r.path} is project-scoped but has no {project}`);
        if (r.scope === "workspace" || r.scope === "project")
            assert.match(r.path, /\{workspace\}/, `${r.method} ${r.path} has no {workspace}`);
    }
});

test("routes needing a browser-only permission refuse tokens", async () => {
    const { routes } = await testApp();
    for (const r of routes) if (r.permission && BROWSER_ONLY.has(r.permission)) assert.ok(needsBrowser(r), `${r.method} ${r.path}`);
});

test("no token scope grants a browser-only permission", () => {
    for (const scope of TOKEN_SCOPES) {
        for (const p of SCOPE_PERMISSIONS[scope]) assert.ok(!BROWSER_ONLY.has(p), `scope ${scope} grants ${p}`);
    }
});

test("roles only gain permissions as they go up", () => {
    const order = ["viewer", "editor", "admin", "owner"] as const;
    for (let i = 1; i < order.length; i++) {
        const lower = new Set(ROLE_PERMISSIONS[order[i - 1] as (typeof order)[number]]);
        const higher = new Set(ROLE_PERMISSIONS[order[i] as (typeof order)[number]]);
        for (const p of lower) assert.ok(higher.has(p), `${order[i]} lacks ${p}, which ${order[i - 1]} has`);
    }
});

test("every MCP tool names a permission a token can hold", () => {
    const names = new Set<string>();
    for (const t of TOOLS) {
        assert.ok(!names.has(t.name), `duplicate tool ${t.name}`);
        names.add(t.name);
        assert.ok(PERMISSIONS.includes(t.permission), `${t.name}: unknown permission`);
        assert.ok(!BROWSER_ONLY.has(t.permission), `${t.name} needs ${t.permission}, which no token can have`);
    }
});

test("route paths and methods are unique", async () => {
    const { routes } = await testApp();
    const seen = new Set<string>();
    for (const r of routes) {
        const key = `${r.method} ${r.path}`;
        assert.ok(!seen.has(key), `duplicate route ${key}`);
        seen.add(key);
    }
});

test("the OpenAPI document lists every route with its permission", async () => {
    const { request, routes } = await testApp();
    const doc = (await request("/api/v1/openapi.json")).body;
    for (const r of routes) {
        const op = doc.paths[r.path]?.[r.method.toLowerCase()];
        assert.ok(op, `${r.method} ${r.path} missing from OpenAPI`);
        if (r.permission) assert.equal(op["x-permission"], r.permission);
        // Only an object schema's fields can be listed as query parameters.
        if (r.query) assert.ok(r.query instanceof z.ZodObject, `${r.method} ${r.path}: query isn't a z.object, so it isn't documented`);
    }
});
