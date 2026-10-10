// What a runner is given to reach a review's model: the protocol Open Code Review speaks to it, where,
// and this job's credentials. Shared by the server (which builds it) and the runner (which hands it to
// OCR). Not exported from the package index: the web app never sees credentials.

/** OCR's protocols (its internal/llm/protocol.go). */
export const MODEL_PROTOCOLS = ["openai", "openai-responses", "anthropic", "anthropic-bedrock"] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];

/**
 * Whether a model speaking `protocol` can be asked a question of one's own (which findings are the same
 * problem): not on Amazon Bedrock, whose requests are signed with AWS credentials (apps/runner/src/judge.ts).
 */
export const canBeAsked = (protocol: ModelProtocol): boolean => protocol !== "anthropic-bedrock";

export interface RunnerModel {
    /** Triagent's provider id, for the log. */
    provider: string;
    protocol: ModelProtocol;
    /** The API's base URL. Empty for anthropic-bedrock, where the region decides the host. */
    url: string;
    model: string;
    /** The API key; for Amazon Bedrock, the AWS secret access key. Never log it. */
    apiKey: string;
    /** Amazon Bedrock only: where, and the access key ID that goes with the secret. */
    aws?: { region: string; accessKeyId: string };
}

/** Every credential in a model, for redaction. */
export function modelSecrets(model: Pick<RunnerModel, "apiKey" | "aws">): string[] {
    return [model.apiKey, model.aws?.accessKeyId ?? ""].filter(Boolean);
}
