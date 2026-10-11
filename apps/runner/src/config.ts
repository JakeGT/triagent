// The runner's settings, from the environment. The secret can come from a file (NAME_FILE), the Docker
// secrets convention; it's read once, here, at start-up, and kept in memory.

import { readFileSync, statSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { type LogFormat, type LogLevel, logOptionsFromEnv } from "../../../packages/shared/src/log.ts";

export interface RunnerConfig {
    serverUrl: string;
    secret: string;
    name: string;
    concurrency: number;
    /** How many of one job's models review at once; the rest wait their turn inside the job. */
    modelParallelism: number;
    /** How long a model that has passed its token budget gets to finish by itself before it's stopped; 0 stops it at once. */
    overBudgetGraceSeconds: number;
    cacheDir: string;
    workDir: string;
    pollMs: number;
    healthPort: number | null;
    ocrBin: string;
    gitBin: string;
    /** Passed to OCR as OCR_LLM_TIMEOUT, if set. */
    llmTimeout: string | null;
    /** The PATH OCR and git get (they get nothing else from the runner's own environment). */
    path: string;
    log: { level: LogLevel; format: LogFormat };
    /** Pass this runner's own log lines (never a review's) on to the server, for its error tracker. */
    relayLogs: boolean;
    /** Things worth fixing that don't stop the runner, to print at start-up. */
    warnings: string[];
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

function secretFromEnv(env: Env, name: string): string | undefined {
    const direct = env[name];
    const file = env[`${name}_FILE`];
    if (direct && file) throw new ConfigError(`Set ${name} or ${name}_FILE, not both.`);
    if (file) {
        try {
            return readFileSync(file, "utf8").replace(/\r?\n$/, "");
        } catch (err) {
            throw new ConfigError(`Couldn't read ${name}_FILE (${file}): ${(err as Error).message}`);
        }
    }
    return direct || undefined;
}

function whole(env: Env, name: string, fallback: number, min: number, max: number): number {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max)
        throw new ConfigError(`${name} must be a whole number from ${min} to ${max}, got "${v}".`);
    return Number(v);
}

/**
 * Why a secret file is readable by more than its owner, or null. OCR runs as the runner's user, so the
 * file can't be hidden from it, but it needn't be readable by anyone else too.
 */
export function secretFileWarning(file: string | undefined): string | null {
    if (!file) return null;
    try {
        const mode = statSync(file).mode & 0o777;
        return mode & 0o077
            ? `${file} can be read by users other than its owner (mode ${mode.toString(8).padStart(4, "0")}). Make it 0400, owned by the runner's user.`
            : null;
    } catch {
        return null;
    }
}

export function loadConfig(env: Env = process.env): RunnerConfig {
    const serverUrl = (env.TRIAGENT_SERVER_URL ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+$/.test(serverUrl))
        throw new ConfigError("Set TRIAGENT_SERVER_URL to the Triagent server's address, like http://triagent:8080.");
    const secret = secretFromEnv(env, "TRIAGENT_RUNNER_SECRET");
    if (!secret || secret.length < 32)
        throw new ConfigError(
            "Set TRIAGENT_RUNNER_SECRET_FILE (or TRIAGENT_RUNNER_SECRET): the secret shared with the server, at least 32 characters.",
        );
    // Seconds; 0 would time out every model call at once.
    const llmTimeout = env.OCR_LLM_TIMEOUT ? String(whole(env, "OCR_LLM_TIMEOUT", 0, 1, 86_400)) : null;
    const port = env.RUNNER_HEALTH_PORT ? whole(env, "RUNNER_HEALTH_PORT", 0, 1, 65535) : null;
    let logOptions: RunnerConfig["log"];
    try {
        logOptions = logOptionsFromEnv(env);
    } catch (err) {
        throw new ConfigError((err as Error).message);
    }
    const relay = env.RUNNER_RELAY_LOGS || "true";
    if (relay !== "true" && relay !== "false") throw new ConfigError(`RUNNER_RELAY_LOGS must be true or false, got "${relay}".`);
    return {
        serverUrl,
        secret,
        name: (env.RUNNER_NAME || hostname()).slice(0, 100),
        concurrency: whole(env, "RUNNER_CONCURRENCY", 1, 1, 32),
        modelParallelism: whole(env, "RUNNER_MODEL_PARALLELISM", 5, 1, 32),
        overBudgetGraceSeconds: whole(env, "RUNNER_OVER_BUDGET_GRACE_SECONDS", 120, 0, 3600),
        cacheDir: path.resolve(env.RUNNER_CACHE_DIR || path.join(tmpdir(), "triagent-runner-cache")),
        workDir: path.resolve(env.RUNNER_WORK_DIR || path.join(tmpdir(), "triagent-runner")),
        pollMs: whole(env, "RUNNER_POLL_SECONDS", 3, 1, 300) * 1000,
        healthPort: port,
        ocrBin: env.OCR_BIN || "ocr",
        gitBin: env.GIT_BIN || "git",
        llmTimeout,
        path: env.PATH || "/usr/local/bin:/usr/bin:/bin",
        log: logOptions,
        relayLogs: relay === "true",
        warnings: [secretFileWarning(env.TRIAGENT_RUNNER_SECRET_FILE)].filter((w): w is string => w !== null),
    };
}
