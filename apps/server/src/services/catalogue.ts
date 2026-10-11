// OpenRouter's public model catalogue: model ids and their prices, for the model picker and as default
// prices. Fetched by the server (pages never call OpenRouter), kept for an hour, and given up on quickly:
// a slow or failed fetch never breaks a page, it just means no catalogue for a while. OPENROUTER_CATALOGUE=false
// turns it off.

import { log } from "@triagent/shared/log";
import type { Price } from "../domain/analytics.ts";

export const CATALOGUE_URL = "https://openrouter.ai/api/v1/models";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 3000;
const MODEL_ID = /^[\w.:/@+-]{1,150}$/;

export interface CatalogueModel {
    id: string;
    name: string;
    /** US$ per million tokens. */
    price: Price;
    contextLength: number | null;
}

export interface CatalogueView {
    enabled: boolean;
    /** When the list was fetched; null if it never has been. */
    fetchedAt: string | null;
    /** Why the last fetch failed, for people (the list may still be an older copy). */
    error: string | null;
    models: CatalogueModel[];
}

export interface CatalogueOptions {
    enabled: boolean;
    fetch?: typeof fetch;
    now?: () => number;
    ttlMs?: number;
    /** After a failure, wait this long before trying again. */
    retryMs?: number;
    timeoutMs?: number;
    url?: string;
}

/** OpenRouter's prices are US$ per token, as strings; negative means "varies" (routers). */
function perMillion(v: unknown): number | null {
    // An empty string is a missing price, not a free one (Number("") is 0).
    const n = (typeof v === "string" && v.trim()) || typeof v === "number" ? Number(v) : Number.NaN;
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
}

export function parseCatalogue(body: unknown): CatalogueModel[] {
    const data = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
    if (!Array.isArray(data)) throw new Error("OpenRouter's answer had no list of models.");
    const out: CatalogueModel[] = [];
    for (const m of data.slice(0, MAX_MODELS)) {
        if (!m || typeof m !== "object") continue;
        const { id, name, pricing, context_length } = m as Record<string, unknown>;
        if (typeof id !== "string" || !MODEL_ID.test(id)) continue;
        const p = (pricing && typeof pricing === "object" ? pricing : {}) as Record<string, unknown>;
        const input = perMillion(p.prompt);
        const output = perMillion(p.completion);
        if (input === null || output === null) continue;
        out.push({
            id,
            name: typeof name === "string" && name.trim() ? name.trim().slice(0, 150) : id,
            price: { input, output, cacheRead: perMillion(p.input_cache_read) },
            contextLength: typeof context_length === "number" && Number.isFinite(context_length) ? context_length : null,
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

export class Catalogue {
    private readonly options: Required<CatalogueOptions>;
    private models: CatalogueModel[] = [];
    private byId = new Map<string, CatalogueModel>();
    private fetchedAt: number | null = null;
    private failedAt: number | null = null;
    private error: string | null = null;
    private pending: Promise<void> | null = null;

    constructor(options: CatalogueOptions) {
        this.options = {
            fetch: globalThis.fetch,
            now: Date.now,
            ttlMs: 60 * 60_000,
            retryMs: 5 * 60_000,
            timeoutMs: 8000,
            url: CATALOGUE_URL,
            ...options,
        };
    }

    private fresh(): boolean {
        const now = this.options.now();
        if (this.fetchedAt !== null && now - this.fetchedAt < this.options.ttlMs) return true;
        return this.failedAt !== null && now - this.failedAt < this.options.retryMs;
    }

    private async load(): Promise<void> {
        try {
            const res = await this.options.fetch(this.options.url, {
                headers: { accept: "application/json" },
                signal: AbortSignal.timeout(this.options.timeoutMs),
            });
            if (!res.ok) throw new Error(`OpenRouter answered ${res.status}.`);
            if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES)
                throw new Error("OpenRouter's model list is unexpectedly large.");
            const text = await readCapped(res, MAX_BYTES);
            if (text === null) throw new Error("OpenRouter's model list is unexpectedly large.");
            const models = parseCatalogue(JSON.parse(text));
            this.models = models;
            this.byId = new Map(models.map((m) => [m.id, m]));
            this.fetchedAt = this.options.now();
            this.failedAt = null;
            this.error = null;
        } catch (err) {
            // Keep any older copy; just say it couldn't be refreshed.
            log.warn("Couldn't fetch OpenRouter's model catalogue: prices and model names may be out of date", { err });
            this.failedAt = this.options.now();
            const e = err instanceof Error ? err : new Error(String(err));
            this.error =
                e.name === "TimeoutError" || e.name === "AbortError"
                    ? "OpenRouter didn't answer in time."
                    : e instanceof SyntaxError
                      ? "OpenRouter's answer wasn't valid JSON."
                      : e.message.startsWith("OpenRouter")
                        ? e.message
                        : "Couldn't reach OpenRouter.";
        }
    }

    /** Fetch the list if it's missing or stale; concurrent callers share one fetch. Never throws. */
    private async refresh(): Promise<void> {
        if (!this.options.enabled || this.fresh()) return;
        this.pending ??= this.load().finally(() => {
            this.pending = null;
        });
        await this.pending;
    }

    async view(): Promise<CatalogueView> {
        await this.refresh();
        return {
            enabled: this.options.enabled,
            fetchedAt: this.fetchedAt === null ? null : new Date(this.fetchedAt).toISOString(),
            error: this.options.enabled ? this.error : null,
            models: this.models,
        };
    }

    /** Model id → price, as listed (empty when the catalogue is off or unavailable). */
    async prices(): Promise<ReadonlyMap<string, CatalogueModel>> {
        await this.refresh();
        return this.byId;
    }
}

/** A response's body as text, or null once it's more than `max` bytes (read no further than that, whatever its length header says). */
export async function readCapped(res: Response, max: number): Promise<string | null> {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
            await reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}
