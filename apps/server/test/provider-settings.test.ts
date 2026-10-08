// Choosing a provider, its settings and secrets, for a workspace and for the instance; what `forRun` hands a
// review for each protocol; model URLs that point inside the network; and providers' model lists, fetched
// with the stored key, which never comes back. Keys are made up at runtime; nothing reaches a real provider.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Actor } from "../src/services/core.ts";
import type { Lookup } from "../src/services/model-urls.ts";
import type { RunModel } from "../src/services/models.ts";
import type { Workspace } from "../src/store/types.ts";
import { ADMIN_PASSWORD, type Session, type TestApp, testApp } from "./helpers.ts";

const actor: Actor = { name: "admin", userId: null, via: "web" };
const fakeKey = (prefix = "") => `${prefix}${randomBytes(24).toString("base64url")}`;
const accessKeyId = () => `AKIA${randomBytes(10).toString("hex").toUpperCase().slice(0, 16)}`;

/** Host names as the tests' DNS has them; tests can move one. */
const hosts: Record<string, string[]> = {
    "llm.example.com": ["93.184.215.14"],
    "res.openai.azure.com": ["20.50.2.10"],
    "inside.example.com": ["10.0.0.7"],
    "sneaky.example.com": ["93.184.215.14", "127.0.0.1"],
    "ollama.internal": ["192.168.5.10"],
};
const lookup: Lookup = async (h) => {
    const a = hosts[h];
    if (!a) throw new Error("ENOTFOUND");
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

interface Call {
    url: string;
    headers: Record<string, string>;
    redirect: RequestInit["redirect"];
}
const calls: Call[] = [];
/** Answers for providers' model lists, by URL; the key is echoed back to prove it never reaches the response. */
let answer: (url: string, key: string) => Response = (_url, key) =>
    Response.json({ object: "list", data: [{ id: "model-b" }, { id: "models/model-a" }], echoed: key });
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, headers, redirect: init?.redirect });
    if (url.startsWith("https://openrouter.ai/"))
        return Response.json({
            data: [{ id: "anthropic/claude-sonnet-4.5", name: "Sonnet", pricing: { prompt: "0.000003", completion: "0.000015" } }],
        });
    return answer(url, headers.authorization?.replace(/^Bearer /, "") ?? headers["x-api-key"] ?? "");
}) as typeof fetch;

let t: TestApp;
let admin: Session;
let n = 0;

before(async () => {
    t = await testApp(undefined, { fetch: fakeFetch, lookup });
    admin = await t.signIn("admin", ADMIN_PASSWORD);
});

async function newWorkspace(): Promise<Workspace> {
    const slug = `prov-${++n}`;
    assert.equal((await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug } })).status, 201);
    return (await t.services.store.workspaces.bySlug(slug)) as Workspace;
}

const patch = (w: Workspace, body: object) =>
    t.request(`/api/v1/w/${w.slug}/settings/review-model`, { method: "PATCH", session: admin, body });
const putKey = (w: Workspace, provider: string, key: string, which = "") =>
    t.request(`/api/v1/w/${w.slug}/settings/review-model/keys/${provider}${which}`, { method: "PUT", session: admin, body: { key } });
const ready = async (w: Workspace) => (await t.services.models.forRun(w)) as RunModel;
const reason = async (w: Workspace) => ((await t.services.models.forRun(w)) as { reason: string }).reason;

describe("forRun, by protocol", () => {
    test("Anthropic: its own protocol and address", async () => {
        const w = await newWorkspace();
        const key = fakeKey("sk-ant-");
        assert.equal((await patch(w, { provider: "anthropic" })).status, 200);
        assert.equal(await reason(w), "Add an Anthropic API key in Settings → Review model & keys.");
        assert.equal((await putKey(w, "anthropic", key)).status, 200);
        const r = await ready(w);
        assert.deepEqual(
            { provider: r.provider, protocol: r.protocol, url: r.url, model: r.model, apiKey: r.apiKey, aws: r.aws, userUrl: r.userUrl },
            {
                provider: "anthropic",
                protocol: "anthropic",
                url: "https://api.anthropic.com",
                model: "claude-opus-5-5",
                apiKey: key,
                aws: undefined,
                userUrl: false,
            },
        );
    });

    test("OpenAI with the Responses API, and Gemini through its OpenAI-compatible endpoint", async () => {
        const w = await newWorkspace();
        await putKey(w, "openai", fakeKey("sk-"));
        await putKey(w, "gemini", fakeKey());
        assert.equal((await patch(w, { provider: "openai", model: "gpt-5.5-pro", protocol: "openai-responses" })).status, 200);
        let r = await ready(w);
        assert.deepEqual([r.protocol, r.url, r.model], ["openai-responses", "https://api.openai.com/v1", "gpt-5.5-pro"]);
        // Gemini speaks only the OpenAI protocol.
        assert.equal((await patch(w, { provider: "gemini", protocol: "openai-responses" })).status, 400);
        assert.equal((await patch(w, { provider: "gemini" })).status, 200);
        r = await ready(w);
        assert.deepEqual([r.protocol, r.url], ["openai", "https://generativelanguage.googleapis.com/v1beta/openai"]);
        // Switching back keeps OpenAI's choices.
        await patch(w, { provider: "openai" });
        r = await ready(w);
        assert.deepEqual([r.protocol, r.model], ["openai-responses", "gpt-5.5-pro"]);
    });

    test("Amazon Bedrock: a region and an access key, each asked for in turn", async () => {
        const w = await newWorkspace();
        const id = accessKeyId();
        const secret = fakeKey();
        await patch(w, { provider: "bedrock" });
        assert.equal(await reason(w), "Add an AWS region for Amazon Bedrock in Settings → Review model & keys.");
        assert.equal((await patch(w, { region: "eu-west-2" })).status, 200);
        assert.equal(await reason(w), "Add an AWS access key ID for Amazon Bedrock in Settings → Review model & keys.");
        assert.equal((await putKey(w, "bedrock", "not-an-id", "/access-key-id")).status, 400);
        assert.equal((await putKey(w, "bedrock", id, "/access-key-id")).status, 200);
        assert.equal(await reason(w), "Add an AWS secret access key for Amazon Bedrock in Settings → Review model & keys.");
        assert.equal((await putKey(w, "bedrock", secret)).status, 200);
        const r = await ready(w);
        assert.deepEqual(
            { protocol: r.protocol, url: r.url, model: r.model, apiKey: r.apiKey, aws: r.aws },
            {
                protocol: "anthropic-bedrock",
                url: "",
                model: "global.anthropic.claude-opus-4-6-v1",
                apiKey: secret,
                aws: { region: "eu-west-2", accessKeyId: id },
            },
        );
        // Neither secret is ever shown: only that they're set, and their last characters.
        const view = await t.request(`/api/v1/w/${w.slug}/settings/review-model`, { session: admin });
        assert.ok(!view.text.includes(secret) && !view.text.includes(id));
        const bedrock = view.body.providers.find((p: { id: string }) => p.id === "bedrock");
        assert.deepEqual([bedrock.key.set, bedrock.accessKeyId.set, bedrock.region, bedrock.ready], [true, true, "eu-west-2", true]);
        // Only Bedrock has an access key ID; other providers' settings don't apply to it.
        assert.equal((await putKey(w, "openai", id, "/access-key-id")).status, 400);
        assert.equal((await patch(w, { region: "EU WEST" })).status, 400);
        assert.equal((await patch(w, { url: "https://llm.example.com/v1" })).status, 400);
    });

    test("Azure OpenAI: the resource's endpoint, the deployment as the model", async () => {
        const w = await newWorkspace();
        await patch(w, { provider: "azure" });
        assert.equal(await reason(w), "Add the Azure OpenAI endpoint in Settings → Review model & keys.");
        assert.equal((await patch(w, { url: "https://res.openai.azure.com/", model: "my-review-deployment" })).status, 200);
        await putKey(w, "azure", fakeKey());
        const r = await ready(w);
        assert.deepEqual(
            [r.protocol, r.url, r.model, r.userUrl],
            ["openai-responses", "https://res.openai.azure.com/openai/v1", "my-review-deployment", true],
        );
    });

    test("a custom server: its URL, key and protocol", async () => {
        const w = await newWorkspace();
        await patch(w, { provider: "custom", url: "https://llm.example.com/v1", model: "qwen3:32b", protocol: "anthropic" });
        assert.equal(await reason(w), "Add an API key for your server in Settings → Review model & keys.");
        await putKey(w, "custom", fakeKey());
        const r = await ready(w);
        assert.deepEqual([r.protocol, r.url, r.model, r.userUrl], ["anthropic", "https://llm.example.com/v1", "qwen3:32b", true]);
        // Clearing the URL makes it wait again.
        assert.equal((await patch(w, { url: null })).status, 200);
        assert.equal(await reason(w), "Add your server's base URL in Settings → Review model & keys.");
    });

    test("the instance key for Bedrock, through an allowance", async () => {
        const w = await newWorkspace();
        const id = accessKeyId();
        const secret = fakeKey();
        await t.services.allowances.setModel(actor, {
            provider: "bedrock",
            region: "us-east-1",
            model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        });
        await t.services.allowances.setKey(actor, "bedrock", id, "accessKeyId");
        await t.services.allowances.setKey(actor, "bedrock", secret);
        await t.services.allowances.setGrant(actor, w.id, 1_000_000);
        const r = await ready(w);
        assert.deepEqual(
            [r.keySource, r.protocol, r.model, r.apiKey, r.aws],
            [
                "instance",
                "anthropic-bedrock",
                "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                secret,
                { region: "us-east-1", accessKeyId: id },
            ],
        );
        const view = await t.request("/api/v1/instance/model", { session: admin });
        assert.equal(view.status, 200);
        assert.ok(!view.text.includes(secret) && !view.text.includes(id));
        assert.equal(view.body.ready, true);
        // Through the API, the instance's access key ID needs the same recent sign-in as its keys.
        const route = t.routes.find((x) => x.path === "/api/v1/instance/model/keys/{provider}/access-key-id" && x.method === "PUT");
        assert.equal(route?.recentSignIn, true);
        await t.services.allowances.setModel(actor, { provider: "openrouter" });
    });
});

describe("model URLs that point inside the network", () => {
    test("are refused when saved, whatever the name, for workspaces and the instance", async () => {
        const w = await newWorkspace();
        await patch(w, { provider: "custom" });
        for (const url of [
            "https://inside.example.com/v1",
            "https://sneaky.example.com/v1",
            "https://10.1.2.3/v1",
            "https://[::1]/v1",
            "http://llm.example.com/v1",
        ]) {
            const r = await patch(w, { url });
            assert.equal(r.status, 400, url);
            assert.match(r.body.error, /private or loopback|must use https/, url);
        }
        assert.equal((await patch(w, { provider: "azure", url: "https://inside.example.com" })).status, 400);
        const instance = await t.request("/api/v1/instance/model", {
            method: "PATCH",
            session: admin,
            body: { provider: "custom", url: "https://inside.example.com/v1" },
        });
        assert.equal(instance.status, 400);
        assert.equal((await t.services.allowances.view()).provider, "openrouter");
    });

    test("ALLOW_PRIVATE_MODEL_URLS=true lets a self-hoster use Ollama on their own network", async () => {
        const relaxed = await testApp(undefined, { lookup, env: { ALLOW_PRIVATE_MODEL_URLS: "true" } });
        const session = await relaxed.signIn("admin", ADMIN_PASSWORD);
        await relaxed.request("/api/v1/workspaces", { method: "POST", session, body: { slug: "home" } });
        const ok = await relaxed.request("/api/v1/w/home/settings/review-model", {
            method: "PATCH",
            session,
            body: { provider: "custom", url: "http://ollama.internal:11434/v1", model: "qwen3:32b" },
        });
        assert.equal(ok.status, 200, ok.text);
        const plain = await relaxed.request("/api/v1/w/home/settings/review-model", {
            method: "PATCH",
            session,
            body: { url: "http://llm.example.com/v1" },
        });
        assert.equal(plain.status, 400);
    });
});

describe("providers' model lists", () => {
    let w: Workspace;
    let key: string;
    const list = (provider: string, init: { token?: string; session?: Session } = { session: admin }) =>
        t.request(`/api/v1/w/${w.slug}/settings/review-model/providers/${provider}/models`, init);

    before(async () => {
        w = await newWorkspace();
        key = fakeKey("sk-");
        await patch(w, { provider: "custom", url: "https://llm.example.com/v1" });
        await putKey(w, "custom", key);
    });
    after(() => {
        answer = (_url, k) => Response.json({ object: "list", data: [{ id: "model-b" }, { id: "models/model-a" }], echoed: k });
    });

    test("fetched with the stored key, which never comes back; kept for a while", async () => {
        calls.length = 0;
        const r = await list("custom");
        assert.equal(r.status, 200, r.text);
        assert.deepEqual(r.body.models, [
            { id: "model-a", name: null },
            { id: "model-b", name: null },
        ]);
        assert.equal(r.body.source, "provider");
        assert.equal(r.body.error, null);
        assert.ok(!r.text.includes(key));
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            url: "https://llm.example.com/v1/models",
            headers: { accept: "application/json", authorization: `Bearer ${key}` },
            redirect: "error",
        });
        await list("custom");
        assert.equal(calls.length, 1, "cached");
    });

    test("anyone who can read the workspace may list, a read-only token too; outsiders can't", async () => {
        const token = (
            await t.request(`/api/v1/w/${w.slug}/settings/tokens`, { method: "POST", session: admin, body: { name: "r", scope: "read" } })
        ).body.token;
        const r = await list("custom", { token });
        assert.equal(r.status, 200);
        assert.ok(!r.text.includes(key));
        assert.equal((await list("nonsense")).status, 404);
    });

    test("a provider's refusal, whatever it says, never carries the key back", async () => {
        const anthropicKey = fakeKey("sk-ant-");
        await putKey(w, "anthropic", anthropicKey);
        answer = (_url, k) => new Response(JSON.stringify({ error: `invalid x-api-key ${k}` }), { status: 401 });
        calls.length = 0;
        const r = await list("anthropic");
        assert.equal(r.status, 200);
        assert.equal(r.body.error, "Anthropic refused the key (401). Check it's right.");
        assert.deepEqual(r.body.models, []);
        assert.ok(!r.text.includes(anthropicKey));
        // Anthropic's list, with Anthropic's headers.
        assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/models?limit=1000");
        assert.equal(calls[0]?.headers["x-api-key"], anthropicKey);
        assert.equal(calls[0]?.headers["anthropic-version"], "2023-06-01");
        assert.equal(calls[0]?.headers.authorization, undefined);
        // Nor does a garbled answer, or one that never comes.
        const mistralKey = fakeKey();
        await putKey(w, "mistral", mistralKey);
        answer = (_url, k) => new Response(`<html>${k}</html>`, { status: 200 });
        const garbled = await list("mistral");
        assert.equal(garbled.body.error, "Mistral's model list wasn't in a form Triagent understands.");
        assert.ok(!garbled.text.includes(mistralKey));
    });

    test("without a key, providers with no list, OpenRouter's catalogue, and Cohere's own list", async () => {
        const none = await list("groq");
        assert.equal(none.body.error, "Add a Groq API key to see Groq's models.");
        assert.deepEqual(none.body.suggested, ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"]);
        const fireworks = await list("fireworks");
        assert.deepEqual([fireworks.body.source, fireworks.body.models, fireworks.body.error], ["none", [], null]);
        assert.ok(fireworks.body.suggested.length > 0);
        const openrouter = await list("openrouter");
        assert.equal(openrouter.body.source, "openrouter");
        assert.deepEqual(openrouter.body.models, [{ id: "anthropic/claude-sonnet-4.5", name: "Sonnet" }]);
        answer = () => Response.json({ models: [{ name: "command-a-plus-05-2026", endpoints: ["chat"] }] });
        await putKey(w, "cohere", fakeKey());
        calls.length = 0;
        const cohere = await list("cohere");
        assert.deepEqual(cohere.body.models, [{ id: "command-a-plus-05-2026", name: null }]);
        assert.equal(calls[0]?.url, "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000");
    });

    test("a custom URL that now resolves inside the network isn't fetched", async () => {
        const other = await newWorkspace();
        hosts["moving.example.com"] = ["93.184.215.14"];
        await patch(other, { provider: "custom", url: "https://moving.example.com/v1" });
        await putKey(other, "custom", fakeKey());
        hosts["moving.example.com"] = ["10.9.8.7"];
        calls.length = 0;
        const r = await t.request(`/api/v1/w/${other.slug}/settings/review-model/providers/custom/models`, { session: admin });
        assert.match(r.body.error, /private or loopback address \(moving\.example\.com\)/);
        assert.equal(calls.length, 0);
    });

    test("the instance's lists use the instance key", async () => {
        const instanceKey = fakeKey("xai-");
        await t.services.allowances.setKey(actor, "xai", instanceKey);
        answer = () => Response.json({ object: "list", data: [{ id: "grok-4.7" }] });
        calls.length = 0;
        const r = await t.request("/api/v1/instance/model/providers/xai/models", { session: admin });
        assert.deepEqual(r.body.models, [{ id: "grok-4.7", name: null }]);
        assert.equal(calls[0]?.headers.authorization, `Bearer ${instanceKey}`);
        assert.ok(!r.text.includes(instanceKey));
    });
});

describe("prices for providers' own model names", () => {
    test("OpenRouter's price for the same model, where its name is clear", async () => {
        const w = await newWorkspace();
        const price = await t.services.prices.resolver(w.id);
        assert.equal(price("claude-sonnet-4-5-20250929")?.source, "openrouter");
        assert.equal(price("us.anthropic.claude-sonnet-4-5-20250929-v1:0")?.input, 3);
        assert.equal(price("my-review-deployment"), null);
    });
});
