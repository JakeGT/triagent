// Which model a workspace's reviews run with, and whose key pays for it, so the review scheduler only
// ever asks `forRun`:
//
// 1. The workspace's own settings and key for its chosen provider (Settings → Review model & keys).
// 2. Otherwise, if the instance admin granted the workspace a monthly allowance and this month's
//    instance-key tokens are under it: the instance's provider, model and key.
// 3. Otherwise, not ready, with the reason (no key, no instance key set up, or the allowance used up).
//
// What's left of an allowance is this month's allowance, less the tokens used, less the budgets of the
// workspace's instance-key reviews running now (each was given its budget out of the allowance, and
// may spend all of it). Less than the smallest budget a review can run with counts as used up.
//
// The result says which of OCR's protocols to use and carries everything OCR needs for it (services/
// model-setup.ts): a URL and key, or for Amazon Bedrock a region and an AWS access key.

import { modelLabels } from "../domain/merge.ts";
import type { Repos, ReviewRecord, Workspace } from "../store/types.ts";
import { type Allowances, nextMonthStart, resetDay } from "./allowances.ts";
import type { Core } from "./core.ts";
import type { History } from "./history.ts";
import { ModelSetup, type ResolvedModel } from "./model-setup.ts";
import { providerById } from "./providers.ts";
import { type Automation, MIN_TOKENS_BUDGET } from "./settings.ts";

export interface RunModel extends ResolvedModel {
    ready: true;
    /** How people know it in a review run with several models (domain/merge.ts). */
    label: string;
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
    private readonly setup: ModelSetup;

    constructor(
        core: Core,
        history: History | null = null,
        allowances: Allowances | null = null,
        setup: ModelSetup = new ModelSetup(core),
    ) {
        this.core = core;
        this.history = history;
        this.allowances = allowances;
        this.setup = setup;
    }

    /** What a review in `workspace` would run with now, or why it can't run yet. */
    async forRun(workspace: Workspace, repos: Repos = this.core.store): Promise<RunModel | NotReady> {
        const own = await this.setup.resolve(repos, { kind: "workspace", workspace });
        if (own.ready) return { ...own.model, ready: true, label: own.model.model, keySource: "workspace" };

        const addKey = `Add ${own.missing} in Settings → Review model & keys.`;
        if (!this.allowances || !this.history) return { ready: false, reason: addKey };
        const grant = await repos.modelGrants.get(workspace.id);
        if (!grant) return { ready: false, reason: addKey };

        const instance = await this.allowances.resolve(repos);
        if (!instance.ready)
            return {
                ready: false,
                reason: `${addKey} This workspace may use the instance's key, but the instance administrator hasn't set one up yet.`,
            };
        const now = this.allowances.now();
        const used = await this.history.tokensThisMonth(workspace.id, "instance", now);
        const ownKey = `To keep reviewing before then, add ${own.missing.replace(/^an? /, "your own ")} in Settings → Review model & keys.`;
        const exhausted = this.allowances.exhausted(grant.monthlyTokens, used, now);
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
            ...instance.model,
            ready: true,
            label: instance.model.model,
            keySource: "instance",
            allowance: { monthlyTokens: grant.monthlyTokens, used, reserved, remaining, resetsAt: nextMonthStart(now).toISOString() },
        };
    }

    /**
     * The models a project's reviews run with now, in order, or why they can't run yet. With none listed
     * in its settings, the workspace's model (`forRun`); otherwise each listed model, with the
     * workspace's key for its provider.
     */
    async forProject(
        workspace: Workspace,
        automation: Pick<Automation, "models">,
        repos: Repos = this.core.store,
    ): Promise<{ ready: true; models: RunModel[] } | NotReady> {
        if (!automation.models.length) {
            const one = await this.forRun(workspace, repos);
            return one.ready ? { ready: true, models: [one] } : one;
        }
        const labels = modelLabels(automation.models, (id) => providerById(id)?.name ?? id);
        const models: RunModel[] = [];
        for (const [i, m] of automation.models.entries()) {
            const r = await this.setup.resolve(repos, { kind: "workspace", workspace }, m.provider, false, m.model);
            if (!r.ready)
                return {
                    ready: false,
                    reason: `Add ${r.missing} in Settings → Review model & keys: this project's reviews use ${labels[i]}. Or take it out of the project's review settings.`,
                };
            models.push({ ...r.model, ready: true, label: labels[i] as string, keySource: "workspace" });
        }
        return { ready: true, models };
    }

    /** Why a model's person-given URL can't be used now (see services/model-urls.ts), or null. */
    recheck(model: RunModel): Promise<string | null> {
        return this.setup.recheck(model);
    }
}
