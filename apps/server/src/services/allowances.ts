// The instance model key: a key the instance admin stores (per provider, encrypted, belonging to no
// workspace) and lends to chosen workspaces, each with a monthly token allowance. A workspace with its own
// key never uses it. Allowances run by calendar month in UTC; usage is the tokens of reviews paid with the
// instance key this month (see services/history.ts).

import { badRequest, notFound } from "../errors.ts";
import { now as nowIso } from "../security.ts";
import type { Repos, Workspace } from "../store/types.ts";
import type { Actor, Core } from "./core.ts";
import { monthStart } from "./history.ts";
import type { SecretScope } from "./secrets.ts";
import { LLM_PROVIDERS, modelKeyName, PROVIDER_IDS, type ProviderId } from "./settings.ts";

const MODEL_KEY = "instance-model";
const INSTANCE: SecretScope = { workspaceId: null, projectId: null };
const MAX_ALLOWANCE = 1e12;

export interface InstanceModel {
    provider: ProviderId;
    /** The model chosen for each provider. */
    models: Partial<Record<ProviderId, string>>;
}

/** The first moment of next month (UTC): when allowances start again. */
export function nextMonthStart(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** "1 November", or "1 January 2027" when the year changes. */
export function resetDay(now: Date): string {
    const next = nextMonthStart(now);
    return next.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        ...(next.getUTCFullYear() !== now.getUTCFullYear() ? { year: "numeric" } : {}),
        timeZone: "UTC",
    });
}

const tokens = (n: number) => n.toLocaleString("en-GB");

export class Allowances {
    private readonly core: Core;
    private readonly clock: () => Date;

    constructor(core: Core, clock: () => Date = () => new Date()) {
        this.core = core;
        this.clock = clock;
    }

    now(): Date {
        return this.clock();
    }

    async model(repos: Repos = this.core.store): Promise<{ provider: ProviderId; model: string }> {
        const stored = (await repos.instanceSettings.get(MODEL_KEY)) as InstanceModel | null;
        const provider = stored && PROVIDER_IDS.includes(stored.provider) ? stored.provider : "openrouter";
        return { provider, model: stored?.models?.[provider] ?? LLM_PROVIDERS[provider].defaultModel };
    }

    /** The instance key for the instance's chosen provider. Never put it in a response or a log. */
    async key(repos: Repos, provider: ProviderId): Promise<string | null> {
        return this.core.secrets.reveal(repos, INSTANCE, modelKeyName(provider));
    }

    /** For the instance page: provider, model and which providers have a key (never the keys). */
    async view() {
        const repos = this.core.store;
        const stored = (await repos.instanceSettings.get(MODEL_KEY)) as InstanceModel | null;
        const chosen = await this.model(repos);
        const providers = [];
        for (const p of Object.values(LLM_PROVIDERS))
            providers.push({
                ...p,
                model: stored?.models?.[p.id] ?? p.defaultModel,
                key: await this.core.secrets.view(repos, INSTANCE, modelKeyName(p.id)),
            });
        const active = providers.find((p) => p.id === chosen.provider);
        return { provider: chosen.provider, model: chosen.model, ready: Boolean(active?.key.set), providers };
    }

    async setModel(actor: Actor, input: { provider?: string; model?: string }) {
        if (input.provider !== undefined && !PROVIDER_IDS.includes(input.provider as ProviderId))
            throw badRequest(`Unknown provider "${input.provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
        if (input.model !== undefined && !/^[\w.:/@+-]{1,150}$/.test(input.model)) throw badRequest("That isn't a valid model name.");
        await this.core.write(actor, async (w) => {
            const stored = (await w.tx.instanceSettings.get(MODEL_KEY)) as InstanceModel | null;
            const provider = (input.provider ?? stored?.provider ?? "openrouter") as ProviderId;
            const next: InstanceModel = { provider, models: { ...stored?.models, ...(input.model ? { [provider]: input.model } : {}) } };
            await w.tx.instanceSettings.put(MODEL_KEY, next);
            await w.audit({
                workspaceId: null,
                kind: "settings",
                target: "instance:model",
                changes: { provider, ...(input.model ? { model: input.model } : {}) },
            });
        });
        return this.view();
    }

    async setKey(actor: Actor, provider: string, key: string | null) {
        if (!PROVIDER_IDS.includes(provider as ProviderId))
            throw badRequest(`Unknown provider "${provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
        const value = key?.trim() ?? null;
        if (value !== null && (value.length < 8 || value.length > 500 || /\s/.test(value)))
            throw badRequest("That doesn't look like an API key.");
        const name = modelKeyName(provider as ProviderId);
        return this.core.write(actor, async (w) => {
            if (value === null) await this.core.secrets.clear(w.tx, INSTANCE, name);
            else await this.core.secrets.set(w.tx, INSTANCE, name, value, actor.name);
            await w.audit({
                workspaceId: null,
                kind: "secret",
                target: `instance:${name}`,
                changes: { [name]: value === null ? "cleared" : "set" },
            });
            return this.core.secrets.view(w.tx, INSTANCE, name);
        });
    }

    // ---- grants -----------------------------------------------------------------------------

    /** A workspace's grant and this month's use of it. */
    async usage(workspace: Workspace, repos: Repos = this.core.store) {
        const now = this.clock();
        const grant = await repos.modelGrants.get(workspace.id);
        const used = await repos.reviewHistory.tokensSince(workspace.id, monthStart(now), "instance");
        const model = await this.model(repos);
        const keySet = (await repos.secrets.get(null, null, modelKeyName(model.provider))) !== null;
        return {
            granted: Boolean(grant),
            monthlyTokens: grant?.monthlyTokens ?? null,
            used,
            remaining: grant ? Math.max(0, grant.monthlyTokens - used) : null,
            resetsAt: nextMonthStart(now).toISOString(),
            grantedBy: grant?.grantedBy ?? null,
            grantedAt: grant?.grantedAt ?? null,
            instance: { provider: model.provider, providerName: LLM_PROVIDERS[model.provider].name, model: model.model, keySet },
        };
    }

    /** Why the instance key can't pay for a review now, or null if it can. */
    exhausted(monthlyTokens: number, used: number): string | null {
        if (used < monthlyTokens) return null;
        return `This month's allowance of ${tokens(monthlyTokens)} tokens is used up; it resets on ${resetDay(this.clock())}.`;
    }

    /** Every workspace, with its grant and this month's instance-key tokens, for the instance page. */
    async workspaces() {
        const repos = this.core.store;
        const now = this.clock();
        const [workspaces, grants, used] = [
            await repos.workspaces.list(),
            new Map((await repos.modelGrants.list()).map((g) => [g.workspaceId, g])),
            await repos.reviewHistory.tokensByWorkspace(monthStart(now), "instance"),
        ];
        return {
            resetsAt: nextMonthStart(now).toISOString(),
            items: workspaces
                .map((w) => {
                    const g = grants.get(w.id) ?? null;
                    const u = used[w.id] ?? 0;
                    return {
                        id: w.id,
                        slug: w.slug,
                        name: w.name,
                        kind: w.kind,
                        grant: g ? { monthlyTokens: g.monthlyTokens, grantedBy: g.grantedBy, grantedAt: g.grantedAt } : null,
                        used: u,
                        remaining: g ? Math.max(0, g.monthlyTokens - u) : null,
                    };
                })
                .sort((a, b) => Number(Boolean(b.grant)) - Number(Boolean(a.grant)) || a.name.localeCompare(b.name)),
        };
    }

    async setGrant(actor: Actor, workspaceId: string, monthlyTokens: unknown) {
        const n = typeof monthlyTokens === "number" ? monthlyTokens : Number.NaN;
        if (!Number.isInteger(n) || n < 1000 || n > MAX_ALLOWANCE)
            throw badRequest(`The monthly allowance must be a whole number of tokens, from 1,000 to ${tokens(MAX_ALLOWANCE)}.`);
        return this.core.write(actor, async (w) => {
            const workspace = await w.tx.workspaces.get(workspaceId);
            if (!workspace) throw notFound("No such workspace.");
            const before = await w.tx.modelGrants.get(workspaceId);
            await w.tx.modelGrants.put({ workspaceId, monthlyTokens: n, grantedBy: actor.name, grantedAt: before?.grantedAt ?? nowIso() });
            const changes = { monthlyTokens: { from: before?.monthlyTokens ?? null, to: n } };
            await w.audit({ workspaceId: null, kind: "settings", target: `workspace:${workspace.slug}:model-grant`, changes });
            await w.audit({ workspaceId, kind: "settings", target: "model-grant", changes });
            return { workspaceId, monthlyTokens: n };
        });
    }

    async removeGrant(actor: Actor, workspaceId: string) {
        return this.core.write(actor, async (w) => {
            const workspace = await w.tx.workspaces.get(workspaceId);
            const before = workspace ? await w.tx.modelGrants.get(workspaceId) : null;
            if (!workspace || !before) throw notFound("That workspace has no allowance.");
            await w.tx.modelGrants.delete(workspaceId);
            const changes = { monthlyTokens: { from: before.monthlyTokens, to: null } };
            await w.audit({ workspaceId: null, kind: "settings", target: `workspace:${workspace.slug}:model-grant`, changes });
            await w.audit({ workspaceId, kind: "settings", target: "model-grant", changes });
            return { removed: true };
        });
    }
}
