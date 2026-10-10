// Configuration, kept apart from day-to-day work: a project's GitHub connection, webhook and automation,
// and a workspace's review model and keys (services/model-setup.ts). Secrets go through services/secrets.ts
// and are never returned.

import { randomBytes } from "node:crypto";
import { MAX_SKIP_PATH_LENGTH, MAX_SKIP_PATHS, NO_OPTIONS, type RunOptions } from "@triagent/shared";
import { z } from "zod";
import { MAX_MODELS } from "../domain/merge.ts";
import { badRequest, conflict } from "../errors.ts";
import type { JobKind, Project, Repos, Workspace } from "../store/types.ts";
import type { Actor, Core } from "./core.ts";
import { type ModelChoice, ModelSetup, type NewFavourite, type ProviderSettings, type SecretKind } from "./model-setup.ts";
import type { SecretScope } from "./secrets.ts";

/** The smallest token budget a review can run with. */
export const MIN_TOKENS_BUDGET = 10_000;

/** The longest time limit a review can be given: a week. */
const MAX_TIMEOUT_MINUTES = 10_080;

/** The instance's model, paid from the workspace's allowance, where a favourite's id goes. */
export const INSTANCE_MODEL = "instance";

/** One to MAX_MODELS favourite models' ids (or INSTANCE_MODEL), in order: the first one's wording leads. */
export const ModelIds = z.array(z.string().min(1).max(64)).max(MAX_MODELS);

/**
 * A review's options for several models, as they're asked for (packages/shared/src/run-options.ts):
 * anything left out is off.
 */
export const RunOptionsInput = z.object({}).strict();
export type RunOptionsInput = z.infer<typeof RunOptionsInput>;

/** A project's own, for reviews that don't say. */
export const ProjectOptionsInput = RunOptionsInput;

/** The options asked for, in full: what wasn't said is off. */
export function runOptions(_input: RunOptionsInput | null | undefined): RunOptions {
    return structuredClone(NO_OPTIONS);
}

/** A project's sets of models: for every review (`all`), or for one kind of review. */
export const MODEL_SETS = ["all", "pr", "changes", "full"] as const satisfies readonly ("all" | JobKind)[];
export type ModelSet = (typeof MODEL_SETS)[number];

export const AutomationSchema = z.object({
    /** Review pull requests automatically: each once, when `firstReview` says; later pushes when someone asks. */
    enabled: z.boolean(),
    /** How often to ask GitHub about pull requests when there's no webhook. */
    pollMinutes: z.number().int().min(1).max(60),
    /** Hour (UTC) of a nightly full scan of the default branch, or null for none. */
    nightlyHourUtc: z.number().int().min(0).max(23).nullable(),
    /** Fail the pull request's check when a review finds anything critical. */
    failOnCritical: z.boolean(),
    /** Stop a review that would use more model tokens than this. */
    maxTokensBudget: z.number().int().min(MIN_TOKENS_BUDGET).nullable(),
    /** Archive a branch here when it's deleted on GitHub. */
    archiveDeletedBranches: z.boolean(),
    /** Stop a pull request or branch review that runs longer than this, or null for no limit. */
    reviewTimeoutMinutes: z.number().int().min(5).max(MAX_TIMEOUT_MINUTES).nullable(),
    /** The same, for a full scan. */
    fullScanTimeoutMinutes: z.number().int().min(5).max(MAX_TIMEOUT_MINUTES).nullable(),
    /**
     * Stop a model's review as stalled when Open Code Review has printed nothing for this long, or null to
     * never. Without a time limit it's what stops a hung model call holding a review's place for good.
     */
    stallMinutes: z.number().int().min(1).max(1440).nullable(),
    /**
     * Whose pull requests are reviewed automatically: "collaborators" (from a branch of the repository,
     * or by its owners, organisation members and collaborators), or "everyone" (forks by anyone too,
     * spending the workspace's model budget). Others wait until someone who can start reviews does.
     */
    reviewPullRequestsFrom: z.enum(["collaborators", "everyone"]),
    /**
     * When a pull request gets its first review by itself: once it's ready and the checks on its head
     * commit have passed ("checks"), as soon as it's ready ("ready"), or never ("manual": only when
     * someone asks). Later pushes are never reviewed until someone asks.
     */
    firstReview: z.enum(["checks", "ready", "manual"]),
    /**
     * Patterns for files that don't need a review (`docs/**`, `*.lock`, `*.md`): a pull request that
     * changes only such files isn't reviewed automatically. Matched by domain/review-triggers.ts.
     */
    skipPaths: z
        .array(
            z
                .string()
                .trim()
                .min(1)
                .max(MAX_SKIP_PATH_LENGTH)
                // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's refused
                .regex(/^[^\u0000-\u001f\u007f]+$/, "can't contain control characters"),
        )
        .max(MAX_SKIP_PATHS),
    /** Don't review pull requests opened by bots (Dependabot and the like) automatically. */
    skipBots: z.boolean(),
    /**
     * The models reviews run with, as ids of the workspace's favourite models (Settings → Models): `all` for
     * every review, and `pr`, `changes` and `full` for one kind of review, which wins. A set left out or
     * empty falls through: the kind's, then `all`, then the workspace's default model. With several, each
     * reviews the change and their findings are merged into one list (domain/merge.ts), the first model's
     * wording leading.
     */
    models: z
        .object({ all: ModelIds.optional(), pr: ModelIds.optional(), changes: ModelIds.optional(), full: ModelIds.optional() })
        .strict(),
    /**
     * Options for reviews run with several models, for those that don't choose their own (automatic
     * reviews, and reviews started without `options`). All off unless set; a review with one model has none.
     */
    options: ProjectOptionsInput,
});
export type Automation = z.infer<typeof AutomationSchema>;
export type ProjectModels = Automation["models"];

/** A project using a favourite model, and in which of its sets. */
export interface FavouriteUse {
    slug: string;
    name: string;
    sets: ModelSet[];
}

export const AUTOMATION_DEFAULTS: Automation = {
    enabled: false,
    pollMinutes: 2,
    nightlyHourUtc: null,
    failOnCritical: true,
    maxTokensBudget: null,
    archiveDeletedBranches: false,
    reviewTimeoutMinutes: null,
    fullScanTimeoutMinutes: null,
    stallMinutes: 30,
    reviewPullRequestsFrom: "collaborators",
    firstReview: "checks",
    skipPaths: [],
    skipBots: true,
    models: {},
    options: {},
};

const GITHUB_TOKEN = "github-token";
const WEBHOOK_SECRET = "webhook-secret";

/** Fine-grained (github_pat_), the gh?_ family and old 40-hex tokens. */
const GITHUB_TOKEN_FORMAT = /^(?:(?:github_pat_|gh[a-z]_)[A-Za-z0-9_]{20,255}|[0-9a-f]{40})$/;

export class Settings {
    private readonly core: Core;
    private readonly setup: ModelSetup;

    constructor(core: Core, setup: ModelSetup = new ModelSetup(core)) {
        this.core = core;
        this.setup = setup;
    }

    private projectScope(project: Project): SecretScope {
        return { workspaceId: project.workspaceId, projectId: project.id };
    }

    // ---- automation ------------------------------------------------------------------

    async automation(repos: Repos, project: Project): Promise<Automation> {
        const stored = await repos.settings.get(project.workspaceId, project.id, "automation");
        const value = stored?.value as (Partial<Omit<Automation, "models">> & { models?: unknown }) | undefined;
        if (Array.isArray(value?.models)) {
            // From before favourites: a list of providers' models. An empty one needs nothing but the new shape.
            if (value.models.length) return this.adoptModels(project);
            return { ...AUTOMATION_DEFAULTS, ...value, models: {} };
        }
        return { ...AUTOMATION_DEFAULTS, ...(value as Partial<Automation> | undefined) };
    }

    /**
     * Settings saved before favourites listed the project's models as providers' models. Each becomes the
     * favourite that is that model, added to the workspace's favourites if it isn't one yet, and the list
     * becomes the project's set for every review. Both are saved here, in one transaction (joining the
     * caller's, if it's in one), so it happens once and the ids never change afterwards; whoever reads the
     * settings at the same moment finds either the old list and does the same, or the new set.
     */
    private adoptModels(project: Project): Promise<Automation> {
        return this.core.store.transaction(async (tx) => {
            const stored = await tx.settings.get(project.workspaceId, project.id, "automation");
            const value = stored?.value as (Partial<Omit<Automation, "models">> & { models?: unknown }) | undefined;
            if (!Array.isArray(value?.models)) return { ...AUTOMATION_DEFAULTS, ...(value as Partial<Automation> | undefined) };
            const workspace = await tx.workspaces.get(project.workspaceId);
            const ids = workspace ? (await this.setup.adopt(tx, workspace, value.models)).slice(0, MAX_MODELS) : [];
            const next: Automation = { ...AUTOMATION_DEFAULTS, ...value, models: ids.length ? { all: ids } : {} };
            await tx.settings.put({ workspaceId: project.workspaceId, projectId: project.id, key: "automation", value: next });
            return next;
        });
    }

    /**
     * Ids chosen for a review, checked: each the workspace's favourite (or the instance's model, when the
     * workspace has an allowance), each once. Throws a 400 saying which isn't.
     */
    async checkModelIds(repos: Repos, workspace: Workspace, ids: readonly string[], what = "A review"): Promise<void> {
        if (ids.length > MAX_MODELS) throw badRequest(`${what} can use up to ${MAX_MODELS} models.`);
        if (new Set(ids).size < ids.length) throw badRequest("Each model can only be chosen once.");
        if (!ids.length) return;
        const known = new Set((await this.setup.stored(repos, { kind: "workspace", workspace })).favourites.map((f) => f.id));
        for (const id of ids) {
            if (id === INSTANCE_MODEL) {
                if (!(await repos.modelGrants.get(workspace.id)))
                    throw badRequest("This workspace has no allowance on the instance's key, so the instance's model can't be chosen.");
            } else if (!known.has(id))
                throw badRequest(`"${id.slice(0, 64)}" isn't one of this workspace's favourite models. Add it in Settings → Models first.`);
        }
    }

    async setAutomation(actor: Actor, project: Project, patch: Partial<Automation>) {
        const parsed = AutomationSchema.partial().strict().safeParse(patch);
        if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
        // A set left empty is the same as one left out.
        const models =
            parsed.data.models &&
            (Object.fromEntries(
                MODEL_SETS.flatMap((k) => (parsed.data.models?.[k]?.length ? [[k, parsed.data.models[k]]] : [])),
            ) as ProjectModels);
        return this.core.write(actor, async (w) => {
            const before = await this.automation(w.tx, project);
            if (models) {
                const workspace = await w.tx.workspaces.get(project.workspaceId);
                // A set that isn't changing isn't checked again: the allowance may have gone since it was saved.
                for (const k of MODEL_SETS)
                    if (workspace && models[k] && JSON.stringify(models[k]) !== JSON.stringify(before.models[k]))
                        await this.checkModelIds(w.tx, workspace, models[k], "A project's reviews");
            }
            const next = { ...before, ...parsed.data, ...(models ? { models } : {}) };
            await w.tx.settings.put({ workspaceId: project.workspaceId, projectId: project.id, key: "automation", value: next });
            const changes = Object.fromEntries(
                Object.keys(parsed.data)
                    .filter((k) => JSON.stringify(before[k as keyof Automation]) !== JSON.stringify(next[k as keyof Automation]))
                    .map((k) => [k, { from: before[k as keyof Automation], to: next[k as keyof Automation] }]),
            );
            if (Object.keys(changes).length)
                await w.audit({
                    workspaceId: project.workspaceId,
                    kind: "settings",
                    target: `project:${project.slug}:automation`,
                    changes,
                });
            return next;
        });
    }

    // ---- GitHub connection and webhook ----------------------------------------------------

    async github(project: Project) {
        const repos = this.core.store;
        const scope = this.projectScope(project);
        const secret = await this.core.secrets.views(repos, scope);
        const token = secret(GITHUB_TOKEN);
        const webhook = secret(WEBHOOK_SECRET);
        return {
            repoUrl: project.repoUrl,
            defaultBranch: project.defaultBranch,
            connection: { method: token.set ? "token" : "none", token },
            webhook: {
                secretSet: webhook.set,
                setBy: webhook.setBy,
                setAt: webhook.setAt,
                url: this.webhookUrl(project),
            },
        };
    }

    async setGithubToken(actor: Actor, project: Project, token: string | null) {
        const value = token === null ? null : token.trim();
        if (value !== null && !GITHUB_TOKEN_FORMAT.test(value))
            throw badRequest("That doesn't look like a GitHub token (fine-grained tokens start with github_pat_).");
        return this.core.write(actor, async (w) => {
            if (value === null) await this.core.secrets.clear(w.tx, this.projectScope(project), GITHUB_TOKEN);
            else await this.core.secrets.set(w.tx, this.projectScope(project), GITHUB_TOKEN, value, actor.name);
            await w.audit({
                workspaceId: project.workspaceId,
                kind: "secret",
                target: `project:${project.slug}:${GITHUB_TOKEN}`,
                changes: { [GITHUB_TOKEN]: value === null ? "cleared" : "set" },
            });
            return this.core.secrets.view(w.tx, this.projectScope(project), GITHUB_TOKEN);
        });
    }

    /** A new webhook secret, returned this once: paste it into GitHub's webhook settings. */
    async generateWebhookSecret(actor: Actor, project: Project) {
        const secret = randomBytes(24).toString("base64url");
        return this.core.write(actor, async (w) => {
            await this.core.secrets.set(w.tx, this.projectScope(project), WEBHOOK_SECRET, secret, actor.name);
            await w.audit({
                workspaceId: project.workspaceId,
                kind: "secret",
                target: `project:${project.slug}:${WEBHOOK_SECRET}`,
                changes: { [WEBHOOK_SECRET]: "generated" },
            });
            return { webhookSecret: secret, url: this.webhookUrl(project) };
        });
    }

    async clearWebhookSecret(actor: Actor, project: Project) {
        return this.core.write(actor, async (w) => {
            await this.core.secrets.clear(w.tx, this.projectScope(project), WEBHOOK_SECRET);
            await w.audit({
                workspaceId: project.workspaceId,
                kind: "secret",
                target: `project:${project.slug}:${WEBHOOK_SECRET}`,
                changes: { [WEBHOOK_SECRET]: "cleared" },
            });
            return { cleared: true };
        });
    }

    /** The project's GitHub token, for the code that uses it. Never put it in a response or a log. */
    githubToken(repos: Repos, project: Project): Promise<string | null> {
        return this.core.secrets.reveal(repos, this.projectScope(project), GITHUB_TOKEN);
    }

    /** Where GitHub sends this project's webhooks (PUBLIC_ORIGIN has no trailing slash: config.ts). */
    private webhookUrl(project: Project): string {
        return `${this.core.config.publicOrigin}/api/v1/github/webhook/${project.webhookId}`;
    }

    webhookSecret(project: Project): Promise<string | null> {
        return this.core.secrets.reveal(this.core.store, this.projectScope(project), WEBHOOK_SECRET);
    }

    // ---- review model and keys (per workspace; see services/model-setup.ts) ------------------------

    reviewModel(workspace: Workspace) {
        return this.setup.view(this.core.store, { kind: "workspace", workspace });
    }

    setReviewModel(actor: Actor, workspace: Workspace, input: ModelChoice) {
        return this.setup.choose(actor, { kind: "workspace", workspace }, input);
    }

    /** One provider's settings, whichever model is the default. */
    setProviderSettings(actor: Actor, workspace: Workspace, provider: string, input: ProviderSettings) {
        return this.setup.configure(actor, { kind: "workspace", workspace }, provider, input);
    }

    setModelKey(actor: Actor, workspace: Workspace, provider: string, key: string | null, kind: SecretKind = "key") {
        return this.setup.setSecret(actor, { kind: "workspace", workspace }, provider, kind, key);
    }

    // ---- favourite models (per workspace; see services/model-setup.ts) ----------------------------

    favourites(workspace: Workspace) {
        return this.setup.favourites(this.core.store, { kind: "workspace", workspace });
    }

    /** What a favourite would run with now, or what it needs; null for none such. Reveals secrets: never return it as is. */
    resolveFavourite(workspace: Workspace, id: string, repos: Repos = this.core.store) {
        return this.setup.resolveFavourite(repos, workspace, id);
    }

    addFavourite(actor: Actor, workspace: Workspace, input: NewFavourite) {
        return this.setup.addFavourite(actor, workspace, input);
    }

    updateFavourite(actor: Actor, workspace: Workspace, id: string, input: { name?: string | null; model?: string }) {
        return this.setup.updateFavourite(actor, workspace, id, input);
    }

    /** The projects whose reviews use a favourite, and in which of their sets. */
    async favouriteUses(repos: Repos, workspace: Workspace, id: string): Promise<FavouriteUse[]> {
        const uses: FavouriteUse[] = [];
        for (const p of await repos.projects.forWorkspace(workspace.id)) {
            const { models } = await this.automation(repos, p);
            const sets = MODEL_SETS.filter((k) => models[k]?.includes(id));
            if (sets.length) uses.push({ slug: p.slug, name: p.name, sets });
        }
        return uses;
    }

    /**
     * Remove a favourite. One that projects' reviews use is refused (409, naming the projects) unless
     * `force`, which takes it out of those projects' sets too: a set left empty falls through to the next
     * rule, as if it had never been chosen.
     */
    removeFavourite(actor: Actor, workspace: Workspace, id: string, defaultId?: string, force = false) {
        return this.core.write(actor, async (w) => {
            const uses = await this.favouriteUses(w.tx, workspace, id);
            if (uses.length && !force)
                throw conflict(
                    `${uses.length === 1 ? `${uses[0]?.name}'s reviews use` : `${uses.length} projects' reviews use`} this model. Remove it from them too with force=true, or change their review models first.`,
                    { code: "favourite_in_use", projects: uses },
                );
            for (const p of await w.tx.projects.forWorkspace(workspace.id)) {
                if (!uses.some((u) => u.slug === p.slug)) continue;
                const before = await this.automation(w.tx, p);
                const models = Object.fromEntries(
                    MODEL_SETS.flatMap((k) => {
                        const left = before.models[k]?.filter((x) => x !== id) ?? [];
                        return left.length ? [[k, left]] : [];
                    }),
                ) as ProjectModels;
                await w.tx.settings.put({ workspaceId: workspace.id, projectId: p.id, key: "automation", value: { ...before, models } });
                await w.audit({
                    workspaceId: workspace.id,
                    kind: "settings",
                    target: `project:${p.slug}:automation`,
                    changes: { models: { from: before.models, to: models } },
                });
            }
            return this.setup.removeFavourite(actor, workspace, id, defaultId);
        });
    }

    reorderFavourites(actor: Actor, workspace: Workspace, ids: string[]) {
        return this.setup.reorderFavourites(actor, workspace, ids);
    }

    setDefaultFavourite(actor: Actor, workspace: Workspace, id: string) {
        return this.setup.setDefaultFavourite(actor, workspace, id);
    }
}
