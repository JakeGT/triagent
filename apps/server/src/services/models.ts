// Which model a workspace's reviews run with, and whose key pays for it.
//
// Today that's the workspace's own provider, model and key (Settings → Review model & keys). The instance
// key — one the instance admin lends to chosen workspaces with a monthly token allowance — is resolved
// here too once it exists, so the review scheduler only ever asks `forRun`.

import type { Repos, ReviewRecord, Workspace } from "../store/types.ts";
import type { Core } from "./core.ts";
import { LLM_PROVIDERS, modelKeyName, type ProviderId, type ReviewModel } from "./settings.ts";

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
}

export interface NotReady {
    ready: false;
    /** Why reviews must wait, for people: e.g. "Add an OpenRouter API key in Settings → Review model & keys." */
    reason: string;
}

export class Models {
    private readonly core: Core;

    constructor(core: Core) {
        this.core = core;
    }

    /** What a review in `workspace` would run with now, or why it can't run yet. */
    async forRun(workspace: Workspace, repos: Repos = this.core.store): Promise<RunModel | NotReady> {
        const stored = (await repos.settings.get(workspace.id, null, "review-model"))?.value as ReviewModel | undefined;
        const provider = LLM_PROVIDERS[stored?.provider ?? "openrouter"];
        const model = stored?.models[provider.id] ?? provider.defaultModel;
        const apiKey = await this.core.secrets.reveal(repos, { workspaceId: workspace.id, projectId: null }, modelKeyName(provider.id));
        if (!apiKey) return { ready: false, reason: `Add a ${provider.name} API key in Settings → Review model & keys.` };
        return { ready: true, provider: provider.id, url: provider.url, protocol: "openai", model, apiKey, keySource: "workspace" };
    }
}
