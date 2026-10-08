// The provider registry, the checks on URLs people give for models, and reading providers' model lists.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MODEL_PROTOCOLS } from "@triagent/shared/model";
import { parseModelList } from "../src/services/model-lists.ts";
import { checkModelUrl, defaultLookup, isPrivateAddress, type Lookup, UnsafeUrl } from "../src/services/model-urls.ts";
import {
    AWS_ACCESS_KEY_ID,
    AWS_REGION,
    azureBaseUrl,
    catalogueCandidates,
    defaultModel,
    PROVIDER_IDS,
    PROVIDERS,
    providerById,
} from "../src/services/providers.ts";

const MODEL_NAME = /^[\w.:/@+-]{1,150}$/;

describe("the provider registry", () => {
    test("includes the major providers, each once", () => {
        for (const id of [
            "anthropic",
            "openai",
            "gemini",
            "mistral",
            "xai",
            "deepseek",
            "groq",
            "together",
            "fireworks",
            "cohere",
            "moonshot",
            "qwen",
            "openrouter",
            "meta",
            "bedrock",
            "azure",
            "custom",
        ])
            assert.ok(providerById(id), id);
        assert.equal(new Set(PROVIDER_IDS).size, PROVIDERS.length);
    });

    test("every entry is well formed: protocols OCR knows, https addresses, documented, model ids it accepts", () => {
        for (const p of PROVIDERS) {
            assert.ok(p.protocols.length > 0, p.id);
            for (const proto of p.protocols) assert.ok(MODEL_PROTOCOLS.includes(proto), `${p.id}: ${proto}`);
            for (const u of [p.url, p.docs, p.keysUrl]) if (u) assert.match(u, /^https:\/\/[^\s]+$/, `${p.id}: ${u}`);
            assert.ok(p.url === null || !p.url.endsWith("/"), `${p.id}: no trailing slash`);
            for (const m of p.suggested) assert.match(m, MODEL_NAME, `${p.id}: ${m}`);
            // A provider has a fixed address, or one the person gives, or (Bedrock) a region that decides it.
            assert.equal(p.url === null, p.fields.includes("url") || p.fields.includes("region"), p.id);
            assert.equal(p.protocols.includes("anthropic-bedrock"), p.fields.includes("region"), p.id);
            // Without a list of their own or an address to type in, suggestions are what people start from.
            if (p.models === null && !p.fields.includes("url")) assert.ok(p.suggested.length > 0, p.id);
        }
    });

    test("the protocol and address of each kind", () => {
        assert.deepEqual(providerById("anthropic")?.protocols, ["anthropic"]);
        assert.equal(providerById("anthropic")?.url, "https://api.anthropic.com");
        assert.deepEqual(providerById("openai")?.protocols, ["openai", "openai-responses"]);
        assert.equal(providerById("gemini")?.url, "https://generativelanguage.googleapis.com/v1beta/openai");
        assert.equal(providerById("mistral")?.url, "https://api.mistral.ai/v1");
        assert.equal(providerById("groq")?.url, "https://api.groq.com/openai/v1");
        assert.equal(providerById("cohere")?.url, "https://api.cohere.ai/compatibility/v1");
        assert.equal(providerById("qwen")?.url, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
        assert.deepEqual(providerById("bedrock")?.protocols, ["anthropic-bedrock"]);
        assert.deepEqual(providerById("bedrock")?.fields, ["region", "accessKeyId"]);
        assert.deepEqual(providerById("azure")?.fields, ["url"]);
        assert.ok(providerById("custom")?.protocols.includes("openai"));
        assert.equal(defaultModel(providerById("openrouter") as never), "anthropic/claude-sonnet-4.5");
        assert.equal(defaultModel(providerById("azure") as never), "");
    });

    test("Azure's v1 API address, from the resource endpoint however it's pasted", () => {
        for (const e of [
            "https://res.openai.azure.com",
            "https://res.openai.azure.com/",
            "https://res.openai.azure.com/openai",
            "https://res.openai.azure.com/openai/v1/",
        ])
            assert.equal(azureBaseUrl(e), "https://res.openai.azure.com/openai/v1", e);
    });

    test("AWS regions and access key IDs", () => {
        for (const r of ["eu-west-2", "us-east-1", "ap-southeast-2", "us-gov-west-1"]) assert.match(r, AWS_REGION);
        for (const r of ["EU-WEST-2", "eu-west", "eu-west-2/../x", ""]) assert.doesNotMatch(r, AWS_REGION);
        assert.match(`AKIA${"Q".repeat(16)}`, AWS_ACCESS_KEY_ID);
        assert.doesNotMatch(`ASIA${"Q".repeat(16)}`, AWS_ACCESS_KEY_ID);
    });

    test("a provider's own model ids map to OpenRouter's, only where the mapping is clear", () => {
        assert.deepEqual(catalogueCandidates("claude-sonnet-4-5-20250929"), [
            "anthropic/claude-sonnet-4-5-20250929",
            "anthropic/claude-sonnet-4-5",
            "anthropic/claude-sonnet-4.5",
        ]);
        assert.ok(catalogueCandidates("us.anthropic.claude-sonnet-4-5-20250929-v1:0").includes("anthropic/claude-sonnet-4.5"));
        assert.ok(catalogueCandidates("global.anthropic.claude-opus-4-6-v1").includes("anthropic/claude-opus-4.6"));
        assert.ok(catalogueCandidates("claude-3-5-sonnet-20241022").includes("anthropic/claude-3.5-sonnet"));
        assert.deepEqual(catalogueCandidates("gpt-5.5"), ["openai/gpt-5.5"]);
        assert.deepEqual(catalogueCandidates("models/gemini-3.8-flash"), ["google/gemini-3.8-flash"]);
        assert.deepEqual(catalogueCandidates("grok-4.7"), ["x-ai/grok-4.7"]);
        // Already namespaced (OpenRouter's, Groq's, Together's) or unknown: nothing to guess.
        assert.deepEqual(catalogueCandidates("anthropic/claude-sonnet-4.5"), []);
        assert.deepEqual(catalogueCandidates("meta-llama/Llama-3.3-70B-Instruct-Turbo"), []);
        assert.deepEqual(catalogueCandidates("my-deployment"), []);
    });
});

describe("model URLs people give", () => {
    test("private, loopback, link-local and reserved addresses, in every form", () => {
        for (const a of [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:a9fe:a9fe",
            "64:ff9b::a00:1",
            "2002:0a00:0001::1",
            "not an address",
        ])
            assert.equal(isPrivateAddress(a), true, a);
        for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2002:0808:0808::1", "64:ff9b::808:808"])
            assert.equal(isPrivateAddress(a), false, a);
    });

    const hosts: Record<string, string[]> = {
        "llm.example.com": ["93.184.215.14"],
        "inside.example.com": ["10.0.0.7"],
        "both.example.com": ["93.184.215.14", "10.0.0.7"],
        "v6.example.com": ["2606:4700:4700::1111", "fd12::1"],
        "loopy.example.com": ["127.0.0.1"],
        "ollama.internal": ["192.168.5.10"],
    };
    const lookup: Lookup = async (h) => {
        const a = hosts[h];
        if (!a) throw new Error("ENOTFOUND");
        return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    };
    const strict = { allowPrivate: false, lookup };
    const relaxed = { allowPrivate: true, lookup };
    const refused = (url: string, policy: typeof strict, why: RegExp) =>
        assert.rejects(checkModelUrl(url, policy), (e: Error) => e instanceof UnsafeUrl && why.test(e.message), url);

    test("must be https and public: every address a name resolves to is checked", async () => {
        assert.equal(await checkModelUrl("https://llm.example.com/v1/", strict), "https://llm.example.com/v1");
        await refused("https://inside.example.com/v1", strict, /private or loopback address \(inside\.example\.com\)/);
        await refused("https://loopy.example.com/v1", strict, /private or loopback/);
        await refused("https://both.example.com/v1", strict, /private or loopback/);
        await refused("https://v6.example.com/v1", strict, /private or loopback/);
        await refused("https://10.0.0.1/v1", strict, /private or loopback/);
        await refused("https://[::1]:8443/v1", strict, /private or loopback/);
        await refused("https://169.254.169.254/latest", strict, /ALLOW_PRIVATE_MODEL_URLS=true/);
        await refused("http://llm.example.com/v1", strict, /must use https/);
        await refused("ftp://llm.example.com/v1", strict, /must start https/);
        await refused("https://user:pw@llm.example.com/v1", strict, /user name or password/);
        await refused("https://llm.example.com/v1?key=x", strict, /query string/);
        await refused("https://nowhere.example.com/v1", strict, /doesn't resolve/);
        await refused("not a url", strict, /isn't a valid address/);
    });

    test("a name that really resolves to loopback is refused (the system resolver)", async () => {
        await assert.rejects(checkModelUrl("https://localhost:11434/v1", { allowPrivate: false, lookup: defaultLookup }), UnsafeUrl);
    });

    test("ALLOW_PRIVATE_MODEL_URLS: private addresses, and plain http only to them", async () => {
        assert.equal(await checkModelUrl("http://ollama.internal:11434/v1", relaxed), "http://ollama.internal:11434/v1");
        assert.equal(await checkModelUrl("https://inside.example.com/v1", relaxed), "https://inside.example.com/v1");
        assert.equal(await checkModelUrl("http://127.0.0.1:11434/v1", relaxed), "http://127.0.0.1:11434/v1");
        await refused("http://llm.example.com/v1", relaxed, /must use https/);
        await refused("http://both.example.com/v1", relaxed, /must use https/);
    });
});

describe("providers' model lists", () => {
    test("OpenAI's shape, a bare array (Together, Mistral), Anthropic's and Cohere's; Gemini's prefix dropped", () => {
        assert.deepEqual(parseModelList({ object: "list", data: [{ id: "b" }, { id: "a" }, { id: "a" }] }), [
            { id: "a", name: null },
            { id: "b", name: null },
        ]);
        assert.deepEqual(parseModelList([{ id: "x/y", object: "model" }]), [{ id: "x/y", name: null }]);
        assert.deepEqual(parseModelList({ data: [{ id: "claude-x", display_name: "Claude X" }], has_more: false }), [
            { id: "claude-x", name: "Claude X" },
        ]);
        assert.deepEqual(parseModelList({ models: [{ name: "command-a", endpoints: ["chat"] }] }), [{ id: "command-a", name: null }]);
        assert.deepEqual(parseModelList({ data: [{ id: "models/gemini-3.8-flash", object: "model" }] }), [
            { id: "gemini-3.8-flash", name: null },
        ]);
    });

    test("ids that aren't model names are left out; something that isn't a list is an error", () => {
        assert.deepEqual(parseModelList({ data: [{ id: "<script>" }, { id: 5 }, null, { id: "ok" }] }), [{ id: "ok", name: null }]);
        assert.throws(() => parseModelList({ error: "nope" }), SyntaxError);
    });
});
