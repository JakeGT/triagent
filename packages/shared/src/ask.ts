// One question to a model, in the three protocols Open Code Review speaks over HTTP: for the runner
// (which findings are the same problem, apps/runner/src/judge.ts) and the server (written analyses,
// apps/server/src/services/analyst.ts). OCR has no way to ask a model a question of one's own, so the
// request is made here. Amazon Bedrock isn't one of the protocols: its requests are signed with AWS
// credentials (model.ts `canBeAsked`).
//
// The key goes to the address it was given for and nowhere a redirect points; an answer far longer than
// asked for is given up on; and what's thrown says what went wrong without ever quoting the key or the
// provider's own words (an error body can repeat what it was sent).
//
// Not exported from the package index: the web app never sees credentials.

import type { RunnerModel } from "./model.ts";

/** The most of an answer that's read. */
const MAX_ANSWER_BYTES = 1024 * 1024;
/** Room for a model that thinks before it answers. */
const DEFAULT_MAX_TOKENS = 8000;

export interface Said {
    text: string;
    input: number;
    output: number;
}

export interface AskOptions {
    system: string;
    user: string;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    /** The most it may write, where the protocol takes a limit. */
    maxTokens?: number | undefined;
    fetch?: typeof fetch | undefined;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

type Asked = Required<Pick<AskOptions, "system" | "user" | "maxTokens">>;

/** The request each protocol takes, and what it says back. */
const PROTOCOLS: Record<
    Exclude<RunnerModel["protocol"], "anthropic-bedrock">,
    {
        path: string;
        headers(model: RunnerModel): Record<string, string>;
        body(model: RunnerModel, asked: Asked): Record<string, unknown>;
        read(answer: Record<string, unknown>): Said;
    }
> = {
    openai: {
        path: "/chat/completions",
        headers: (m) => ({ authorization: `Bearer ${m.apiKey}` }),
        body: (m, a) => ({
            model: m.model,
            messages: [
                { role: "system", content: a.system },
                { role: "user", content: a.user },
            ],
        }),
        read(answer) {
            const message = (answer.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message;
            const usage = (answer.usage ?? {}) as Record<string, unknown>;
            // Some servers give the content as parts.
            const said = Array.isArray(message?.content)
                ? message.content.map((p: { text?: unknown }) => (typeof p?.text === "string" ? p.text : "")).join("")
                : message?.content;
            return {
                text: typeof said === "string" ? said : "",
                input: count(usage.prompt_tokens),
                output: count(usage.completion_tokens),
            };
        },
    },
    "openai-responses": {
        path: "/responses",
        headers: (m) => ({ authorization: `Bearer ${m.apiKey}` }),
        body: (m, a) => ({ model: m.model, instructions: a.system, input: a.user, store: false }),
        read(answer) {
            const usage = (answer.usage ?? {}) as Record<string, unknown>;
            const said = (Array.isArray(answer.output) ? answer.output : [])
                .flatMap((o: { type?: unknown; content?: unknown }) => (o?.type === "message" && Array.isArray(o.content) ? o.content : []))
                .map((c: { type?: unknown; text?: unknown }) => (c?.type === "output_text" && typeof c.text === "string" ? c.text : ""))
                .join("");
            return { text: said, input: count(usage.input_tokens), output: count(usage.output_tokens) };
        },
    },
    anthropic: {
        path: "/v1/messages",
        headers: (m) => ({ "x-api-key": m.apiKey, "anthropic-version": "2023-06-01" }),
        body: (m, a) => ({ model: m.model, max_tokens: a.maxTokens, system: a.system, messages: [{ role: "user", content: a.user }] }),
        read(answer) {
            const usage = (answer.usage ?? {}) as Record<string, unknown>;
            // Only what it wrote as its answer: a model that thinks first sends that as blocks of another type.
            const said = (Array.isArray(answer.content) ? answer.content : [])
                .map((c: { type?: unknown; text?: unknown }) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
                .join("");
            return {
                text: said,
                input: count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
                output: count(usage.output_tokens),
            };
        },
    },
};

/** A response's body as text, given up on once it's longer than anything a model should say here. */
async function limited(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_ANSWER_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error("its answer was far longer than it should be");
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** One request to the model. Throws saying what went wrong, never with the key in it (callers redact anyway). */
export async function askModel(model: RunnerModel, options: AskOptions): Promise<Said> {
    if (model.protocol === "anthropic-bedrock") throw new Error("a model on Amazon Bedrock can't be asked");
    // A server newer than this runner may name a protocol it doesn't speak.
    if (!Object.hasOwn(PROTOCOLS, model.protocol))
        throw new Error(`a model that speaks ${String(model.protocol).slice(0, 40)} can't be asked here`);
    const protocol = PROTOCOLS[model.protocol];
    const url = `${model.url.replace(/\/+$/, "")}${protocol.path}`;
    if (!/^https?:\/\//i.test(url)) throw new Error("the model has no address to ask at");
    const { timeoutMs, signal } = options;
    const limit = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
        res = await (options.fetch ?? fetch)(url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json", ...protocol.headers(model) },
            body: JSON.stringify(
                protocol.body(model, { system: options.system, user: options.user, maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS }),
            ),
            // The key goes to the address it was given for, and nowhere a redirect points.
            redirect: "error",
            signal: signal ? AbortSignal.any([limit, signal]) : limit,
        });
    } catch (err) {
        const waited = Math.max(1, Math.round(timeoutMs / 1000));
        if (limit.aborted) throw new Error(`it didn't answer within ${waited} second${waited === 1 ? "" : "s"}`);
        throw new Error(`it couldn't be reached (${(err as Error).message})`);
    }
    if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`its provider answered ${res.status}`);
    }
    let answer: unknown;
    try {
        answer = JSON.parse(await limited(res));
    } catch (err) {
        throw new Error(/longer than/.test((err as Error).message) ? (err as Error).message : "its provider's answer wasn't JSON");
    }
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("its provider's answer wasn't an object");
    return protocol.read(answer as Record<string, unknown>);
}

/** What went wrong, whatever was thrown. */
export const whyNot = (err: unknown): string => (err instanceof Error && err.message) || String(err) || "something went wrong";

/**
 * The first JSON object in what a model said, or null: models wrap an answer in words, or in a code
 * fence, however plainly they're asked not to.
 */
export function jsonIn(said: string): Record<string, unknown> | null {
    const from = said.indexOf("{");
    const to = said.lastIndexOf("}");
    if (from < 0 || to <= from) return null;
    try {
        const parsed: unknown = JSON.parse(said.slice(from, to + 1));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}
