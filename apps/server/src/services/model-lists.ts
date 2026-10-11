// A provider's list of models, for the model picker: fetched by the server with the stored key (pages
// never see keys or call providers), kept briefly, and given up on quickly. Only model ids and names go
// back; never the key, nor anything else the provider said (an error body could quote the key).
// OpenRouter's comes from its catalogue (services/catalogue.ts), with prices.

import { createHash } from "node:crypto";
import { log } from "@triagent/shared/log";
import type { Repos } from "../store/types.ts";
import { type Catalogue, readCapped } from "./catalogue.ts";
import type { ModelSetup, Place } from "./model-setup.ts";
import { UnsafeUrl } from "./model-urls.ts";
import { type ProviderSpec, providerById } from "./providers.ts";

/** Cohere's compatibility API has no model list; its own API does, and takes the same key. */
export const COHERE_MODELS_URL = "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 2000;
const MODEL_ID = /^[\w.:/@+-]{1,150}$/;

export interface ListedModel {
    id: string;
    name: string | null;
}

export interface ModelListView {
    provider: string;
    /** Where the list came from: the provider, OpenRouter's catalogue, or nowhere (the provider has no list). */
    source: "provider" | "openrouter" | "none";
    models: ListedModel[];
    /** A few models to start from; any model id can be typed in. */
    suggested: readonly string[];
    fetchedAt: string | null;
    /** Why there's no list, for people. */
    error: string | null;
}

export interface ModelListOptions {
    fetch?: typeof fetch;
    now?: () => number;
    ttlMs?: number;
    /** A failed fetch is remembered this long, so a page reloading doesn't hammer the provider. */
    failedTtlMs?: number;
    timeoutMs?: number;
}

/** The model ids (and names) in a provider's answer: OpenAI's `{data: [{id}]}`, a bare array, Anthropic's or Cohere's. */
export function parseModelList(body: unknown): ListedModel[] {
    const b = body as Record<string, unknown> | unknown[] | null;
    const items = Array.isArray(b) ? b : Array.isArray(b?.data) ? b.data : Array.isArray(b?.models) ? b.models : null;
    if (!items) throw new SyntaxError("No list of models.");
    const out = new Map<string, ListedModel>();
    for (const m of items.slice(0, MAX_MODELS)) {
        if (!m || typeof m !== "object") continue;
        const r = m as Record<string, unknown>;
        const raw = typeof r.id === "string" ? r.id : typeof r.name === "string" && !("id" in r) ? r.name : null;
        // Gemini's compatible endpoint names models "models/gemini-…"; requests take them without the prefix.
        const id = raw?.replace(/^models\//, "");
        if (!id || !MODEL_ID.test(id)) continue;
        const label = typeof r.display_name === "string" ? r.display_name : typeof r.name === "string" && r.name !== raw ? r.name : null;
        out.set(id, { id, name: label?.trim().slice(0, 150) || null });
    }
    return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export class ModelLists {
    private readonly setup: ModelSetup;
    private readonly catalogue: Catalogue;
    private readonly options: Required<ModelListOptions>;
    private readonly cache = new Map<string, { at: number; ttl: number; view: ModelListView }>();
    private readonly pending = new Map<string, Promise<ModelListView>>();

    constructor(setup: ModelSetup, catalogue: Catalogue, options: ModelListOptions = {}) {
        this.setup = setup;
        this.catalogue = catalogue;
        this.options = {
            fetch: globalThis.fetch,
            now: Date.now,
            ttlMs: 10 * 60_000,
            failedTtlMs: 60_000,
            timeoutMs: 8000,
            ...options,
        };
    }

    async list(repos: Repos, place: Place, providerId: string): Promise<ModelListView | null> {
        const spec = providerById(providerId);
        if (!spec) return null;
        const base = { provider: spec.id, suggested: spec.suggested, fetchedAt: null };
        if (spec.models === "openrouter") {
            const c = await this.catalogue.view();
            return {
                ...base,
                source: "openrouter",
                models: c.models.map((m) => ({ id: m.id, name: m.name })),
                fetchedAt: c.fetchedAt,
                error: c.enabled ? c.error : "The OpenRouter catalogue is turned off on this server.",
            };
        }
        if (spec.models === null) return { ...base, source: "none", models: [], error: null };
        const resolved = await this.setup.resolve(repos, place, spec.id, true);
        if (!resolved.ready)
            return { ...base, source: "provider", models: [], error: `Add ${resolved.missing} to see ${spec.name}'s models.` };
        const { url, apiKey, protocol, userUrl } = resolved.model;
        const where = place.kind === "instance" ? "instance" : place.workspace.id;
        const cacheKey = [where, spec.id, protocol, url, createHash("sha256").update(apiKey).digest("hex")].join("|");
        const now = this.options.now();
        const hit = this.cache.get(cacheKey);
        if (hit && now - hit.at < hit.ttl) return hit.view;
        let job = this.pending.get(cacheKey);
        if (!job) {
            job = this.fetchList(spec, url, apiKey, protocol, userUrl).then((view) => {
                this.cache.delete(cacheKey);
                this.cache.set(cacheKey, { at: this.options.now(), ttl: view.error ? this.options.failedTtlMs : this.options.ttlMs, view });
                // Oldest first in a Map: keep it small.
                for (const k of this.cache.keys()) if (this.cache.size > 200) this.cache.delete(k);
                return view;
            });
            this.pending.set(cacheKey, job);
            void job.finally(() => this.pending.delete(cacheKey));
        }
        return job;
    }

    private async fetchList(spec: ProviderSpec, url: string, apiKey: string, protocol: string, userUrl: boolean): Promise<ModelListView> {
        const base = { provider: spec.id, source: "provider" as const, suggested: spec.suggested };
        try {
            // A person-given URL is checked again: what it resolves to may have changed since it was saved.
            if (userUrl) await this.setup.checkUrl(url, "The URL");
            const anthropic = protocol === "anthropic";
            const target = spec.models === "cohere" ? COHERE_MODELS_URL : anthropic ? `${url}/v1/models?limit=1000` : `${url}/models`;
            const res = await this.options.fetch(target, {
                headers: anthropic
                    ? { accept: "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
                    : { accept: "application/json", authorization: `Bearer ${apiKey}` },
                // A redirect could lead anywhere, the instance's own network included.
                redirect: "error",
                signal: AbortSignal.timeout(this.options.timeoutMs),
            });
            if (res.status === 401 || res.status === 403)
                throw new Error(`${spec.name} refused the key (${res.status}). Check it's right.`);
            if (!res.ok) throw new Error(`${spec.name} answered ${res.status} when asked for its models.`);
            if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES)
                throw new Error(`${spec.name}'s model list is unexpectedly large.`);
            const text = await readCapped(res, MAX_BYTES);
            if (text === null) throw new Error(`${spec.name}'s model list is unexpectedly large.`);
            const models = parseModelList(JSON.parse(text));
            return { ...base, models, fetchedAt: new Date(this.options.now()).toISOString(), error: null };
        } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            const error =
                e.name === "TimeoutError" || e.name === "AbortError"
                    ? `${spec.name} didn't answer in time.`
                    : e instanceof SyntaxError
                      ? `${spec.name}'s model list wasn't in a form Triagent understands.`
                      : e instanceof UnsafeUrl || (e as { status?: number }).status === 400 || e.message.startsWith(spec.name)
                        ? e.message
                        : `Couldn't reach ${spec.name}.`;
            // What the person is told, not the error itself: a provider's answer can quote the key it was sent.
            log.warn("Couldn't fetch a provider's model list", { provider: spec.name, reason: error });
            return { ...base, models: [], fetchedAt: null, error };
        }
    }
}
