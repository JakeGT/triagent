// Configuration, kept apart from day-to-day work: a project's GitHub connection, webhook and automation,
// and a workspace's review model and keys (services/model-setup.ts). Secrets go through services/secrets.ts
// and are never returned.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { MAX_MODELS } from "../domain/merge.ts";
import { badRequest } from "../errors.ts";
import type { Project, Repos, Workspace } from "../store/types.ts";
import type { Actor, Core } from "./core.ts";
import { MODEL_NAME, type ModelChoice, ModelSetup, type SecretKind } from "./model-setup.ts";
import { PROVIDER_IDS, providerById } from "./providers.ts";
import type { SecretScope } from "./secrets.ts";

/** The smallest token budget a review can run with. */
export const MIN_TOKENS_BUDGET = 10_000;

export const AutomationSchema = z.object({
    /** Review new pull requests (and new pushes to them) automatically. */
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
    reviewTimeoutMinutes: z.number().int().min(5).max(720),
    fullScanTimeoutMinutes: z.number().int().min(5).max(720),
    /**
     * Whose pull requests are reviewed automatically: "collaborators" (from a branch of the repository,
     * or by its owners, organisation members and collaborators), or "everyone" (forks by anyone too,
     * spending the workspace's model budget). Others wait until someone who can start reviews does.
     */
    reviewPullRequestsFrom: z.enum(["collaborators", "everyone"]),
    /**
     * The models reviews run with, in order: each reviews the change, and their findings are merged into
     * one list (domain/merge.ts), the first model's wording leading. Each uses the workspace's key for its
     * provider. Empty: the workspace's own model (or the instance's, with an allowance).
     */
    models: z
        .array(z.object({ provider: z.string().max(40), model: z.string().trim().regex(MODEL_NAME, "isn't a valid model name") }).strict())
        .max(MAX_MODELS),
});
export type Automation = z.infer<typeof AutomationSchema>;

export const AUTOMATION_DEFAULTS: Automation = {
    enabled: false,
    pollMinutes: 2,
    nightlyHourUtc: null,
    failOnCritical: true,
    maxTokensBudget: null,
    archiveDeletedBranches: false,
    reviewTimeoutMinutes: 45,
    fullScanTimeoutMinutes: 120,
    reviewPullRequestsFrom: "collaborators",
    models: [],
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
        return { ...AUTOMATION_DEFAULTS, ...(stored?.value as Partial<Automation> | undefined) };
    }

    async setAutomation(actor: Actor, project: Project, patch: Partial<Automation>) {
        const parsed = AutomationSchema.partial().strict().safeParse(patch);
        if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
        const models = parsed.data.models ?? [];
        const unknown = models.find((m) => !providerById(m.provider));
        if (unknown) throw badRequest(`Unknown provider "${unknown.provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
        if (new Set(models.map((m) => `${m.provider}\0${m.model}`)).size < models.length)
            throw badRequest("Each model can only be listed once.");
        return this.core.write(actor, async (w) => {
            const before = await this.automation(w.tx, project);
            const next = { ...before, ...parsed.data };
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

    setModelKey(actor: Actor, workspace: Workspace, provider: string, key: string | null, kind: SecretKind = "key") {
        return this.setup.setSecret(actor, { kind: "workspace", workspace }, provider, kind, key);
    }
}
