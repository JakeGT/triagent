// Configuration, kept apart from day-to-day work: a project's GitHub connection, webhook and automation,
// and a workspace's review model and keys. Secrets go through services/secrets.ts and are never returned.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { badRequest } from "../errors.ts";
import type { Project, Repos, Workspace } from "../store/types.ts";
import type { Actor, Core } from "./core.ts";
import type { SecretScope } from "./secrets.ts";

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
    maxTokensBudget: z.number().int().min(10_000).nullable(),
    /** Archive a branch here when it's deleted on GitHub. */
    archiveDeletedBranches: z.boolean(),
    reviewTimeoutMinutes: z.number().int().min(5).max(720),
    fullScanTimeoutMinutes: z.number().int().min(5).max(720),
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
};

/** Model providers reviews can use; both speak the OpenAI-compatible protocol Open Code Review supports. */
export const LLM_PROVIDERS = {
    openrouter: {
        id: "openrouter",
        name: "OpenRouter",
        url: "https://openrouter.ai/api/v1",
        defaultModel: "anthropic/claude-sonnet-4.5",
        keysUrl: "https://openrouter.ai/settings/keys",
    },
    meta: { id: "meta", name: "Meta", url: "https://api.meta.ai/v1", defaultModel: "muse-spark-1.3-contributor", keysUrl: null },
} as const;
export type ProviderId = keyof typeof LLM_PROVIDERS;
export const PROVIDER_IDS = Object.keys(LLM_PROVIDERS) as ProviderId[];

export const ReviewModelSchema = z.object({
    provider: z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]]),
    /** The model chosen for each provider; switching provider keeps the other's choice. */
    models: z.record(z.string(), z.string().min(1).max(150)),
});
export type ReviewModel = z.infer<typeof ReviewModelSchema>;

const GITHUB_TOKEN = "github-token";
const WEBHOOK_SECRET = "webhook-secret";
export const modelKeyName = (provider: ProviderId) => `model-key:${provider}`;

/** Fine-grained (github_pat_), the gh?_ family and old 40-hex tokens. */
const GITHUB_TOKEN_FORMAT = /^(?:(?:github_pat_|gh[a-z]_)[A-Za-z0-9_]{20,255}|[0-9a-f]{40})$/;

export class Settings {
    private readonly core: Core;

    constructor(core: Core) {
        this.core = core;
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
        return this.core.write(actor, async (w) => {
            const before = await this.automation(w.tx, project);
            const next = { ...before, ...parsed.data };
            await w.tx.settings.put({ workspaceId: project.workspaceId, projectId: project.id, key: "automation", value: next });
            const changes = Object.fromEntries(
                Object.keys(parsed.data)
                    .filter((k) => before[k as keyof Automation] !== next[k as keyof Automation])
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
        const token = await this.core.secrets.view(repos, scope, GITHUB_TOKEN);
        const webhook = await this.core.secrets.view(repos, scope, WEBHOOK_SECRET);
        return {
            repoUrl: project.repoUrl,
            defaultBranch: project.defaultBranch,
            connection: { method: token.set ? "token" : "none", token },
            webhook: {
                secretSet: webhook.set,
                setBy: webhook.setBy,
                setAt: webhook.setAt,
                url: `${this.core.config.publicOrigin}/api/v1/github/webhook/${project.webhookId}`,
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
            return { webhookSecret: secret, url: `${this.core.config.publicOrigin}/api/v1/github/webhook/${project.webhookId}` };
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

    webhookSecret(project: Project): Promise<string | null> {
        return this.core.secrets.reveal(this.core.store, this.projectScope(project), WEBHOOK_SECRET);
    }

    // ---- review model and keys (per workspace) -------------------------------------------------

    async reviewModel(workspace: Workspace) {
        const repos = this.core.store;
        const stored = (await repos.settings.get(workspace.id, null, "review-model"))?.value as ReviewModel | undefined;
        const provider = stored?.provider ?? "openrouter";
        const scope: SecretScope = { workspaceId: workspace.id, projectId: null };
        const providers = [];
        for (const p of Object.values(LLM_PROVIDERS)) {
            providers.push({
                ...p,
                model: stored?.models[p.id] ?? p.defaultModel,
                key: await this.core.secrets.view(repos, scope, modelKeyName(p.id)),
            });
        }
        const chosen = providers.find((p) => p.id === provider);
        return { provider, model: chosen?.model ?? null, ready: Boolean(chosen?.key.set), providers };
    }

    async setReviewModel(actor: Actor, workspace: Workspace, input: { provider?: string; model?: string }) {
        if (input.provider !== undefined && !PROVIDER_IDS.includes(input.provider as ProviderId))
            throw badRequest(`Unknown provider "${input.provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
        if (input.model !== undefined && !/^[\w.:/@+-]{1,150}$/.test(input.model)) throw badRequest("That isn't a valid model name.");
        return this.core.write(actor, async (w) => {
            const stored = (await w.tx.settings.get(workspace.id, null, "review-model"))?.value as ReviewModel | undefined;
            const provider = (input.provider ?? stored?.provider ?? "openrouter") as ProviderId;
            const next: ReviewModel = { provider, models: { ...stored?.models, ...(input.model ? { [provider]: input.model } : {}) } };
            await w.tx.settings.put({ workspaceId: workspace.id, projectId: null, key: "review-model", value: next });
            await w.audit({
                workspaceId: workspace.id,
                kind: "settings",
                target: "review-model",
                changes: { provider, ...(input.model ? { model: input.model } : {}) },
            });
            return next;
        });
    }

    async setModelKey(actor: Actor, workspace: Workspace, provider: string, key: string | null) {
        if (!PROVIDER_IDS.includes(provider as ProviderId))
            throw badRequest(`Unknown provider "${provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
        const value = key?.trim() ?? null;
        if (value !== null && (value.length < 8 || value.length > 500 || /\s/.test(value)))
            throw badRequest("That doesn't look like an API key.");
        const scope: SecretScope = { workspaceId: workspace.id, projectId: null };
        const name = modelKeyName(provider as ProviderId);
        return this.core.write(actor, async (w) => {
            if (value === null) await this.core.secrets.clear(w.tx, scope, name);
            else await this.core.secrets.set(w.tx, scope, name, value, actor.name);
            await w.audit({
                workspaceId: workspace.id,
                kind: "secret",
                target: name,
                changes: { [name]: value === null ? "cleared" : "set" },
            });
            return this.core.secrets.view(w.tx, scope, name);
        });
    }
}
