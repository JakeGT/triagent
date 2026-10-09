// The model providers reviews can use, and how Open Code Review reaches each one. Base URLs come from each
// provider's own documentation (`docs`); docs/architecture.md has the table. The suggested models are only
// suggestions: any model id the provider accepts can be typed in.

import type { ModelProtocol } from "@triagent/shared/model";

export type ProviderGroup = "Model makers" | "Hosting and routing" | "Cloud platforms" | "Your own";

/** How a provider's model list is fetched, server-side, with the stored key. */
export type ModelListing = "openai" | "anthropic" | "openrouter" | "cohere" | null;

/** A setting beyond the key: an endpoint URL (Azure, custom), or an AWS region and access key ID (Bedrock). */
export type ProviderField = "url" | "region" | "accessKeyId";

export interface ProviderSpec {
    id: string;
    name: string;
    group: ProviderGroup;
    /** The protocols it can be used with; the first is the default. */
    protocols: readonly ModelProtocol[];
    /** Its API's base URL, or null when the person gives it (Azure, custom) or the region decides (Bedrock). */
    url: string | null;
    /** Where the base URL is documented. */
    docs: string;
    /** What its keys look like, for people. */
    keyFormat: string | null;
    /** Where to create a key. */
    keysUrl: string | null;
    models: ModelListing;
    /** A few current models, as suggestions. */
    suggested: readonly string[];
    fields: readonly ProviderField[];
    /** What the key is called. */
    keyLabel: string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
    {
        id: "anthropic",
        name: "Anthropic",
        group: "Model makers",
        protocols: ["anthropic"],
        url: "https://api.anthropic.com",
        docs: "https://platform.claude.com/docs/en/api/overview",
        keyFormat: "Starts with sk-ant-",
        keysUrl: "https://platform.claude.com/settings/keys",
        models: "anthropic",
        suggested: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "openai",
        name: "OpenAI",
        group: "Model makers",
        // Pro models, and tool calls with some newer ones, need the Responses API.
        protocols: ["openai", "openai-responses"],
        url: "https://api.openai.com/v1",
        docs: "https://developers.openai.com/api/reference/overview",
        keyFormat: null,
        keysUrl: "https://platform.openai.com/settings/organization/api-keys",
        models: "openai",
        suggested: ["gpt-6-astra", "gpt-5.5"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "gemini",
        name: "Google Gemini",
        group: "Model makers",
        protocols: ["openai"],
        url: "https://generativelanguage.googleapis.com/v1beta/openai",
        docs: "https://ai.google.dev/gemini-api/docs/openai",
        keyFormat: null,
        keysUrl: "https://aistudio.google.com/apikey",
        models: "openai",
        suggested: ["gemini-3.1-pro-preview", "gemini-3.8-flash"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "mistral",
        name: "Mistral",
        group: "Model makers",
        protocols: ["openai"],
        url: "https://api.mistral.ai/v1",
        docs: "https://docs.mistral.ai/api/",
        keyFormat: null,
        keysUrl: "https://console.mistral.ai/api-keys",
        models: "openai",
        suggested: ["mistral-medium-latest", "mistral-large-latest", "codestral-latest"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "xai",
        name: "xAI",
        group: "Model makers",
        protocols: ["openai"],
        url: "https://api.x.ai/v1",
        docs: "https://docs.x.ai/developers/quickstart",
        keyFormat: null,
        keysUrl: "https://console.x.ai/team/default/api-keys",
        models: "openai",
        suggested: ["grok-4.7", "grok-4.6"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "deepseek",
        name: "DeepSeek",
        group: "Model makers",
        protocols: ["openai"],
        url: "https://api.deepseek.com",
        docs: "https://api-docs.deepseek.com/",
        keyFormat: null,
        keysUrl: "https://platform.deepseek.com/api_keys",
        models: "openai",
        suggested: ["deepseek-v4-pro", "deepseek-flash"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "cohere",
        name: "Cohere",
        group: "Model makers",
        protocols: ["openai"],
        url: "https://api.cohere.ai/compatibility/v1",
        docs: "https://docs.cohere.com/docs/compatibility-api",
        keyFormat: null,
        keysUrl: "https://dashboard.cohere.com/api-keys",
        // The compatibility API has no model list; Cohere's own API does (https://docs.cohere.com/reference/list-models).
        models: "cohere",
        suggested: ["command-a-plus-05-2026", "command-a-reasoning-08-2025"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "moonshot",
        name: "Moonshot AI (Kimi)",
        group: "Model makers",
        protocols: ["openai"],
        url: "https://api.moonshot.ai/v1",
        docs: "https://platform.kimi.ai/docs/api/chat",
        keyFormat: "A key from platform.kimi.ai (keys from the China site don't work here)",
        keysUrl: "https://platform.kimi.ai/console/api-keys",
        models: "openai",
        suggested: ["kimi-k3", "kimi-k2.7-code"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "qwen",
        name: "Alibaba Cloud (Qwen)",
        group: "Model makers",
        protocols: ["openai"],
        // The international (Singapore) shared endpoint; its keys work only there.
        url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        docs: "https://www.alibabacloud.com/help/en/model-studio/base-url",
        keyFormat: "A Model Studio key for the Singapore region",
        keysUrl: "https://modelstudio.console.alibabacloud.com/model/settings/api-key",
        models: null,
        suggested: ["qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "meta",
        name: "Meta",
        group: "Model makers",
        protocols: ["openai"],
        url: "https://api.meta.ai/v1",
        docs: "https://dev.meta.ai/docs/protocols/chat-completions",
        keyFormat: "Starts with LLM|",
        keysUrl: null,
        models: "openai",
        suggested: ["muse-spark-1.3", "muse-spark-1.2"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "openrouter",
        name: "OpenRouter",
        group: "Hosting and routing",
        protocols: ["openai"],
        url: "https://openrouter.ai/api/v1",
        docs: "https://openrouter.ai/docs/quickstart",
        keyFormat: null,
        keysUrl: "https://openrouter.ai/keys",
        models: "openrouter",
        suggested: ["anthropic/claude-sonnet-4.5"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "groq",
        name: "Groq",
        group: "Hosting and routing",
        protocols: ["openai"],
        url: "https://api.groq.com/openai/v1",
        docs: "https://console.groq.com/docs/openai",
        keyFormat: null,
        keysUrl: "https://console.groq.com/keys",
        models: "openai",
        suggested: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "together",
        name: "Together AI",
        group: "Hosting and routing",
        protocols: ["openai"],
        url: "https://api.together.ai/v1",
        docs: "https://docs.together.ai/docs/openai-api-compatibility",
        keyFormat: null,
        keysUrl: "https://api.together.ai/settings/projects/~current/api-keys",
        models: "openai",
        suggested: ["deepseek-ai/DeepSeek-V4-Pro-0813", "Qwen/Qwen3.6-Plus"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "fireworks",
        name: "Fireworks AI",
        group: "Hosting and routing",
        protocols: ["openai"],
        url: "https://api.fireworks.ai/inference/v1",
        docs: "https://docs.fireworks.ai/tools-sdks/openai-compatibility",
        keyFormat: null,
        keysUrl: "https://app.fireworks.ai/settings/users/api-keys",
        // Its model list is on a separate, per-account API, not the inference one.
        models: null,
        suggested: ["accounts/fireworks/models/kimi-k3", "accounts/fireworks/models/glm-5p3"],
        fields: [],
        keyLabel: "API key",
    },
    {
        id: "bedrock",
        name: "Amazon Bedrock",
        group: "Cloud platforms",
        // OCR signs requests with SigV4; the region decides the bedrock-runtime host.
        protocols: ["anthropic-bedrock"],
        url: null,
        docs: "https://docs.aws.amazon.com/general/latest/gr/bedrock.html",
        keyFormat: "An IAM access key: an ID starting AKIA, and its secret",
        keysUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
        models: null,
        suggested: ["global.anthropic.claude-opus-4-6-v1", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"],
        fields: ["region", "accessKeyId"],
        keyLabel: "AWS secret access key",
    },
    {
        id: "azure",
        name: "Azure OpenAI",
        group: "Cloud platforms",
        // The v1 API takes the key as a bearer token and the deployment name as the model.
        protocols: ["openai-responses", "openai"],
        url: null,
        docs: "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle",
        keyFormat: "Key 1 or Key 2 from the resource's Keys and Endpoint page",
        keysUrl: "https://portal.azure.com/",
        // Its model list names models, not the deployments reviews need.
        models: null,
        suggested: [],
        fields: ["url"],
        keyLabel: "API key",
    },
    {
        id: "custom",
        name: "Custom (OpenAI-compatible)",
        group: "Your own",
        protocols: ["openai", "openai-responses", "anthropic"],
        url: null,
        docs: "https://developers.openai.com/api/reference/overview",
        keyFormat: "Whatever your server expects; if it checks none (Ollama), any 8 or more characters",
        keysUrl: null,
        models: "openai",
        suggested: [],
        fields: ["url"],
        keyLabel: "API key",
    },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function providerById(id: string): ProviderSpec | undefined {
    return BY_ID.get(id);
}

/** The model a provider starts with when none has been chosen. */
export const defaultModel = (p: ProviderSpec) => p.suggested[0] ?? "";

/** "an Anthropic", "a Mistral". */
export const aOrAn = (name: string) => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;

/** AWS region names, like eu-west-2 or us-gov-west-1. */
export const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
/** IAM access key IDs: long-term (AKIA) only, since temporary ones need a session token too. */
export const AWS_ACCESS_KEY_ID = /^AKIA[A-Z0-9]{12,124}$/;

/** Azure OpenAI's v1 API lives under /openai/v1 on the resource's endpoint; accept either. */
export function azureBaseUrl(endpoint: string): string {
    const u = endpoint.replace(/\/+$/, "");
    return /\/openai\/v1$/.test(u) ? u : `${u.replace(/\/openai$/, "")}/openai/v1`;
}

/** Map a provider's own model id to OpenRouter catalogue ids that could be the same model, best first. */
export function catalogueCandidates(model: string): string[] {
    let m = model.trim().replace(/^models\//, "");
    // Bedrock: inference profiles (us., eu., apac., global., and any added later) and versioned ids.
    const bedrock = /^(?:[a-z][a-z-]*\.)?anthropic\.(.+?)(?:-v\d+(?::\d+)?)?$/.exec(m);
    if (bedrock) m = bedrock[1] as string;
    if (m.includes("/")) return [];
    const maker = (
        [
            [/^claude-/, "anthropic"],
            [/^(?:gpt-|o[134](?:-|$)|codex-)/, "openai"],
            [/^gemini-/, "google"],
            [/^grok-/, "x-ai"],
            [/^deepseek-/, "deepseek"],
            [/^(?:mistral-|codestral-|devstral-|magistral-|ministral-|pixtral-)/, "mistralai"],
            [/^command-/, "cohere"],
            [/^kimi-/, "moonshotai"],
            [/^qwen/, "qwen"],
        ] as const
    ).find(([re]) => re.test(m))?.[1];
    if (!maker) return [];
    const undated = m.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
    // Anthropic writes versions with hyphens (claude-sonnet-4-5); OpenRouter with dots (claude-sonnet-4.5).
    const dotted = undated.replace(/-(\d)-(\d)(?=$|-)/, "-$1.$2");
    return [...new Set([m, undated, dotted].map((id) => `${maker}/${id}`))];
}
