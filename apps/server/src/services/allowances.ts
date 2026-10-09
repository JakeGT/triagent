// The instance model key: a key the instance admin stores (per provider, encrypted, belonging to no
// workspace) and lends to chosen workspaces, each with a monthly token allowance. A workspace with its own
// key never uses it. Allowances run by calendar month in UTC; usage is the tokens of reviews paid with the
// instance key this month (see services/history.ts).

import { badRequest, notFound } from "../errors.ts";
import { now as nowIso } from "../security.ts";
import type { Repos, Workspace } from "../store/types.ts";
import type { Actor, Core } from "./core.ts";
import { monthStart } from "./history.ts";
import { type ModelChoice, ModelSetup, type Resolution, type SecretKind } from "./model-setup.ts";

const MAX_ALLOWANCE = 1e12;
const INSTANCE = { kind: "instance" } as const;

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
    private readonly setup: ModelSetup;

    constructor(core: Core, clock: () => Date = () => new Date(), setup: ModelSetup = new ModelSetup(core)) {
        this.core = core;
        this.clock = clock;
        this.setup = setup;
    }

    now(): Date {
        return this.clock();
    }

    /** What reviews paid with the instance key would run with, or what it still needs. Reveals the key. */
    resolve(repos: Repos = this.core.store): Promise<Resolution> {
        return this.setup.resolve(repos, INSTANCE);
    }

    /** For the instance page: provider, model and each provider's settings and secrets (never the secrets themselves). */
    view() {
        return this.setup.view(this.core.store, INSTANCE);
    }

    async setModel(actor: Actor, input: ModelChoice) {
        await this.setup.choose(actor, INSTANCE, input);
        return this.view();
    }

    setKey(actor: Actor, provider: string, key: string | null, kind: SecretKind = "key") {
        return this.setup.setSecret(actor, INSTANCE, provider, kind, key);
    }

    // ---- grants -----------------------------------------------------------------------------

    /** A workspace's grant and this month's use of it. */
    async usage(workspace: Workspace, repos: Repos = this.core.store) {
        const now = this.clock();
        const [grant, used, view] = await Promise.all([
            repos.modelGrants.get(workspace.id),
            repos.reviewHistory.tokensSince(workspace.id, monthStart(now), "instance"),
            this.setup.view(repos, INSTANCE),
        ]);
        const chosen = view.providers.find((p) => p.id === view.provider);
        return {
            granted: Boolean(grant),
            monthlyTokens: grant?.monthlyTokens ?? null,
            used,
            remaining: grant ? Math.max(0, grant.monthlyTokens - used) : null,
            resetsAt: nextMonthStart(now).toISOString(),
            grantedBy: grant?.grantedBy ?? null,
            grantedAt: grant?.grantedAt ?? null,
            instance: { provider: view.provider, providerName: chosen?.name ?? view.provider, model: view.model, keySet: view.ready },
        };
    }

    /** Why the instance key can't pay for a review now, or null if it can. */
    exhausted(monthlyTokens: number, used: number, now: Date = this.clock()): string | null {
        if (used < monthlyTokens) return null;
        return `This month's allowance of ${tokens(monthlyTokens)} tokens is used up; it resets on ${resetDay(now)}.`;
    }

    /** Every workspace, with its grant and this month's instance-key tokens, for the instance page. */
    async workspaces() {
        const repos = this.core.store;
        const now = this.clock();
        const [workspaces, grantList, used] = await Promise.all([
            repos.workspaces.list(),
            repos.modelGrants.list(),
            repos.reviewHistory.tokensByWorkspace(monthStart(now), "instance"),
        ]);
        const grants = new Map(grantList.map((g) => [g.workspaceId, g]));
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
            // The same allowance again changes nothing, and isn't recorded as a change.
            if (before?.monthlyTokens === n) return { workspaceId, monthlyTokens: n };
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
