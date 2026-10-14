// Model prices (US$ per million tokens, for input, output and cache reads), which turn the tokens reviews
// used into costs, past reviews included. Instance admins set prices for the whole instance; a workspace
// can override them. Models with neither use OpenRouter's listed price, if it lists them (under the same
// name, or the name OpenRouter gives a provider's own model id: services/providers.ts); anything else
// has no price, and its tokens are left out of costs.

import type { PricedModel } from "../domain/analytics.ts";
import { badRequest, notFound } from "../errors.ts";
import { now } from "../security.ts";
import type { Repos, Workspace } from "../store/types.ts";
import type { Catalogue } from "./catalogue.ts";
import type { Actor, Core } from "./core.ts";
import { catalogueCandidates } from "./providers.ts";

const KEY = "model-prices";
const PRICE_MAX = 10_000;
const MAX_PRICES = 500;
const MODEL_NAME = /^[\w.:/@+-]{1,150}$/;
// Names that mean something on every JavaScript object: never keys in a price list.
const RESERVED = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"]);

export interface PriceEntry {
    input: number;
    output: number;
    cacheRead: number | null;
    setBy: string;
    setAt: string;
}

export interface PriceInput {
    model: unknown;
    input: unknown;
    output: unknown;
    cacheRead?: unknown;
}

type PriceList = Record<string, PriceEntry>;

/** Only well-formed entries with ordinary names, as a fresh object, whatever was stored. */
function clean(value: unknown): PriceList {
    const out: PriceList = Object.create(null);
    if (!value || typeof value !== "object") return out;
    for (const [model, p] of Object.entries(value as Record<string, unknown>)) {
        if (!MODEL_NAME.test(model) || RESERVED.has(model) || !p || typeof p !== "object") continue;
        const e = p as PriceEntry;
        if (typeof e.input === "number" && typeof e.output === "number") out[model] = e;
    }
    return out;
}

function checkModel(value: unknown): string {
    const model = String(value ?? "").trim();
    if (!MODEL_NAME.test(model) || RESERVED.has(model))
        throw badRequest("Give the model's name as reviews use it, e.g. anthropic/claude-sonnet-4.5.");
    return model;
}

function checkPrice(value: unknown, what: string, optional: boolean): number | null {
    if (optional && (value === null || value === undefined || value === "")) return null;
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (!Number.isFinite(n) || n < 0 || n > PRICE_MAX)
        throw badRequest(
            `The ${what} price must be a number of US dollars per million tokens, from 0 to ${PRICE_MAX.toLocaleString("en-GB")}.`,
        );
    return n;
}

const list = (prices: PriceList) =>
    Object.entries(prices)
        .map(([model, p]) => ({ model, ...p }))
        .sort((a, b) => a.model.localeCompare(b.model));

export class Prices {
    private readonly core: Core;
    private readonly catalogue: Catalogue;

    constructor(core: Core, catalogue: Catalogue) {
        this.core = core;
        this.catalogue = catalogue;
    }

    private async instancePrices(repos: Repos): Promise<PriceList> {
        return clean(await repos.instanceSettings.get(KEY));
    }

    private async workspacePrices(repos: Repos, workspaceId: string): Promise<PriceList> {
        return clean((await repos.settings.get(workspaceId, null, KEY))?.value);
    }

    /**
     * What a model costs in this workspace, and where that price comes from. Reviews record the provider's
     * own model id and the provider apart (muse-spark-1.3 from meta), so a price set as "meta/muse-spark-1.3"
     * applies to it too, as does one set under the bare id; a price for another provider's model of that
     * name doesn't.
     */
    async resolver(workspaceId: string): Promise<(model: string, provider?: string | null) => PricedModel | null> {
        const repos = this.core.store;
        const [own, instance, listed] = await Promise.all([
            this.workspacePrices(repos, workspaceId),
            this.instancePrices(repos),
            this.catalogue.prices(),
        ]);
        const find = (prices: PriceList, names: string[]) =>
            names.map((n) => (Object.hasOwn(prices, n) ? prices[n] : undefined)).find(Boolean);
        return (model, provider) => {
            const names = provider && !model.startsWith(`${provider}/`) ? [model, `${provider}/${model}`] : [model];
            const w = find(own, names);
            if (w) return { input: w.input, output: w.output, cacheRead: w.cacheRead, source: "workspace" };
            const i = find(instance, names);
            if (i) return { input: i.input, output: i.output, cacheRead: i.cacheRead, source: "instance" };
            // A provider's own name for a model OpenRouter lists under another (claude-sonnet-4-5 is
            // anthropic/claude-sonnet-4.5), when OpenRouter lists exactly that name.
            const c = [...names, ...catalogueCandidates(model)].map((id) => listed.get(id)).find(Boolean);
            return c ? { ...c.price, source: "openrouter" } : null;
        };
    }

    async instanceView() {
        return { prices: list(await this.instancePrices(this.core.store)) };
    }

    async workspaceView(workspace: Workspace) {
        const repos = this.core.store;
        return {
            prices: list(await this.workspacePrices(repos, workspace.id)),
            instance: list(await this.instancePrices(repos)),
        };
    }

    private entry(actor: Actor, input: PriceInput): [string, PriceEntry] {
        const model = checkModel(input.model);
        return [
            model,
            {
                input: checkPrice(input.input, "input", false) as number,
                output: checkPrice(input.output, "output", false) as number,
                cacheRead: checkPrice(input.cacheRead, "cache read", true),
                setBy: actor.name,
                setAt: now(),
            },
        ];
    }

    private changed(before: PriceList, model: string, after: PriceEntry | null) {
        const was = Object.hasOwn(before, model) ? before[model] : undefined;
        const brief = (p: PriceEntry | undefined) => (p ? { input: p.input, output: p.output, cacheRead: p.cacheRead } : null);
        return { [model]: { from: brief(was), to: brief(after ?? undefined) } };
    }

    async setInstance(actor: Actor, input: PriceInput) {
        const [model, entry] = this.entry(actor, input);
        return this.core.write(actor, async (w) => {
            const prices = await this.instancePrices(w.tx);
            if (!Object.hasOwn(prices, model) && Object.keys(prices).length >= MAX_PRICES)
                throw badRequest(`There can be at most ${MAX_PRICES} prices. Remove some first.`);
            await w.tx.instanceSettings.put(KEY, { ...prices, [model]: entry });
            await w.audit({
                workspaceId: null,
                kind: "settings",
                target: "instance:model-prices",
                changes: this.changed(prices, model, entry),
            });
            return { model, ...entry };
        });
    }

    async removeInstance(actor: Actor, modelInput: unknown) {
        const model = checkModel(modelInput);
        return this.core.write(actor, async (w) => {
            const prices = await this.instancePrices(w.tx);
            if (!Object.hasOwn(prices, model)) throw notFound(`No instance price is set for "${model}".`);
            const { [model]: _gone, ...rest } = prices;
            await w.tx.instanceSettings.put(KEY, rest);
            await w.audit({
                workspaceId: null,
                kind: "settings",
                target: "instance:model-prices",
                changes: this.changed(prices, model, null),
            });
            return { removed: model };
        });
    }

    async setWorkspace(actor: Actor, workspace: Workspace, input: PriceInput) {
        const [model, entry] = this.entry(actor, input);
        return this.core.write(actor, async (w) => {
            const prices = await this.workspacePrices(w.tx, workspace.id);
            if (!Object.hasOwn(prices, model) && Object.keys(prices).length >= MAX_PRICES)
                throw badRequest(`There can be at most ${MAX_PRICES} prices. Remove some first.`);
            await w.tx.settings.put({ workspaceId: workspace.id, projectId: null, key: KEY, value: { ...prices, [model]: entry } });
            await w.audit({ workspaceId: workspace.id, kind: "settings", target: KEY, changes: this.changed(prices, model, entry) });
            return { model, ...entry };
        });
    }

    async removeWorkspace(actor: Actor, workspace: Workspace, modelInput: unknown) {
        const model = checkModel(modelInput);
        return this.core.write(actor, async (w) => {
            const prices = await this.workspacePrices(w.tx, workspace.id);
            if (!Object.hasOwn(prices, model)) throw notFound(`This workspace has no price of its own for "${model}".`);
            const { [model]: _gone, ...rest } = prices;
            await w.tx.settings.put({ workspaceId: workspace.id, projectId: null, key: KEY, value: rest });
            await w.audit({ workspaceId: workspace.id, kind: "settings", target: KEY, changes: this.changed(prices, model, null) });
            return { removed: model };
        });
    }
}
