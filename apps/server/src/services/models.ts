// Which models a review runs with, and whose key pays for each.
//
// Which models, by the first of these that says (`forProject`):
//
// 1. the run's own choice (Start a review, the API, the MCP `start_review` tool);
// 2. the project's set for this kind of review (pull request, branch changes, full scan);
// 3. the project's set for every review;
// 4. the workspace's default (`forRun`), one model.
//
// 1 to 3 are ids of the workspace's favourite models (services/model-setup.ts), each with the
// workspace's key for its provider, or INSTANCE_MODEL: the instance's model, paid from the workspace's
// monthly allowance. Automatic reviews have no choice of their own, so they start at 2.
//
// The workspace's default (`forRun`):
//
// 1. The workspace's own settings and key for its chosen provider (Settings → Models).
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

import { MAX_MODELS, modelLabels } from "../domain/merge.ts";
import type { Job, JobKind, Project, Repos, ReviewRecord, Workspace } from "../store/types.ts";
import { type Allowances, nextMonthStart, resetDay } from "./allowances.ts";
import type { Core } from "./core.ts";
import type { History } from "./history.ts";
import { type FavouriteView, ModelSetup, type Place, type ResolvedModel } from "./model-setup.ts";
import { type ProviderSpec, providerById } from "./providers.ts";
import { INSTANCE_MODEL, MIN_TOKENS_BUDGET, Settings } from "./settings.ts";

export interface RunModel extends ResolvedModel {
    ready: true;
    /** The favourite it is, or INSTANCE_MODEL; null for a workspace's model that isn't a favourite. */
    id: string | null;
    /** How people know it: its nickname or its name, with its provider when two in a review share that (domain/merge.ts). */
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
    /** Why reviews must wait, for people: e.g. "Add an OpenRouter API key in Settings → Models." */
    reason: string;
    /** Waiting won't help (a model the run asked for has been removed): the review fails, saying `reason`. */
    gone?: true;
}

/** Why the instance's model can't be used now. Without `granted`, the workspace has no allowance at all. */
interface NoInstance {
    ready: false;
    granted: boolean;
    reason: string;
    /** Having a key of its own would get the workspace going again. */
    ownKeyHelps?: boolean;
    /** The instance has no key yet. */
    unset?: boolean;
}

/** Which rule chose a review's models. */
export type ModelRule = "run" | "kind" | "project" | "default";

/** The instance's model, as one more model to choose (when the workspace has an allowance). */
export interface InstanceModelView {
    id: typeof INSTANCE_MODEL;
    provider: string;
    providerName: string;
    model: string | null;
    name: string;
    ready: boolean;
    /** Why it can't be used now. */
    reason: string | null;
}

export interface ModelsView {
    favourites: FavouriteView[];
    defaultId: string | null;
    instance: InstanceModelView | null;
    /** How many models one review can use. */
    max: number;
    /** With no choice made anywhere: the default favourite, or the instance's model when that is what reviews fall back on. */
    fallback: string[];
    /** For a project: what each kind of review uses when the run doesn't choose, and which rule says so. */
    rules?: Record<JobKind, { ids: string[]; from: Exclude<ModelRule, "run"> }>;
}

/** The budget a running review holds out of its workspace's allowance: its instance-key model's. */
export function reservedBudget(job: Pick<Job, "model">): number {
    const m = job.model;
    if (!m) return 0;
    if (m.models?.length) return m.models.reduce((n, x) => n + (x.keySource === "instance" ? (x.budget ?? 0) : 0), 0);
    return m.keySource === "instance" ? (m.budget ?? 0) : 0;
}

export class Models {
    private readonly core: Core;
    private readonly history: History | null;
    private readonly allowances: Allowances | null;
    private readonly setup: ModelSetup;
    private readonly settings: Settings;

    constructor(
        core: Core,
        history: History | null = null,
        allowances: Allowances | null = null,
        setup: ModelSetup = new ModelSetup(core),
        settings: Settings = new Settings(core, setup),
    ) {
        this.core = core;
        this.history = history;
        this.allowances = allowances;
        this.setup = setup;
        this.settings = settings;
    }

    /** What a review in `workspace` would run with when nothing else is chosen, or why it can't run yet. */
    async forRun(workspace: Workspace, repos: Repos = this.core.store): Promise<RunModel | NotReady> {
        const own = await this.setup.resolve(repos, { kind: "workspace", workspace });
        if (own.ready) {
            const favourite = await this.setup.defaultFavourite(repos, workspace);
            const is = favourite?.provider === own.model.provider && favourite.model === own.model.model ? favourite : null;
            return { ...own.model, ready: true, id: is?.id ?? null, label: is?.name ?? own.model.model, keySource: "workspace" };
        }

        const addKey = `Add ${own.missing} in Settings → Models.`;
        const instance = await this.instance(workspace, repos);
        if (instance.ready) return instance;
        if (!instance.granted) return { ready: false, reason: addKey };
        if (instance.unset) return { ready: false, reason: `${addKey} ${instance.reason}` };
        const ownKey = `To keep reviewing before then, add ${own.missing.replace(/^an? /, "your own ")} in Settings → Models.`;
        return { ready: false, reason: instance.ownKeyHelps ? `${instance.reason} ${ownKey}` : instance.reason };
    }

    /** The instance's model with what's left of the workspace's allowance, or why it can't pay for a review now. */
    private async instance(workspace: Workspace, repos: Repos): Promise<RunModel | NoInstance> {
        if (!this.allowances || !this.history) return { ready: false, granted: false, reason: "" };
        const grant = await repos.modelGrants.get(workspace.id);
        if (!grant) return { ready: false, granted: false, reason: "" };

        const instance = await this.allowances.resolve(repos);
        if (!instance.ready)
            return {
                ready: false,
                granted: true,
                unset: true,
                reason: "This workspace may use the instance's key, but the instance administrator hasn't set one up yet.",
            };
        const now = this.allowances.now();
        const used = await this.history.tokensThisMonth(workspace.id, "instance", now);
        const exhausted = this.allowances.exhausted(grant.monthlyTokens, used, now);
        if (exhausted) return { ready: false, granted: true, reason: exhausted, ownKeyHelps: true };
        const reserved = (await repos.jobs.active())
            .filter((j) => j.workspaceId === workspace.id && j.status === "running")
            .reduce((n, j) => n + reservedBudget(j), 0);
        const remaining = grant.monthlyTokens - used - reserved;
        if (remaining < MIN_TOKENS_BUDGET) {
            const left = Math.max(0, remaining).toLocaleString("en-GB");
            const least = MIN_TOKENS_BUDGET.toLocaleString("en-GB");
            return reserved
                ? {
                      ready: false,
                      granted: true,
                      reason: `Less than ${least} tokens of this month's allowance are left once the reviews running now are counted. The next review starts when one finishes and leaves enough; otherwise the allowance resets on ${resetDay(now)}.`,
                  }
                : {
                      ready: false,
                      granted: true,
                      ownKeyHelps: true,
                      reason: `Less than ${least} tokens of this month's allowance are left (${left}), the least a review can run with; it resets on ${resetDay(now)}.`,
                  };
        }
        return {
            ...instance.model,
            ready: true,
            id: INSTANCE_MODEL,
            label: instance.model.model,
            keySource: "instance",
            allowance: { monthlyTokens: grant.monthlyTokens, used, reserved, remaining, resetsAt: nextMonthStart(now).toISOString() },
        };
    }

    /**
     * The ids a review of this kind uses, and the rule that says so; null when no rule but the last does
     * (the workspace's default). `kind` null asks about the project's reviews in general.
     */
    private async chosen(
        repos: Repos,
        project: Project,
        kind: JobKind | null,
        requested: readonly string[] | null,
    ): Promise<{ ids: readonly string[]; from: Exclude<ModelRule, "default"> } | null> {
        if (requested?.length) return { ids: requested, from: "run" };
        const { models } = await this.settings.automation(repos, project);
        const own = kind ? models[kind] : undefined;
        if (own?.length) return { ids: own, from: "kind" };
        return models.all?.length ? { ids: models.all, from: "project" } : null;
    }

    /**
     * The models a review of `project` runs with now, in order, or why it can't run yet: those `requested`
     * for this run, else the project's for this `kind` of review, else the project's, else the workspace's
     * default (`forRun`).
     */
    async forProject(
        workspace: Workspace,
        project: Project,
        kind: JobKind | null,
        requested: readonly string[] | null = null,
        repos: Repos = this.core.store,
    ): Promise<{ ready: true; models: RunModel[] } | NotReady> {
        const chosen = await this.chosen(repos, project, kind, requested);
        if (!chosen) {
            const one = await this.forRun(workspace, repos);
            return one.ready ? { ready: true, models: [one] } : one;
        }
        const asked = chosen.from === "run";
        const place: Place = { kind: "workspace", workspace };
        const favourites = (await this.setup.stored(repos, place)).favourites;
        const models: RunModel[] = [];
        const named: { name: string | null; model: string; providerName: string }[] = [];
        for (const id of chosen.ids) {
            if (id === INSTANCE_MODEL) {
                const instance = await this.instance(workspace, repos);
                if (!instance.ready)
                    return {
                        ready: false,
                        reason: instance.granted
                            ? `${instance.reason} ${asked ? "This review was asked to use" : "This project's reviews use"} the instance's model.`
                            : `This workspace has no allowance on the instance's key now, and ${asked ? "this review was asked to use the instance's model. Cancel it and start it with another model" : "this project's reviews use the instance's model. Choose another in the project's review settings"}.`,
                    };
                models.push(instance);
                named.push({ name: null, model: instance.model, providerName: "the instance's key" });
                continue;
            }
            const f = favourites.find((x) => x.id === id);
            if (!f)
                return asked
                    ? {
                          ready: false,
                          gone: true,
                          reason: "This review was asked to use a favourite model that has since been removed. Start it again and choose its models.",
                      }
                    : {
                          ready: false,
                          reason: "This project's reviews use a favourite model that no longer exists. Choose its models again in the project's review settings.",
                      };
            const r = await this.setup.resolve(repos, place, f.provider, false, f.model);
            if (!r.ready)
                return {
                    ready: false,
                    reason: asked
                        ? `Add ${r.missing} in Settings → Models: this review was asked to use ${f.name ?? f.model}. Or cancel it and start it with another model.`
                        : `Add ${r.missing} in Settings → Models: this project's reviews use ${f.name ?? f.model}. Or take it out of the project's review settings.`,
                };
            models.push({ ...r.model, ready: true, id: f.id, label: f.model, keySource: "workspace" });
            named.push({ name: f.name ?? null, model: f.model, providerName: (providerById(f.provider) as ProviderSpec).name });
        }
        const labels = modelLabels(named);
        return { ready: true, models: models.map((m, i) => ({ ...m, label: labels[i] as string })) };
    }

    /**
     * For pickers and agents: the favourites (each ready or saying what it needs), the instance's model when
     * the workspace has an allowance, and, for a project, what each kind of review uses when a run doesn't choose.
     */
    async list(workspace: Workspace, project: Project | null = null, repos: Repos = this.core.store): Promise<ModelsView> {
        const { favourites, defaultId } = await this.setup.favourites(repos, { kind: "workspace", workspace });
        let instance: InstanceModelView | null = null;
        const usage = this.allowances ? await this.allowances.usage(workspace, repos) : null;
        if (usage?.granted) {
            const now = await this.instance(workspace, repos);
            instance = {
                id: INSTANCE_MODEL,
                provider: usage.instance.provider,
                providerName: usage.instance.providerName,
                model: usage.instance.model,
                name: "Instance model",
                ready: now.ready,
                reason: now.ready ? null : now.reason,
            };
        }
        // As `forRun`: the default favourite when it's ready, otherwise the instance's model if there's an allowance.
        const ownReady = favourites.some((f) => f.isDefault && f.ready);
        const fallback = !ownReady && instance ? [INSTANCE_MODEL] : defaultId ? [defaultId] : [];
        const view: ModelsView = { favourites, defaultId, instance, max: MAX_MODELS, fallback };
        if (!project) return view;
        const rule = async (kind: JobKind) => {
            const chosen = await this.chosen(repos, project, kind, null);
            return chosen ? { ids: [...chosen.ids], from: chosen.from as "kind" | "project" } : { ids: fallback, from: "default" as const };
        };
        return { ...view, rules: { pr: await rule("pr"), changes: await rule("changes"), full: await rule("full") } };
    }

    /** Why a model's person-given URL can't be used now (see services/model-urls.ts), or null. */
    recheck(model: RunModel): Promise<string | null> {
        return this.setup.recheck(model);
    }
}
