// Review models' configuration, the same for a workspace (Settings → Models) and for the instance (the
// instance model key): each provider's settings (protocol, endpoint URL, AWS region) and its secrets (the
// key; for Bedrock also the access key ID), and the favourites, the models in use, each a provider's model
// with an optional nickname, one of them the default. A workspace keeps several favourites across several
// providers; the instance keeps one. Settings live in the settings tables; secrets are encrypted
// (services/secrets.ts) and never returned.
//
// Before favourites there was one "current provider" and a model chosen for each provider. Those fields
// are still stored and still say what the default favourite is, so everything that reads them is unchanged.
// A setting saved before favourites is read as one favourite, its provider and model, and is written in
// the new shape the next time it's saved.

import { createHash, randomBytes } from "node:crypto";
import { MODEL_PROTOCOLS, type ModelProtocol, type RunnerModel } from "@triagent/shared/model";
import { badRequest, notFound } from "../errors.ts";
import type { Repos, Workspace } from "../store/types.ts";
import type { Actor, Core } from "./core.ts";
import { checkModelUrl, defaultLookup, type Lookup, UnsafeUrl } from "./model-urls.ts";
import {
    AWS_ACCESS_KEY_ID,
    AWS_REGION,
    aOrAn,
    azureBaseUrl,
    defaultModel,
    PROVIDER_IDS,
    type ProviderSpec,
    providerById,
} from "./providers.ts";
import type { SecretScope, SecretView } from "./secrets.ts";

export interface ProviderOptions {
    protocol?: ModelProtocol;
    /** Azure's endpoint, or a custom server's base URL. */
    url?: string;
    /** Bedrock's AWS region. */
    region?: string;
}

/** A model in use: a provider's model, with a nickname if it has one. Its id never changes. */
export interface Favourite {
    id: string;
    provider: string;
    model: string;
    name?: string;
}

export interface StoredModel {
    /** The default favourite's provider (or, with no default, the provider last chosen). */
    provider: string;
    /** The model last chosen for each provider; the default favourite's is its own. */
    models: Record<string, string>;
    options?: Record<string, ProviderOptions>;
    favourites: Favourite[];
    defaultId: string | null;
}

export interface FavouriteView {
    id: string;
    provider: string;
    providerName: string;
    model: string;
    name: string | null;
    isDefault: boolean;
    ready: boolean;
    /** What it still needs, as "Add …" would finish it. */
    missing: string | null;
    /**
     * Whether it can be the model asked which findings are the same problem (a review's `judge`): any but
     * one on Amazon Bedrock, whose requests only Open Code Review knows how to sign.
     */
    canJudge: boolean;
}

export interface FavouritesView {
    favourites: FavouriteView[];
    defaultId: string | null;
}

/** Whose configuration: a workspace's, or the instance's (belonging to no workspace). */
export type Place = { kind: "workspace"; workspace: Workspace } | { kind: "instance" };

export interface ResolvedModel extends RunnerModel {
    /** The URL came from a person (Azure, custom): check it again when a review starts. */
    userUrl: boolean;
}

export type Resolution = { ready: true; model: ResolvedModel; spec: ProviderSpec } | { ready: false; missing: string; spec: ProviderSpec };

export interface ModelChoice {
    provider?: string;
    model?: string;
    protocol?: string;
    url?: string | null;
    region?: string | null;
}

export interface ProviderSettings {
    protocol?: string;
    url?: string | null;
    region?: string | null;
}

export interface NewFavourite {
    provider: string;
    model: string;
    name?: string | null;
    makeDefault?: boolean;
}

export type SecretKind = "key" | "accessKeyId";

export const MODEL_NAME = /^[\w.:/@+-]{1,150}$/;
export const MAX_FAVOURITES = 20;
export const MAX_FAVOURITE_NAME = 40;
/** How many are read back: more than people can add, since adopting projects' old lists may pass that. */
const MAX_KEPT_FAVOURITES = 200;
const FALLBACK = "openrouter";
const INSTANCE: SecretScope = { workspaceId: null, projectId: null };
const INSTANCE_KEY = "instance-model";
const WORKSPACE_KEY = "review-model";

export const modelKeyName = (provider: string) => `model-key:${provider}`;
export const accessKeyIdName = (provider: string) => `model-key:${provider}:access-key-id`;

/** The protocol a provider is used with: the one chosen, if it still offers it, or its default. */
const protocolOf = (spec: ProviderSpec, opts: ProviderOptions): ModelProtocol =>
    opts.protocol && spec.protocols.includes(opts.protocol) ? opts.protocol : (spec.protocols[0] as ModelProtocol);

/** What a provider still needs, as "Add …" would finish it, or null when it has everything. */
function missingOf(spec: ProviderSpec, opts: ProviderOptions, model: string, key: boolean, accessKeyId: boolean): string | null {
    if (spec.fields.includes("url") && !opts.url) return spec.id === "custom" ? "your server's base URL" : `the ${spec.name} endpoint`;
    if (spec.fields.includes("region") && !opts.region) return `an AWS region for ${spec.name}`;
    if (spec.fields.includes("accessKeyId") && !accessKeyId) return `an AWS access key ID for ${spec.name}`;
    if (!key)
        return spec.id === "custom"
            ? "an API key for your server"
            : spec.keyLabel === "API key"
              ? `${aOrAn(spec.name)} API key`
              : `an ${spec.keyLabel} for ${spec.name}`;
    if (!model) return `a model for ${spec.name}`;
    return null;
}

/** Whether a provider has been set up at all: a secret stored, or any of its settings given. */
const startedOf = (opts: ProviderOptions, key: boolean, accessKeyId: boolean): boolean =>
    key || accessKeyId || Boolean(opts.url || opts.region || opts.protocol);

const newId = () => randomBytes(6).toString("base64url");
/** The id of a favourite read out of settings that have none yet: the same every time, until it's saved. */
const impliedId = (provider: string, model: string) => createHash("sha256").update(`${provider}\0${model}`).digest("base64url").slice(0, 8);
const same = (f: Favourite, provider: string, model: string) => f.provider === provider && f.model === model;

function cleanFavourites(value: unknown): Favourite[] {
    const out: Favourite[] = [];
    for (const raw of Array.isArray(value) ? value.slice(0, MAX_KEPT_FAVOURITES) : []) {
        const f = (raw && typeof raw === "object" ? raw : {}) as Partial<Favourite>;
        if (typeof f.id !== "string" || !f.id || typeof f.provider !== "string" || typeof f.model !== "string") continue;
        if (!providerById(f.provider) || !MODEL_NAME.test(f.model)) continue;
        if (out.some((x) => x.id === f.id || same(x, f.provider as string, f.model as string))) continue;
        const name = typeof f.name === "string" ? f.name.trim().slice(0, MAX_FAVOURITE_NAME) : "";
        out.push({ id: f.id, provider: f.provider, model: f.model, ...(name ? { name } : {}) });
    }
    return out;
}

/** The legacy fields say what the default favourite is. */
function withDefault(s: StoredModel): StoredModel {
    const d = s.favourites.find((f) => f.id === s.defaultId);
    if (!d) return { ...s, defaultId: null };
    return { ...s, provider: d.provider, models: { ...s.models, [d.provider]: d.model } };
}

/**
 * Settings as stored, tidied. `started` says whether a provider has been set up; it's asked only when
 * there are no favourites, to decide whether the provider's own model counts as one (see below).
 */
async function clean(value: unknown, started: (provider: string, opts: ProviderOptions) => Promise<boolean>): Promise<StoredModel> {
    const v = (value && typeof value === "object" ? value : {}) as Partial<StoredModel>;
    const provider = typeof v.provider === "string" && providerById(v.provider) ? v.provider : FALLBACK;
    const s: StoredModel = {
        provider,
        models: { ...v.models },
        options: { ...v.options },
        favourites: cleanFavourites(v.favourites),
        defaultId: null,
    };
    if (s.favourites.length) {
        // A default that's gone missing is the favourite the legacy fields name, if there is one.
        const chosen =
            s.favourites.find((f) => f.id === v.defaultId) ?? s.favourites.find((f) => same(f, provider, s.models[provider] ?? ""));
        return withDefault({ ...s, defaultId: chosen?.id ?? null });
    }
    // No favourites yet. Settings from before favourites named a provider: it and its model are the first
    // favourite and the default. Settings that never named one (a new workspace) get the usual provider's
    // model only once that provider is set up, so a workspace that starts with another has no stray favourite.
    const model = s.models[provider] ?? defaultModel(providerById(provider) as ProviderSpec);
    if (!MODEL_NAME.test(model)) return s;
    const before = !Array.isArray(v.favourites) && typeof v.provider === "string";
    if (!before && !(await started(provider, s.options?.[provider] ?? {}))) return s;
    const id = impliedId(provider, model);
    return withDefault({ ...s, favourites: [{ id, provider, model }], defaultId: id });
}

/**
 * Make `provider`'s `model` the default, as choosing a provider and model always has: the favourite that
 * is that model already, otherwise the default favourite changed to it (the instance's only one, always),
 * otherwise a new one. With no model to name (a provider without one chosen), nothing is the default.
 */
function chooseDefault(s: StoredModel, provider: string, model: string, single: boolean): Pick<StoredModel, "favourites" | "defaultId"> {
    if (!MODEL_NAME.test(model)) return { favourites: single ? [] : s.favourites, defaultId: null };
    const existing = s.favourites.find((f) => same(f, provider, model));
    if (existing && !single) return { favourites: s.favourites, defaultId: existing.id };
    const current = s.favourites.find((f) => f.id === s.defaultId) ?? (single ? s.favourites[0] : undefined);
    const next: Favourite = existing ?? { id: current?.id ?? newId(), provider, model };
    if (single) return { favourites: [next], defaultId: next.id };
    return {
        favourites: current ? s.favourites.map((f) => (f.id === current.id ? next : f)) : [...s.favourites, next],
        defaultId: next.id,
    };
}

/** A nickname, tidied: undefined for none. */
function nameOf(name: string | null | undefined): string | undefined {
    const text = name?.trim() ?? "";
    if (text.length > MAX_FAVOURITE_NAME) throw badRequest(`A model's nickname can be up to ${MAX_FAVOURITE_NAME} characters.`);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's refused
    if (/[\u0000-\u001f\u007f]/.test(text)) throw badRequest("A model's nickname can't contain control characters.");
    return text || undefined;
}

function modelNameOf(model: string): string {
    const text = model.trim();
    if (!MODEL_NAME.test(text)) throw badRequest("That isn't a valid model name.");
    return text;
}

export class ModelSetup {
    private readonly core: Core;
    private readonly lookup: Lookup;

    constructor(core: Core, lookup: Lookup = defaultLookup) {
        this.core = core;
        this.lookup = lookup;
    }

    private scope(place: Place): SecretScope {
        return place.kind === "instance" ? INSTANCE : { workspaceId: place.workspace.id, projectId: null };
    }

    async stored(repos: Repos, place: Place): Promise<StoredModel> {
        const scope = this.scope(place);
        return clean(
            place.kind === "instance"
                ? await repos.instanceSettings.get(INSTANCE_KEY)
                : (await repos.settings.get(place.workspace.id, null, WORKSPACE_KEY))?.value,
            async (provider, opts) => {
                const secret = await this.core.secrets.views(repos, scope);
                return startedOf(opts, secret(modelKeyName(provider)).set, secret(accessKeyIdName(provider)).set);
            },
        );
    }

    private async save(repos: Repos, place: Place, value: StoredModel): Promise<void> {
        if (place.kind === "instance") await repos.instanceSettings.put(INSTANCE_KEY, value);
        else await repos.settings.put({ workspaceId: place.workspace.id, projectId: null, key: WORKSPACE_KEY, value });
    }

    private audit(place: Place, target: string) {
        return place.kind === "instance"
            ? { workspaceId: null, target: `instance:${target === WORKSPACE_KEY ? "model" : target}` }
            : { workspaceId: place.workspace.id, target };
    }

    /** Throws a 400 saying why, unless the URL is safe to send a key to; returns it tidied. */
    async checkUrl(url: string, what: string): Promise<string> {
        try {
            return await checkModelUrl(url, { allowPrivate: this.core.config.allowPrivateModelUrls, lookup: this.lookup }, what);
        } catch (err) {
            if (err instanceof UnsafeUrl) throw badRequest(err.message);
            throw err;
        }
    }

    /** Why a person-given URL is no longer acceptable (it now resolves to a private address, say), or null. */
    async recheck(model: ResolvedModel): Promise<string | null> {
        if (!model.userUrl) return null;
        try {
            await checkModelUrl(
                model.url,
                { allowPrivate: this.core.config.allowPrivateModelUrls, lookup: this.lookup },
                "The model's URL",
            );
            return null;
        } catch (err) {
            if (err instanceof UnsafeUrl) return err.message;
            throw err;
        }
    }

    /** For the settings pages: every provider, with its settings and whether its secrets are set (never the secrets). */
    async view(repos: Repos, place: Place) {
        const stored = await this.stored(repos, place);
        const scope = this.scope(place);
        const secret = await this.core.secrets.views(repos, scope);
        const providers = [];
        for (const spec of PROVIDER_IDS.map((id) => providerById(id) as ProviderSpec)) {
            const opts = stored.options?.[spec.id] ?? {};
            const key: SecretView = secret(modelKeyName(spec.id));
            const accessKeyId = spec.fields.includes("accessKeyId") ? secret(accessKeyIdName(spec.id)) : null;
            const model = stored.models[spec.id] ?? defaultModel(spec);
            const missing = missingOf(spec, opts, model, key.set, Boolean(accessKeyId?.set));
            const needs = missingOf(spec, opts, "-", key.set, Boolean(accessKeyId?.set));
            providers.push({
                id: spec.id,
                name: spec.name,
                group: spec.group,
                protocols: spec.protocols,
                protocol: protocolOf(spec, opts),
                /** Where requests go: the fixed base URL, or the one given (null until it is; Bedrock's is the region's). */
                url: spec.id === "azure" && opts.url ? azureBaseUrl(opts.url) : (spec.url ?? opts.url ?? null),
                endpoint: spec.fields.includes("url") ? (opts.url ?? null) : null,
                region: spec.fields.includes("region") ? (opts.region ?? null) : null,
                docs: spec.docs,
                keyFormat: spec.keyFormat,
                keysUrl: spec.keysUrl,
                keyLabel: spec.keyLabel,
                listsModels: spec.models !== null,
                suggested: spec.suggested,
                fields: spec.fields,
                model,
                key,
                accessKeyId,
                ready: missing === null,
                missing,
                /** In use: set up at all (a key, an address, a region), or the provider of a favourite. */
                connected: startedOf(opts, key.set, Boolean(accessKeyId?.set)) || stored.favourites.some((f) => f.provider === spec.id),
                /** What the provider itself still needs, whichever model is used with it. */
                needs,
            });
        }
        const chosen = providers.find((p) => p.id === stored.provider);
        const favourites: FavouriteView[] = stored.favourites.map((f) => {
            const spec = providerById(f.provider) as ProviderSpec;
            const key = secret(modelKeyName(spec.id)).set;
            const missing = missingOf(spec, stored.options?.[spec.id] ?? {}, f.model, key, secret(accessKeyIdName(spec.id)).set);
            return {
                id: f.id,
                provider: f.provider,
                providerName: spec.name,
                model: f.model,
                name: f.name ?? null,
                isDefault: f.id === stored.defaultId,
                ready: missing === null,
                missing,
                canJudge: protocolOf(spec, stored.options?.[spec.id] ?? {}) !== "anthropic-bedrock",
            };
        });
        return {
            provider: stored.provider,
            model: chosen?.model || null,
            ready: Boolean(chosen?.ready),
            missing: chosen?.missing ?? null,
            providers,
            favourites,
            defaultId: stored.defaultId,
        };
    }

    /** The favourites, in order, each ready or saying what it still needs. */
    async favourites(repos: Repos, place: Place): Promise<FavouritesView> {
        const { favourites, defaultId } = await this.view(repos, place);
        return { favourites, defaultId };
    }

    /** The favourite reviews use when nothing else is chosen, if there is one. */
    async defaultFavourite(repos: Repos, workspace: Workspace): Promise<Favourite | null> {
        const stored = await this.stored(repos, { kind: "workspace", workspace });
        return stored.favourites.find((f) => f.id === stored.defaultId) ?? null;
    }

    /**
     * The ids of the favourites that are these providers' models, in order, adding those that aren't
     * favourites yet (for projects' lists from before favourites: services/settings.ts). What isn't a
     * provider's model at all is left out. The caller's transaction makes it happen once.
     */
    async adopt(repos: Repos, workspace: Workspace, refs: readonly unknown[]): Promise<string[]> {
        const place: Place = { kind: "workspace", workspace };
        const stored = await this.stored(repos, place);
        const favourites = [...stored.favourites];
        const ids: string[] = [];
        for (const raw of refs) {
            const ref = (raw && typeof raw === "object" ? raw : {}) as { provider?: unknown; model?: unknown };
            if (typeof ref.provider !== "string" || typeof ref.model !== "string") continue;
            const provider = ref.provider;
            const model = ref.model.trim();
            if (!providerById(provider) || !MODEL_NAME.test(model)) continue;
            let f = favourites.find((x) => same(x, provider, model));
            if (!f) {
                f = { id: newId(), provider, model };
                favourites.push(f);
            }
            if (!ids.includes(f.id)) ids.push(f.id);
        }
        if (favourites.length > stored.favourites.length) await this.save(repos, place, withDefault({ ...stored, favourites }));
        return ids;
    }

    /**
     * What a favourite would run with now, or what it still needs; null if there's no such favourite.
     * Reveals secrets: never return it as is.
     */
    async resolveFavourite(repos: Repos, workspace: Workspace, id: string): Promise<(Resolution & { favourite: Favourite }) | null> {
        const place: Place = { kind: "workspace", workspace };
        const favourite = (await this.stored(repos, place)).favourites.find((f) => f.id === id);
        if (!favourite) return null;
        return { ...(await this.resolve(repos, place, favourite.provider, false, favourite.model)), favourite };
    }

    /**
     * What the chosen provider (or `provider`, with `model` rather than the one chosen for it) would run
     * with now, or what it still needs (for `listing` its models, everything but a model). Reveals
     * secrets: never return it as is.
     */
    async resolve(repos: Repos, place: Place, provider?: string, listing = false, modelName?: string): Promise<Resolution> {
        const stored = await this.stored(repos, place);
        const spec = providerById(provider ?? stored.provider) as ProviderSpec;
        const opts = stored.options?.[spec.id] ?? {};
        const scope = this.scope(place);
        const model = modelName ?? stored.models[spec.id] ?? defaultModel(spec);
        const apiKey = await this.core.secrets.reveal(repos, scope, modelKeyName(spec.id));
        const accessKeyId = spec.fields.includes("accessKeyId")
            ? await this.core.secrets.reveal(repos, scope, accessKeyIdName(spec.id))
            : null;
        // Listing a provider's models doesn't need one chosen yet.
        const missing = missingOf(spec, opts, model || (listing ? "-" : ""), Boolean(apiKey), Boolean(accessKeyId));
        if (missing || !apiKey) return { ready: false, missing: missing ?? "", spec };
        const protocol = protocolOf(spec, opts);
        const url = spec.id === "azure" ? azureBaseUrl(opts.url as string) : (spec.url ?? opts.url ?? "");
        return {
            ready: true,
            spec,
            model: {
                provider: spec.id,
                protocol,
                url: protocol === "anthropic-bedrock" ? "" : url,
                model,
                apiKey,
                ...(accessKeyId ? { aws: { region: opts.region as string, accessKeyId } } : {}),
                userUrl: spec.url === null && spec.fields.includes("url"),
            },
        };
    }

    /**
     * Choose the provider and model reviews use by default, and that provider's settings. The default
     * favourite becomes that model (see `chooseDefault`); the other favourites stay as they are.
     */
    choose(actor: Actor, place: Place, input: ModelChoice): Promise<StoredModel> {
        return this.apply(actor, place, input, true);
    }

    /** Change one provider's settings (protocol, endpoint URL, AWS region), whichever model is the default. */
    configure(actor: Actor, place: Place, provider: string, input: ProviderSettings): Promise<StoredModel> {
        return this.apply(actor, place, { ...input, provider }, false);
    }

    private async apply(actor: Actor, place: Place, input: ModelChoice, choosing: boolean): Promise<StoredModel> {
        if (input.provider !== undefined && !providerById(input.provider))
            throw badRequest(`Unknown provider "${input.provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
        if (input.model !== undefined && !MODEL_NAME.test(input.model.trim())) throw badRequest("That isn't a valid model name.");
        const current = await this.stored(this.core.store, place);
        const spec = providerById(input.provider ?? current.provider) as ProviderSpec;
        const opts: ProviderOptions = {};
        if (input.protocol !== undefined) {
            if (!MODEL_PROTOCOLS.includes(input.protocol as ModelProtocol) || !spec.protocols.includes(input.protocol as ModelProtocol))
                throw badRequest(`${spec.name} can be used with: ${spec.protocols.join(", ")}.`);
            opts.protocol = input.protocol as ModelProtocol;
        }
        if (input.url !== undefined && input.url !== null && input.url.trim() !== "") {
            if (!spec.fields.includes("url")) throw badRequest(`${spec.name}'s address is fixed; it takes no URL.`);
            if (input.url.length > 500) throw badRequest("That URL is too long.");
            opts.url = await this.checkUrl(input.url, spec.id === "azure" ? "The Azure OpenAI endpoint" : "Your server's URL");
        }
        if (input.region !== undefined && input.region !== null && input.region.trim() !== "") {
            if (!spec.fields.includes("region")) throw badRequest(`${spec.name} takes no region.`);
            const region = input.region.trim();
            if (!AWS_REGION.test(region)) throw badRequest("Give an AWS region name, like eu-west-2 or us-east-1.");
            opts.region = region;
        }
        const clearing = (["url", "region"] as const).filter((f) => input[f] === null || input[f]?.trim() === "");
        return this.core.write(actor, async (w) => {
            const stored = await this.stored(w.tx, place);
            const provider = spec.id;
            const before = stored.options?.[provider] ?? {};
            const after: ProviderOptions = { ...before, ...opts };
            for (const f of clearing) delete after[f];
            const model = choosing ? input.model?.trim() : undefined;
            const models = { ...stored.models, ...(model ? { [provider]: model } : {}) };
            // Settings alone (no provider or model named) leave the default as it is.
            const moved = choosing && (input.provider !== undefined || Boolean(model));
            const next = withDefault({
                ...stored,
                provider: choosing ? provider : stored.provider,
                models,
                options: { ...stored.options, [provider]: after },
                ...(moved ? chooseDefault(stored, provider, models[provider] ?? defaultModel(spec), place.kind === "instance") : {}),
            });
            await this.save(w.tx, place, next);
            const changed = (["protocol", "url", "region"] as const).filter((f) => before[f] !== after[f]);
            await w.audit({
                ...this.audit(place, WORKSPACE_KEY),
                kind: "settings",
                changes: {
                    provider,
                    ...(model ? { model } : {}),
                    ...Object.fromEntries(changed.map((f) => [f, { from: before[f] ?? null, to: after[f] ?? null }])),
                },
            });
            return next;
        });
    }

    // ---- favourites (a workspace's) -----------------------------------------------------------

    /** Read the workspace's settings, change its favourites, and save them with what changed in the audit log. */
    private async change(
        actor: Actor,
        workspace: Workspace,
        change: (s: StoredModel) => { next: Pick<StoredModel, "favourites" | "defaultId">; changes: Record<string, unknown> },
    ): Promise<FavouritesView> {
        const place: Place = { kind: "workspace", workspace };
        await this.core.write(actor, async (w) => {
            const stored = await this.stored(w.tx, place);
            const { next, changes } = change(stored);
            await this.save(w.tx, place, withDefault({ ...stored, ...next }));
            await w.audit({ ...this.audit(place, WORKSPACE_KEY), kind: "settings", changes });
        });
        return this.favourites(this.core.store, place);
    }

    private found(s: StoredModel, id: string): Favourite {
        const f = s.favourites.find((x) => x.id === id);
        if (!f) throw notFound("No such favourite model.");
        return f;
    }

    /** Add a model to the favourites. The first one is the default; later ones only if asked. */
    async addFavourite(actor: Actor, workspace: Workspace, input: NewFavourite): Promise<FavouritesView> {
        const spec = providerById(input.provider);
        if (!spec) throw badRequest(`Unknown provider "${input.provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
        const model = modelNameOf(input.model);
        const name = nameOf(input.name);
        return this.change(actor, workspace, (s) => {
            if (s.favourites.length >= MAX_FAVOURITES)
                throw badRequest(`A workspace can have up to ${MAX_FAVOURITES} favourite models. Remove one first.`);
            if (s.favourites.some((f) => same(f, spec.id, model))) throw badRequest(`${model} from ${spec.name} is a favourite already.`);
            const added: Favourite = { id: newId(), provider: spec.id, model, ...(name ? { name } : {}) };
            const isDefault = Boolean(input.makeDefault) || s.defaultId === null;
            return {
                next: { favourites: [...s.favourites, added], defaultId: isDefault ? added.id : s.defaultId },
                changes: {
                    favourite: "added",
                    provider: spec.id,
                    model,
                    ...(name ? { name } : {}),
                    ...(isDefault ? { default: true } : {}),
                },
            };
        });
    }

    /** Rename a favourite, or change which of its provider's models it is. Its id stays. */
    async updateFavourite(
        actor: Actor,
        workspace: Workspace,
        id: string,
        input: { name?: string | null; model?: string },
    ): Promise<FavouritesView> {
        const model = input.model === undefined ? undefined : modelNameOf(input.model);
        const name = input.name === undefined ? undefined : (nameOf(input.name) ?? null);
        return this.change(actor, workspace, (s) => {
            const f = this.found(s, id);
            if (model !== undefined && s.favourites.some((x) => x.id !== id && same(x, f.provider, model)))
                throw badRequest(`${model} from ${(providerById(f.provider) as ProviderSpec).name} is a favourite already.`);
            const nextName = name === undefined ? f.name : (name ?? undefined);
            const after: Favourite = { id, provider: f.provider, model: model ?? f.model, ...(nextName ? { name: nextName } : {}) };
            return {
                next: { favourites: s.favourites.map((x) => (x.id === id ? after : x)), defaultId: s.defaultId },
                changes: {
                    favourite: "changed",
                    provider: f.provider,
                    ...(after.model !== f.model ? { model: { from: f.model, to: after.model } } : { model: f.model }),
                    ...(after.name !== f.name ? { name: { from: f.name ?? null, to: after.name ?? null } } : {}),
                },
            };
        });
    }

    /**
     * Remove a favourite. Never the last one, and the default only when `defaultId` names the favourite
     * that takes over, so reviews are never left without a default.
     */
    removeFavourite(actor: Actor, workspace: Workspace, id: string, defaultId?: string): Promise<FavouritesView> {
        return this.change(actor, workspace, (s) => {
            const f = this.found(s, id);
            if (s.favourites.length === 1)
                throw badRequest("A workspace keeps at least one favourite model. Add another before removing this one.");
            let nextDefault = s.defaultId;
            if (s.defaultId === id) {
                if (!defaultId || defaultId === id || !s.favourites.some((x) => x.id === defaultId))
                    throw badRequest("This is the default model. Choose another favourite as the default to remove it.");
                nextDefault = defaultId;
            }
            const replacement = nextDefault !== s.defaultId ? s.favourites.find((x) => x.id === nextDefault) : undefined;
            return {
                next: { favourites: s.favourites.filter((x) => x.id !== id), defaultId: nextDefault },
                changes: {
                    favourite: "removed",
                    provider: f.provider,
                    model: f.model,
                    ...(replacement ? { default: `${replacement.provider}/${replacement.model}` } : {}),
                },
            };
        });
    }

    /** Put the favourites in the order of `ids`, which must name each of them once. */
    reorderFavourites(actor: Actor, workspace: Workspace, ids: string[]): Promise<FavouritesView> {
        return this.change(actor, workspace, (s) => {
            const byId = new Map(s.favourites.map((f) => [f.id, f]));
            if (ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id)))
                throw badRequest("Give every favourite's id once, in the new order.");
            return {
                next: { favourites: ids.map((id) => byId.get(id) as Favourite), defaultId: s.defaultId },
                changes: { favourites: "reordered" },
            };
        });
    }

    setDefaultFavourite(actor: Actor, workspace: Workspace, id: string): Promise<FavouritesView> {
        return this.change(actor, workspace, (s) => {
            const f = this.found(s, id);
            const before = s.favourites.find((x) => x.id === s.defaultId);
            return {
                next: { favourites: s.favourites, defaultId: id },
                changes: {
                    default: { from: before ? `${before.provider}/${before.model}` : null, to: `${f.provider}/${f.model}` },
                },
            };
        });
    }

    async setSecret(actor: Actor, place: Place, provider: string, kind: SecretKind, secret: string | null): Promise<SecretView> {
        const spec = providerById(provider);
        if (!spec) throw badRequest(`Unknown provider "${provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
        if (kind === "accessKeyId" && !spec.fields.includes("accessKeyId")) throw badRequest(`${spec.name} takes no access key ID.`);
        const value = secret?.trim() ?? null;
        if (value !== null) {
            if (kind === "accessKeyId" && !AWS_ACCESS_KEY_ID.test(value))
                throw badRequest("That doesn't look like an AWS access key ID (they start AKIA).");
            if (kind === "key" && (value.length < 8 || value.length > 500 || /\s/.test(value)))
                throw badRequest(
                    spec.id === "custom"
                        ? "That doesn't look like an API key. If your server checks none, enter any 8 or more characters."
                        : "That doesn't look like an API key.",
                );
        }
        const scope = this.scope(place);
        const name = kind === "key" ? modelKeyName(spec.id) : accessKeyIdName(spec.id);
        return this.core.write(actor, async (w) => {
            if (value === null) await this.core.secrets.clear(w.tx, scope, name);
            else await this.core.secrets.set(w.tx, scope, name, value, actor.name);
            await w.audit({ ...this.audit(place, name), kind: "secret", changes: { [name]: value === null ? "cleared" : "set" } });
            return this.core.secrets.view(w.tx, scope, name);
        });
    }
}
