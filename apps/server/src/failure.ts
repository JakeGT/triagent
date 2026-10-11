// Telling apart what failed because of us from what failed because of something outside, when logging it.
// Ours is an `error`: it's reported, with its stack, for someone to fix. Something outside being away or
// saying no (GitHub, an identity provider, the network) is a `warn`: it's expected now and then, and the
// message says enough.

import { type LogFields, log } from "@triagent/shared/log";
import { ApiError } from "./errors.ts";
import { GitHubError } from "./services/github/client.ts";

const NETWORK = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
]);

/** Whether `err` came from outside: another service refusing or away, the network, or a request that was rightly refused. */
export function fromOutside(err: unknown, depth = 0): boolean {
    if (!(err instanceof Error)) return false;
    if (err instanceof ApiError) return err.status < 500;
    if (err instanceof GitHubError || err.name === "AbortError" || err.name === "TimeoutError") return true;
    if (err instanceof TypeError && err.message === "fetch failed") return true;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK.has(code)) return true;
    return depth < 3 && err.cause !== undefined && fromOutside(err.cause, depth + 1);
}

/** Log that something failed, as a warning or an error depending on where the fault lies. */
export function logFailure(msg: string, err: unknown, fields: LogFields = {}): void {
    if (fromOutside(err)) log.warn(msg, { ...fields, err });
    else log.error(msg, { ...fields, err });
}

/**
 * `err` with its message left out, keeping what kind it is and where it was thrown: for failures whose
 * message can quote what was being handled (a report's findings, a row being saved).
 */
export function withoutMessage(err: unknown): Error {
    const e = err instanceof Error ? err : new Error(String(err));
    const code = (e as { code?: unknown }).code;
    const out = new Error(`message withheld${typeof code === "string" ? ` (code ${code.slice(0, 40)})` : ""}`);
    out.name = e.name;
    const frames = (e.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l));
    out.stack = [`${out.name}: ${out.message}`, ...frames].join("\n");
    return out;
}
