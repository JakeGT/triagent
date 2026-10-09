// A workspace's favourite models: settings saved before favourites read as one favourite (the default),
// adding, renaming, reordering and removing them, which is the default, who may do what, and that reviews
// still run with the default. Keys are made up at runtime; nothing reaches a real provider.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Actor } from "../src/services/core.ts";
import type { RunModel } from "../src/services/models.ts";
import { type RunnerHello, specForBranch } from "../src/services/runs.ts";
import type { Project, Workspace } from "../src/store/types.ts";
import { ADMIN_PASSWORD, type Session, type TestApp, testApp } from "./helpers.ts";
import { patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const ADMIN: Actor = { name: "admin", userId: null, via: "web" };
const fakeKey = (prefix = "") => `${prefix}${randomBytes(24).toString("base64url")}`;

interface Fav {
    id: string;
    provider: string;
    providerName: string;
    model: string;
    name: string | null;
    isDefault: boolean;
    ready: boolean;
    missing: string | null;
}

let t: TestApp;
let admin: Session;
let n = 0;

before(async () => {
    t = await testApp();
    admin = await t.signIn("admin", ADMIN_PASSWORD);
});

async function newWorkspace(): Promise<Workspace> {
    const slug = `fav-${++n}`;
    assert.equal((await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug } })).status, 201);
    return (await t.services.store.workspaces.bySlug(slug)) as Workspace;
}

type Who = { session?: Session; token?: string };
const base = (w: Workspace) => `/api/v1/w/${w.slug}/settings`;
const view = (w: Workspace, who: Who = { session: admin }) => t.request(`${base(w)}/review-model`, who);
const list = async (w: Workspace, who: Who = { session: admin }) =>
    (await t.request(`${base(w)}/models/favourites`, who)).body as { favourites: Fav[]; defaultId: string | null };
const add = (w: Workspace, body: object, who: Who = { session: admin }) =>
    t.request(`${base(w)}/models/favourites`, { method: "POST", body, ...who });
const update = (w: Workspace, id: string, body: object, who: Who = { session: admin }) =>
    t.request(`${base(w)}/models/favourites/${id}`, { method: "PATCH", body, ...who });
const remove = (w: Workspace, id: string, query = "", who: Who = { session: admin }) =>
    t.request(`${base(w)}/models/favourites/${id}${query}`, { method: "DELETE", ...who });
const setDefault = (w: Workspace, id: string, who: Who = { session: admin }) =>
    t.request(`${base(w)}/models/default`, { method: "PUT", body: { id }, ...who });
const reorder = (w: Workspace, ids: string[], who: Who = { session: admin }) =>
    t.request(`${base(w)}/models/favourites/order`, { method: "PUT", body: { ids }, ...who });
const putKey = (w: Workspace, provider: string, key = fakeKey()) =>
    t.request(`${base(w)}/review-model/keys/${provider}`, { method: "PUT", session: admin, body: { key } });
const forRun = (w: Workspace) => t.services.models.forRun(w);
const put = (w: Workspace, value: unknown) =>
    t.services.store.settings.put({ workspaceId: w.id, projectId: null, key: "review-model", value });
const stored = async (w: Workspace) => (await t.services.store.settings.get(w.id, null, "review-model"))?.value as Record<string, unknown>;

describe("settings saved before favourites", () => {
    test("the provider and its model are the first favourite and the default, and reviews run as before", async () => {
        const w = await newWorkspace();
        const key = fakeKey("sk-");
        await putKey(w, "openai", key);
        await put(w, {
            provider: "openai",
            models: { openai: "gpt-5.5-pro", mistral: "codestral-latest" },
            options: { openai: { protocol: "openai-responses" } },
        });
        const before = (await forRun(w)) as RunModel;
        assert.deepEqual(
            [before.provider, before.model, before.protocol, before.apiKey],
            ["openai", "gpt-5.5-pro", "openai-responses", key],
        );

        const v = (await view(w)).body;
        assert.deepEqual([v.provider, v.model, v.ready], ["openai", "gpt-5.5-pro", true]);
        assert.equal(v.favourites.length, 1);
        const [f] = v.favourites as Fav[];
        assert.deepEqual(
            {
                provider: f?.provider,
                providerName: f?.providerName,
                model: f?.model,
                name: f?.name,
                isDefault: f?.isDefault,
                ready: f?.ready,
            },
            { provider: "openai", providerName: "OpenAI", model: "gpt-5.5-pro", name: null, isDefault: true, ready: true },
        );
        assert.equal(v.defaultId, f?.id);
        // Reading changes nothing, and the favourite's id is the same every time until it's saved.
        assert.equal((await stored(w)).favourites, undefined);
        assert.equal((await list(w)).favourites[0]?.id, f?.id);

        // The next save writes the new shape, with that id, and the legacy fields still name the default.
        assert.equal((await update(w, f?.id as string, { name: "Careful" })).status, 200);
        const saved = await stored(w);
        assert.deepEqual(saved.favourites, [{ id: f?.id, provider: "openai", model: "gpt-5.5-pro", name: "Careful" }]);
        assert.deepEqual([saved.defaultId, saved.provider], [f?.id, "openai"]);
        assert.deepEqual(saved.models, { openai: "gpt-5.5-pro", mistral: "codestral-latest" });
        // Reviews run with the same thing; people now know it by its nickname.
        assert.deepEqual(await forRun(w), { ...before, label: "Careful" });
    });

    test("a provider chosen without a key is still the default favourite, saying what it needs", async () => {
        const w = await newWorkspace();
        await put(w, { provider: "anthropic", models: {} });
        const { favourites, defaultId } = await list(w);
        assert.equal(favourites.length, 1);
        assert.deepEqual(
            [favourites[0]?.provider, favourites[0]?.isDefault, favourites[0]?.ready, favourites[0]?.missing],
            ["anthropic", true, false, "an Anthropic API key"],
        );
        assert.equal(defaultId, favourites[0]?.id);
        assert.deepEqual(await forRun(w), { ready: false, reason: "Add an Anthropic API key in Settings → Models." });
    });

    test("a new workspace has no favourite until a provider is set up", async () => {
        const w = await newWorkspace();
        assert.deepEqual(await list(w), { favourites: [], defaultId: null });
        assert.deepEqual(await forRun(w), { ready: false, reason: "Add an OpenRouter API key in Settings → Models." });
        // Starting with another provider leaves no stray OpenRouter favourite.
        await putKey(w, "mistral");
        const added = await add(w, { provider: "mistral", model: "codestral-latest" });
        assert.equal(added.status, 201, added.text);
        assert.equal(added.body.favourites.length, 1);
        assert.equal(added.body.defaultId, added.body.favourites[0].id);
        assert.deepEqual([(await view(w)).body.provider, ((await forRun(w)) as RunModel).model], ["mistral", "codestral-latest"]);

        // Setting just an OpenRouter key, as always worked: its usual model is the favourite and the default.
        const other = await newWorkspace();
        await putKey(other, "openrouter", fakeKey("sk-or-v1-"));
        const { favourites } = await list(other);
        assert.deepEqual(
            [favourites.length, favourites[0]?.provider, favourites[0]?.isDefault, favourites[0]?.ready],
            [1, "openrouter", true, true],
        );
        assert.equal(((await forRun(other)) as RunModel).model, favourites[0]?.model);
    });

    test("choosing a provider and model the old way changes the default favourite, and keeps the others", async () => {
        const w = await newWorkspace();
        await putKey(w, "openai");
        await putKey(w, "mistral");
        const patch = (body: object) => t.request(`${base(w)}/review-model`, { method: "PATCH", session: admin, body });
        assert.equal((await patch({ provider: "openai", model: "gpt-5.5-pro" })).status, 200);
        const first = (await list(w)).favourites[0] as Fav;
        const second = (await add(w, { provider: "mistral", model: "codestral-latest", name: "Fast" })).body.favourites[1] as Fav;
        // A new model: the default favourite becomes it, with the same id.
        assert.equal((await patch({ model: "gpt-5.5" })).status, 200);
        let now = await list(w);
        assert.deepEqual(
            now.favourites.map((f) => [f.id, f.model, f.isDefault]),
            [
                [first.id, "gpt-5.5", true],
                [second.id, "codestral-latest", false],
            ],
        );
        // A model that's a favourite already: it becomes the default, and nothing is duplicated.
        assert.equal((await patch({ provider: "mistral", model: "codestral-latest" })).status, 200);
        now = await list(w);
        assert.deepEqual([now.favourites.length, now.defaultId], [2, second.id]);
        assert.equal(((await forRun(w)) as RunModel).model, "codestral-latest");
        // A provider's settings alone never move the default.
        const configured = await t.request(`${base(w)}/review-model/providers/openai`, {
            method: "PATCH",
            session: admin,
            body: { protocol: "openai-responses" },
        });
        assert.equal(configured.status, 200, configured.text);
        assert.deepEqual([configured.body.provider, configured.body.defaultId], ["mistral", second.id]);
        assert.equal(configured.body.providers.find((p: { id: string }) => p.id === "openai").protocol, "openai-responses");
    });
});

describe("favourites", () => {
    test("add from several providers, each ready or saying what its provider needs", async () => {
        const w = await newWorkspace();
        await putKey(w, "anthropic", fakeKey("sk-ant-"));
        const a = await add(w, { provider: "anthropic", model: " claude-opus-5-5 ", name: "  Careful " });
        assert.equal(a.status, 201, a.text);
        const b = await add(w, { provider: "bedrock", model: "global.anthropic.claude-opus-4-6-v1" });
        assert.equal(b.status, 201, b.text);
        const { favourites, defaultId } = b.body as { favourites: Fav[]; defaultId: string };
        assert.deepEqual(
            favourites.map((f) => [f.providerName, f.model, f.name, f.isDefault, f.ready, f.missing]),
            [
                ["Anthropic", "claude-opus-5-5", "Careful", true, true, null],
                ["Amazon Bedrock", "global.anthropic.claude-opus-4-6-v1", null, false, false, "an AWS region for Amazon Bedrock"],
            ],
        );
        assert.equal(defaultId, favourites[0]?.id);
        assert.match(favourites[1]?.id as string, /^[\w-]{8}$/);
        assert.notEqual(favourites[0]?.id, favourites[1]?.id);
        // The settings view carries them too, and says which providers are in use.
        const v = (await view(w)).body;
        assert.deepEqual(v.favourites, favourites);
        const connected = v.providers.filter((p: { connected: boolean }) => p.connected).map((p: { id: string }) => p.id);
        assert.deepEqual(connected.sort(), ["anthropic", "bedrock"]);
        assert.equal(v.providers.find((p: { id: string }) => p.id === "anthropic").needs, null);
        // Recorded for the workspace's admins.
        const audit = (await t.request(`${base(w)}/audit`, { session: admin })).body.items as { target: string; changes: object }[];
        assert.deepEqual(audit.find((r) => r.target === "review-model")?.changes, {
            favourite: "added",
            provider: "bedrock",
            model: "global.anthropic.claude-opus-4-6-v1",
        });
    });

    test("what's refused: unknown providers, bad names, duplicates, long nicknames, more than twenty", async () => {
        const w = await newWorkspace();
        assert.equal((await add(w, { provider: "nonsense", model: "x" })).status, 400);
        assert.equal((await add(w, { provider: "openai", model: "has spaces" })).status, 400);
        assert.equal((await add(w, { provider: "openai", model: "" })).status, 400);
        assert.equal((await add(w, { provider: "openai", model: "gpt-5.5", name: "n".repeat(41) })).status, 400);
        assert.equal((await add(w, { provider: "openai", model: "gpt-5.5", name: "line\nbreak" })).status, 400);
        assert.equal((await add(w, { provider: "openai", model: "gpt-5.5", name: "n".repeat(40) })).status, 201);
        const dup = await add(w, { provider: "openai", model: "gpt-5.5" });
        assert.equal(dup.status, 400);
        assert.equal(dup.body.error, "gpt-5.5 from OpenAI is a favourite already.");
        // The same model name from another provider is a different favourite.
        assert.equal((await add(w, { provider: "azure", model: "gpt-5.5" })).status, 201);
        for (let i = 2; i < 20; i++) assert.equal((await add(w, { provider: "openai", model: `model-${i}` })).status, 201);
        const full = await add(w, { provider: "openai", model: "one-too-many" });
        assert.equal(full.status, 400);
        assert.match(full.body.error, /up to 20 favourite models/);
        assert.equal((await list(w)).favourites.length, 20);
    });

    test("rename, change the model, reorder", async () => {
        const w = await newWorkspace();
        const ids = [];
        for (const model of ["model-a", "model-b", "model-c"])
            ids.push(((await add(w, { provider: "openai", model })).body.favourites as Fav[]).at(-1)?.id as string);
        const [a, b, c] = ids as [string, string, string];
        assert.equal((await update(w, b, { name: "Fast" })).status, 200);
        assert.equal((await update(w, b, { model: "model-b2" })).status, 200);
        // A favourite keeps its id and its nickname when its model changes; an empty nickname clears it.
        let now = await list(w);
        assert.deepEqual(now.favourites[1], { ...now.favourites[1], id: b, model: "model-b2", name: "Fast" });
        assert.equal((await update(w, b, { name: "" })).body.favourites[1].name, null);
        assert.equal((await update(w, b, { model: "model-a" })).status, 400);
        assert.equal((await update(w, b, { model: "not valid" })).status, 400);
        assert.equal((await update(w, "nope", { name: "x" })).status, 404);

        assert.equal((await reorder(w, [c, a, b])).status, 200);
        now = await list(w);
        assert.deepEqual(
            now.favourites.map((f) => f.id),
            [c, a, b],
        );
        // The default is still the one it was.
        assert.equal(now.defaultId, a);
        for (const bad of [[c, a], [c, a, b, b], [c, a, "nope"], []]) assert.equal((await reorder(w, bad)).status, 400);
    });

    test("the default: set it, and it can't be removed without naming the next one; nor can the last favourite", async () => {
        const w = await newWorkspace();
        await putKey(w, "openai");
        await putKey(w, "mistral");
        const a = (await add(w, { provider: "openai", model: "gpt-5.5" })).body.favourites[0].id as string;
        const b = (await add(w, { provider: "mistral", model: "codestral-latest" })).body.favourites[1].id as string;
        const c = (await add(w, { provider: "mistral", model: "mistral-medium-latest", makeDefault: true })).body.favourites[2]
            .id as string;
        assert.equal((await list(w)).defaultId, c);
        assert.equal(((await forRun(w)) as RunModel).model, "mistral-medium-latest");

        assert.equal((await setDefault(w, a)).status, 200);
        assert.equal((await setDefault(w, "nope")).status, 404);
        const v = (await view(w)).body;
        assert.deepEqual([v.defaultId, v.provider, v.model], [a, "openai", "gpt-5.5"]);
        assert.deepEqual([((await forRun(w)) as RunModel).provider, ((await forRun(w)) as RunModel).model], ["openai", "gpt-5.5"]);

        // Removing the default needs the favourite that takes over.
        const refused = await remove(w, a);
        assert.equal(refused.status, 400);
        assert.equal(refused.body.error, "This is the default model. Choose another favourite as the default to remove it.");
        assert.equal((await remove(w, a, `?defaultId=${a}`)).status, 400);
        assert.equal((await remove(w, a, "?defaultId=nope")).status, 400);
        const removed = await remove(w, a, `?defaultId=${b}`);
        assert.equal(removed.status, 200, removed.text);
        assert.deepEqual([removed.body.favourites.length, removed.body.defaultId], [2, b]);
        assert.equal(((await forRun(w)) as RunModel).model, "codestral-latest");

        // One that isn't the default just goes.
        assert.equal((await remove(w, c)).status, 200);
        assert.equal((await remove(w, c)).status, 404);
        const last = await remove(w, b);
        assert.equal(last.status, 400);
        assert.match(last.body.error, /keeps at least one favourite model/);
        assert.deepEqual([(await list(w)).favourites.length, (await list(w)).defaultId], [1, b]);
    });

    test("resolveFavourite: what a favourite would run with, or what it needs", async () => {
        const w = await newWorkspace();
        const key = fakeKey();
        await putKey(w, "mistral", key);
        const a = (await add(w, { provider: "openai", model: "gpt-5.5" })).body.favourites[0].id as string;
        const b = (await add(w, { provider: "mistral", model: "codestral-latest", name: "Fast" })).body.favourites[1].id as string;
        const waiting = await t.services.settings.resolveFavourite(w, a);
        assert.deepEqual([waiting?.ready, waiting && !waiting.ready && waiting.missing], [false, "an OpenAI API key"]);
        const ready = await t.services.settings.resolveFavourite(w, b);
        assert.ok(ready?.ready);
        assert.deepEqual(
            [ready.model.provider, ready.model.model, ready.model.apiKey, ready.model.url, ready.favourite.name],
            ["mistral", "codestral-latest", key, "https://api.mistral.ai/v1", "Fast"],
        );
        assert.equal(await t.services.settings.resolveFavourite(w, "nope"), null);
    });
});

describe("who may change favourites", () => {
    let w: Workspace;
    let manage: string;
    let read: string;
    let viewer: Session;

    before(async () => {
        w = await newWorkspace();
        const token = async (scope: string) =>
            (await t.request(`${base(w)}/tokens`, { method: "POST", session: admin, body: { name: scope, scope } })).body.token as string;
        manage = await token("manage");
        read = await token("read");
        const password = `${randomBytes(12).toString("base64url")}-one`;
        const created = await t.request("/api/v1/instance/users", { method: "POST", session: admin, body: { username: "vera", password } });
        assert.equal(created.status, 201, created.text);
        const first = await t.signIn("vera", password);
        const next = `${randomBytes(12).toString("base64url")}-two`;
        assert.equal(
            (await t.request("/api/v1/me/password", { method: "POST", session: first, body: { current: password, password: next } }))
                .status,
            200,
        );
        viewer = await t.signIn("vera", next);
        assert.equal(
            (await t.request(`${base(w)}/members`, { method: "POST", session: admin, body: { username: "vera", role: "viewer" } })).status,
            201,
        );
    });

    test("a manage token manages favourites and providers' settings, but never keys", async () => {
        const who = { token: manage };
        const a = await add(w, { provider: "openai", model: "gpt-5.5" }, who);
        assert.equal(a.status, 201, a.text);
        const b = await add(w, { provider: "mistral", model: "codestral-latest" }, who);
        const [first, second] = (b.body.favourites as Fav[]).map((f) => f.id) as [string, string];
        assert.equal((await update(w, second, { name: "Fast" }, who)).status, 200);
        assert.equal((await setDefault(w, second, who)).status, 200);
        assert.equal((await reorder(w, [second, first], who)).status, 200);
        assert.equal((await remove(w, first, "", who)).status, 200);
        const settings = await t.request(`${base(w)}/review-model/providers/openai`, {
            method: "PATCH",
            token: manage,
            body: { protocol: "openai-responses" },
        });
        assert.equal(settings.status, 200, settings.text);
        const key = await t.request(`${base(w)}/review-model/keys/mistral`, { method: "PUT", token: manage, body: { key: fakeKey() } });
        assert.equal(key.status, 403);
        assert.equal((await list(w)).favourites[0]?.ready, false);
    });

    test("a token can't move the address a provider's stored key is sent to", async () => {
        const custom = (body: object, who: Who) => t.request(`${base(w)}/review-model/providers/custom`, { method: "PATCH", body, ...who });
        // Addresses are checked by name here (no test DNS): an address that's a public IP needs none.
        assert.equal((await custom({ url: "https://93.184.215.14/v1" }, { token: manage })).status, 200);
        await putKey(w, "custom");
        assert.equal((await custom({ url: "https://93.184.215.14/v1", protocol: "anthropic" }, { token: manage })).status, 200);
        assert.equal((await custom({ url: "https://93.184.215.15/v1" }, { token: manage })).status, 403);
        assert.equal((await custom({ url: null }, { token: manage })).status, 403);
        assert.equal((await custom({ url: "https://93.184.215.15/v1" }, { session: admin })).status, 200);
    });

    test("viewers and read tokens see the favourites and change nothing", async () => {
        for (const who of [{ session: viewer }, { token: read }]) {
            const seen = await t.request(`${base(w)}/models/favourites`, who);
            assert.equal(seen.status, 200);
            assert.equal(seen.body.favourites.length, 1);
            const id = seen.body.favourites[0].id as string;
            assert.equal((await view(w, who)).body.favourites.length, 1);
            assert.equal((await add(w, { provider: "openai", model: "gpt-5.5-pro" }, who)).status, 403);
            assert.equal((await update(w, id, { name: "Mine" }, who)).status, 403);
            assert.equal((await setDefault(w, id, who)).status, 403);
            assert.equal((await reorder(w, [id], who)).status, 403);
            assert.equal((await remove(w, id, "", who)).status, 403);
            const settings = await t.request(`${base(w)}/review-model/providers/openai`, {
                method: "PATCH",
                body: { protocol: "openai" },
                ...who,
            });
            assert.equal(settings.status, 403);
        }
        assert.equal((await list(w)).favourites[0]?.name, "Fast");
    });

    test("someone outside the workspace reaches none of it", async () => {
        const other = await newWorkspace();
        const id = (await add(other, { provider: "openai", model: "gpt-5.5" })).body.favourites[0].id as string;
        assert.notEqual((await t.request(`${base(other)}/models/favourites`, { session: viewer })).status, 200);
        assert.notEqual((await update(other, id, { name: "x" }, { token: manage })).status, 200);
        assert.equal((await list(other)).favourites[0]?.name, null);
    });
});

describe("the instance model", () => {
    test("stays one model: choosing another replaces it", async () => {
        await t.services.allowances.setModel(ADMIN, { provider: "openai", model: "gpt-5.5" });
        const first = await t.services.allowances.view();
        assert.deepEqual(
            [first.provider, first.model, first.favourites.length, first.favourites[0]?.isDefault],
            ["openai", "gpt-5.5", 1, true],
        );
        await t.services.allowances.setModel(ADMIN, { provider: "mistral", model: "codestral-latest" });
        const second = await t.services.allowances.view();
        assert.deepEqual(
            second.favourites.map((f) => [f.id, f.provider, f.model]),
            [[first.favourites[0]?.id, "mistral", "codestral-latest"]],
        );
        assert.equal(second.defaultId, first.favourites[0]?.id);
        await t.services.allowances.setModel(ADMIN, { provider: "openrouter" });
    });
});

describe("reviews", () => {
    let env: ReviewEnv;
    let project: Project;
    let w: Workspace;
    const runner: RunnerHello = { id: "runner-fav-0000", name: "fav", version: "1", slots: 1 };

    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme", { model: "fake/first" });
        w = (await env.t.services.store.workspaces.bySlug("acme")) as Workspace;
        project = (await env.t.services.store.projects.bySlug(w.id, "app")) as Project;
    });
    after(() => env.close());

    test("run with the default favourite, whichever it is now", async () => {
        const request = (path: string, method: string, body: object) =>
            env.t.request(`/api/v1/w/acme/settings/models/${path}`, { method, session: env.admin, body });
        const claimModel = async () => {
            const job = await env.t.services.runs.enqueue(ADMIN, project, specForBranch("full", "main", null));
            const claimed = await env.t.services.runs.claim(runner);
            assert.equal(claimed?.id, job.id);
            await env.t.services.runs.finish(runner, job.id, { status: "failed", error: "test" });
            return claimed?.model.model;
        };
        assert.equal(await claimModel(), "fake/first");
        const added = await request("favourites", "POST", { provider: "openrouter", model: "fake/second", name: "Second" });
        assert.equal(added.status, 201, added.text);
        // Adding a favourite doesn't change what reviews use.
        assert.equal(await claimModel(), "fake/first");
        assert.equal((await request("default", "PUT", { id: added.body.favourites[1].id })).status, 200);
        assert.equal(await claimModel(), "fake/second");
    });
});
