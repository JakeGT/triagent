// A review model's configuration, the same for a workspace (Settings → Review model & keys) and for the
// instance (the instance model key): which provider, the model chosen for each, each provider's settings
// (protocol, endpoint URL, AWS region) and its secrets (the key; for Bedrock also the access key ID).
// Settings live in the settings tables; secrets are encrypted (services/secrets.ts) and never returned.

import { MODEL_PROTOCOLS, type ModelProtocol, type RunnerModel } from "@triagent/shared/model";
import { badRequest } from "../errors.ts";
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

export interface StoredModel {
    provider: string;
    /** The model chosen for each provider; switching provider keeps the others' choices. */
    models: Record<string, string>;
    options?: Record<string, ProviderOptions>;
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

export type SecretKind = "key" | "accessKeyId";

export const MODEL_NAME = /^[\w.:/@+-]{1,150}$/;
const FALLBACK = "openrouter";
const INSTANCE: SecretScope = { workspaceId: null, projectId: null };
const INSTANCE_KEY = "instance-model";
const WORKSPACE_KEY = "review-model";

export const modelKeyName = (provider: string) => `model-key:${provider}`;
export const accessKeyIdName = (provider: string) => `model-key:${provider}:access-key-id`;

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

function clean(value: unknown): StoredModel {
    const v = (value && typeof value === "object" ? value : {}) as Partial<StoredModel>;
    const provider = typeof v.provider === "string" && providerById(v.provider) ? v.provider : FALLBACK;
    return { provider, models: { ...v.models }, options: { ...v.options } };
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
        return clean(
            place.kind === "instance"
                ? await repos.instanceSettings.get(INSTANCE_KEY)
                : (await repos.settings.get(place.workspace.id, null, WORKSPACE_KEY))?.value,
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
        const providers = [];
        for (const spec of PROVIDER_IDS.map((id) => providerById(id) as ProviderSpec)) {
            const opts = stored.options?.[spec.id] ?? {};
            const key: SecretView = await this.core.secrets.view(repos, scope, modelKeyName(spec.id));
            const accessKeyId = spec.fields.includes("accessKeyId")
                ? await this.core.secrets.view(repos, scope, accessKeyIdName(spec.id))
                : null;
            const model = stored.models[spec.id] ?? defaultModel(spec);
            const missing = missingOf(spec, opts, model, key.set, Boolean(accessKeyId?.set));
            providers.push({
                id: spec.id,
                name: spec.name,
                group: spec.group,
                protocols: spec.protocols,
                protocol: opts.protocol && spec.protocols.includes(opts.protocol) ? opts.protocol : (spec.protocols[0] as ModelProtocol),
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
            });
        }
        const chosen = providers.find((p) => p.id === stored.provider);
        return {
            provider: stored.provider,
            model: chosen?.model || null,
            ready: Boolean(chosen?.ready),
            missing: chosen?.missing ?? null,
            providers,
        };
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
        const protocol = opts.protocol && spec.protocols.includes(opts.protocol) ? opts.protocol : (spec.protocols[0] as ModelProtocol);
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

    async choose(actor: Actor, place: Place, input: ModelChoice): Promise<StoredModel> {
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
            const model = input.model?.trim();
            const next: StoredModel = {
                provider,
                models: { ...stored.models, ...(model ? { [provider]: model } : {}) },
                options: { ...stored.options, [provider]: after },
            };
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
