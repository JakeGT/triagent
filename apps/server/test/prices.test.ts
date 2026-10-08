// Model prices and OpenRouter's catalogue: who may set prices where, how a model's price is chosen, and a
// catalogue that's cached, survives failures and can be turned off. OpenRouter is always a fake here.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Catalogue, parseCatalogue } from "../src/services/catalogue.ts";
import { ADMIN_PASSWORD, type Session, type TestApp, testApp } from "./helpers.ts";

const LISTING = {
    data: [
        {
            id: "anthropic/claude-sonnet-4.5",
            name: "Anthropic: Claude Sonnet 4.5",
            context_length: 1_000_000,
            pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
        },
        { id: "openai/gpt-5", name: "OpenAI: GPT-5", pricing: { prompt: "0.00000125", completion: "0.00001" } },
        { id: "openrouter/auto", name: "Auto", pricing: { prompt: "-1", completion: "-1" } },
        { id: "bad id with spaces", pricing: { prompt: "0", completion: "0" } },
        "not a model",
    ],
};

function fakeFetch(answers: (() => Response | Promise<Response>)[]) {
    const calls: string[] = [];
    const fn = (async (url: string | URL | Request) => {
        calls.push(String(url));
        const next = answers.shift();
        if (!next) throw new Error("unexpected fetch");
        return next();
    }) as typeof fetch;
    return { fn, calls };
}

const ok = () => new Response(JSON.stringify(LISTING), { status: 200, headers: { "content-type": "application/json" } });

test("the catalogue is parsed into prices per million tokens, skipping what doesn't fit", () => {
    const models = parseCatalogue(LISTING);
    assert.deepEqual(
        models.map((m) => m.id),
        ["anthropic/claude-sonnet-4.5", "openai/gpt-5"],
    );
    assert.deepEqual(models[0]?.price, { input: 3, output: 15, cacheRead: 0.3 });
    assert.deepEqual(models[1]?.price, { input: 1.25, output: 10, cacheRead: null });
    assert.equal(models[0]?.contextLength, 1_000_000);
    assert.throws(() => parseCatalogue({ nope: true }));
});

test("the catalogue is fetched once an hour, shared by concurrent callers", async () => {
    let now = 1_000_000;
    const f = fakeFetch([ok, ok]);
    const c = new Catalogue({ enabled: true, fetch: f.fn, now: () => now });
    const [a, b] = await Promise.all([c.view(), c.view()]);
    assert.equal(f.calls.length, 1);
    assert.equal(a.models.length, 2);
    assert.equal(b.error, null);
    now += 59 * 60_000;
    await c.view();
    assert.equal(f.calls.length, 1);
    now += 2 * 60_000;
    await c.view();
    assert.equal(f.calls.length, 2);
});

test("a failed fetch keeps the older list, says why, and isn't retried for a few minutes", async () => {
    let now = 0;
    const f = fakeFetch([
        ok,
        () => new Response("oops", { status: 503 }),
        () => {
            throw new TypeError("fetch failed");
        },
        () => new Response("{not json", { status: 200 }),
    ]);
    const c = new Catalogue({ enabled: true, fetch: f.fn, now: () => now });
    assert.equal((await c.view()).models.length, 2);
    now += 61 * 60_000;
    const stale = await c.view();
    assert.equal(stale.error, "OpenRouter answered 503.");
    assert.equal(stale.models.length, 2);
    now += 60_000;
    await c.view();
    assert.equal(f.calls.length, 2);
    now += 5 * 60_000;
    assert.equal((await c.view()).error, "Couldn't reach OpenRouter.");
    now += 6 * 60_000;
    assert.equal((await c.view()).error, "OpenRouter's answer wasn't valid JSON.");
    assert.equal((await c.prices()).get("openai/gpt-5")?.price.output, 10);
});

test("a slow OpenRouter is given up on", async () => {
    const slow = ((_: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })) as typeof fetch;
    const c = new Catalogue({ enabled: true, fetch: slow, timeoutMs: 20 });
    const v = await c.view();
    assert.equal(v.error, "OpenRouter didn't answer in time.");
    assert.deepEqual(v.models, []);
});

test("OPENROUTER_CATALOGUE=false never fetches", async () => {
    const f = fakeFetch([]);
    const c = new Catalogue({ enabled: false, fetch: f.fn });
    const v = await c.view();
    assert.deepEqual(v, { enabled: false, fetchedAt: null, error: null, models: [] });
    assert.equal(f.calls.length, 0);
});

// ---- prices through the API ---------------------------------------------------------------------

let t: TestApp;
let admin: Session;
let editorSession: Session;
let adminMember: Session;
let manageToken: string;

async function member(username: string, role: string): Promise<Session> {
    const created = await t.request("/api/v1/instance/users", {
        method: "POST",
        session: admin,
        body: { username, password: "temporary-password-1" },
    });
    assert.equal(created.status, 201, created.text);
    const s = await t.signIn(username, "temporary-password-1");
    await t.request("/api/v1/me/password", {
        method: "POST",
        session: s,
        body: { current: "temporary-password-1", password: "a-longer-password-2" },
    });
    assert.equal(
        (await t.request("/api/v1/w/acme/settings/members", { method: "POST", session: admin, body: { username, role } })).status,
        201,
    );
    return t.signIn(username, "a-longer-password-2");
}

before(async () => {
    const f = fakeFetch([ok, ok, ok]);
    t = await testApp(undefined, { fetch: f.fn });
    admin = await t.signIn("admin", ADMIN_PASSWORD);
    assert.equal((await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "acme" } })).status, 201);
    editorSession = await member("ed", "editor");
    adminMember = await member("ada", "admin");
    manageToken = (
        await t.request("/api/v1/w/acme/settings/tokens", { method: "POST", session: admin, body: { name: "m", scope: "manage" } })
    ).body.token;
});

test("workspace prices: readable by members, set by those who configure, and override the instance's and OpenRouter's", async () => {
    const price = { model: "anthropic/claude-sonnet-4.5", input: 2, output: 10, cacheRead: 0.2 };
    assert.equal(
        (await t.request("/api/v1/w/acme/settings/model-prices", { method: "PUT", session: editorSession, body: price })).status,
        403,
    );
    const set = await t.request("/api/v1/w/acme/settings/model-prices", { method: "PUT", session: adminMember, body: price });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.body.setBy, "ada");
    // A manage token configures, so it may set prices too.
    const byToken = await t.request("/api/v1/w/acme/settings/model-prices", {
        method: "PUT",
        token: manageToken,
        body: { model: "openai/gpt-5", input: 1, output: 8 },
    });
    assert.equal(byToken.status, 200, byToken.text);

    const view = await t.request("/api/v1/w/acme/settings/model-prices", { session: editorSession });
    assert.equal(view.status, 200);
    assert.deepEqual(
        view.body.prices.map((p: { model: string }) => p.model),
        ["anthropic/claude-sonnet-4.5", "openai/gpt-5"],
    );
    const workspace = (await t.services.store.workspaces.bySlug("acme"))?.id as string;
    const price1 = await t.services.prices.resolver(workspace);
    assert.deepEqual(price1("anthropic/claude-sonnet-4.5"), { input: 2, output: 10, cacheRead: 0.2, source: "workspace" });

    // Removing the override falls back to the instance price, then to OpenRouter's.
    await t.request("/api/v1/instance/model-prices", {
        method: "PUT",
        session: admin,
        body: { model: "anthropic/claude-sonnet-4.5", input: 2.5, output: 12 },
    });
    assert.equal(
        (
            await t.request("/api/v1/w/acme/settings/model-prices", {
                method: "DELETE",
                session: adminMember,
                body: { model: "anthropic/claude-sonnet-4.5" },
            })
        ).status,
        200,
    );
    assert.deepEqual((await t.services.prices.resolver(workspace))("anthropic/claude-sonnet-4.5"), {
        input: 2.5,
        output: 12,
        cacheRead: null,
        source: "instance",
    });
    await t.request("/api/v1/instance/model-prices", { method: "DELETE", session: admin, body: { model: "anthropic/claude-sonnet-4.5" } });
    assert.equal((await t.services.prices.resolver(workspace))("anthropic/claude-sonnet-4.5")?.source, "openrouter");
    assert.equal((await t.services.prices.resolver(workspace))("unknown/model"), null);

    // Changes are audited, by model name and price.
    const audit = await t.services.store.audit.list({ workspaceId: workspace }, { limit: 20 });
    assert.ok(audit.some((a) => a.target === "model-prices" && a.actor === "ada"));
});

test("prices are checked", async () => {
    for (const body of [
        { model: "x", input: -1, output: 1 },
        { model: "x", input: 1, output: 1e9 },
        { model: "has spaces", input: 1, output: 1 },
        { model: "constructor", input: 1, output: 1 },
    ]) {
        const res = await t.request("/api/v1/w/acme/settings/model-prices", { method: "PUT", session: admin, body });
        assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(
        (await t.request("/api/v1/w/acme/settings/model-prices", { method: "DELETE", session: admin, body: { model: "never/set" } }))
            .status,
        404,
    );
});

test("the catalogue route serves OpenRouter's list to members", async () => {
    const res = await t.request("/api/v1/w/acme/models/catalogue", { session: editorSession });
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.models[0].id, "anthropic/claude-sonnet-4.5");
});

test("instance routes refuse members who aren't instance admins, and every token", async () => {
    const instance = t.routes.filter((r) => r.scope === "instance" && /model|workspaces/.test(r.path));
    assert.ok(instance.length >= 10);
    const ws = (await t.services.store.workspaces.bySlug("acme"))?.id as string;
    for (const r of instance) {
        const path = r.path.replace("{provider}", "openrouter").replace("{workspaceId}", ws);
        const body = r.method === "GET" ? undefined : { model: "a/b", input: 1, output: 1, monthlyTokens: 5000, key: "sk-abcdefghijk" };
        for (const [who, auth] of [
            ["workspace admin", { session: adminMember }],
            ["token", { token: manageToken }],
        ] as const) {
            const res = await t.request(path, { method: r.method, body, ...auth });
            assert.equal(res.status, 403, `${who}: ${r.method} ${r.path} answered ${res.status}`);
        }
    }
    assert.equal(await t.services.store.modelGrants.get(ws), null);
    assert.equal(await t.services.store.secrets.get(null, null, "model-key:openrouter"), null);
});
