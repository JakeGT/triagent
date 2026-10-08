// Which model a workspace's reviews run with, and whose key pays for it, so the review scheduler only
// ever asks `forRun`:
//
// 1. The workspace's own key for its chosen provider (Settings → Review model & keys): its provider and model.
// 2. Otherwise, if the instance admin granted the workspace a monthly allowance and this month's
//    instance-key tokens are under it: the instance's key, provider and model.
// 3. Otherwise, not ready, with the reason (no key, no instance key set up, or the allowance used up).
//
// What's left of an allowance is this month's allowance, less the tokens used, less the budgets of the
// workspace's instance-key reviews running now (each was given its budget out of the allowance, and
// may spend all of it). Less than the smallest budget a review can run with counts as used up.

import type { Repos, ReviewRecord, Workspace } from "../store/types.ts";
import { type Allowances, nextMonthStart, resetDay } from "./allowances.ts";
import type { Core } from "./core.ts";
import type { History } from "./history.ts";
import { LLM_PROVIDERS, MIN_TOKENS_BUDGET, modelKeyName, type ProviderId, type ReviewModel } from "./settings.ts";

export interface RunModel {
    ready: true;
    provider: ProviderId;
    /** The provider's OpenAI-compatible base URL. */
    url: string;
    protocol: "openai";
    model: string;
    /** The key itself: give it only to the run that uses it, and never log it. */
    apiKey: string;
    keySource: NonNullable<ReviewRecord["keySource"]>;
    /**
     * With the instance key: the month's allowance, the tokens used, the budgets of its reviews running
     * now, and what's left (at least MIN_TOKENS_BUDGET), so a run can stop before overspending.
     */
    allowance?: { monthlyTokens: number; used: number; reserved: number; remaining: number; resetsAt: string };
}

export interface NotReady {
    ready: false;
    /** Why reviews must wait, for people: e.g. "Add an OpenRouter API key in Settings → Review model & keys." */
    reason: string;
}

export class Models {
    private readonly core: Core;
    private readonly history: History | null;
    private readonly allowances: Allowances | null;

    constructor(core: Core, history: History | null = null, allowances: Allowances | null = null) {
        this.core = core;
        this.history = history;
        this.allowances = allowances;
    }

    /** What a review in `workspace` would run with now, or why it can't run yet. */
    async forRun(workspace: Workspace, repos: Repos = this.core.store): Promise<RunModel | NotReady> {
        const stored = (await repos.settings.get(workspace.id, null, "review-model"))?.value as ReviewModel | undefined;
        const provider = LLM_PROVIDERS[stored?.provider ?? "openrouter"];
        const model = stored?.models[provider.id] ?? provider.defaultModel;
        const apiKey = await this.core.secrets.reveal(repos, { workspaceId: workspace.id, projectId: null }, modelKeyName(provider.id));
        if (apiKey)
            return { ready: true, provider: provider.id, url: provider.url, protocol: "openai", model, apiKey, keySource: "workspace" };

        const addKey = `Add ${/^[aeiou]/i.test(provider.name) ? "an" : "a"} ${provider.name} API key in Settings → Review model & keys.`;
        if (!this.allowances || !this.history) return { ready: false, reason: addKey };
        const grant = await repos.modelGrants.get(workspace.id);
        if (!grant) return { ready: false, reason: addKey };

        const instance = await this.allowances.model(repos);
        const instanceProvider = LLM_PROVIDERS[instance.provider];
        const instanceKey = await this.allowances.key(repos, instance.provider);
        if (!instanceKey)
            return {
                ready: false,
                reason: `${addKey} This workspace may use the instance's key, but the instance administrator hasn't set one up yet.`,
            };
        const now = this.allowances.now();
        const used = await this.history.tokensThisMonth(workspace.id, "instance", now);
        const ownKey = `To keep reviewing before then, add your own ${provider.name} API key in Settings → Review model & keys.`;
        const exhausted = this.allowances.exhausted(grant.monthlyTokens, used);
        if (exhausted) return { ready: false, reason: `${exhausted} ${ownKey}` };
        const reserved = (await repos.jobs.active())
            .filter((j) => j.workspaceId === workspace.id && j.status === "running" && j.model?.keySource === "instance")
            .reduce((n, j) => n + (j.model?.budget ?? 0), 0);
        const remaining = grant.monthlyTokens - used - reserved;
        if (remaining < MIN_TOKENS_BUDGET) {
            const left = Math.max(0, remaining).toLocaleString("en-GB");
            const least = MIN_TOKENS_BUDGET.toLocaleString("en-GB");
            return {
                ready: false,
                reason: reserved
                    ? `Less than ${least} tokens of this month's allowance are left once the reviews running now are counted. The next review starts when one finishes and leaves enough; otherwise the allowance resets on ${resetDay(now)}.`
                    : `Less than ${least} tokens of this month's allowance are left (${left}), the least a review can run with; it resets on ${resetDay(now)}. ${ownKey}`,
            };
        }
        return {
            ready: true,
            provider: instanceProvider.id,
            url: instanceProvider.url,
            protocol: "openai",
            model: instance.model,
            apiKey: instanceKey,
            keySource: "instance",
            allowance: { monthlyTokens: grant.monthlyTokens, used, reserved, remaining, resetsAt: nextMonthStart(now).toISOString() },
        };
    }
}
