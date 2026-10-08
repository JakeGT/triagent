// The runner's settings, from the environment. The secret can come from a file (NAME_FILE), the Docker
// secrets convention.

import { readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

export interface RunnerConfig {
    serverUrl: string;
    secret: string;
    name: string;
    concurrency: number;
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

export function loadConfig(env: Env = process.env): RunnerConfig {
    const serverUrl = (env.TRIAGENT_SERVER_URL ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+$/.test(serverUrl))
        throw new ConfigError("Set TRIAGENT_SERVER_URL to the Triagent server's address, like http://triagent:8080.");
    const secret = secretFromEnv(env, "TRIAGENT_RUNNER_SECRET");
    if (!secret || secret.length < 32)
        throw new ConfigError(
            "Set TRIAGENT_RUNNER_SECRET_FILE (or TRIAGENT_RUNNER_SECRET): the secret shared with the server, at least 32 characters.",
        );
    const llmTimeout = env.OCR_LLM_TIMEOUT || null;
    if (llmTimeout && !/^\d{1,5}$/.test(llmTimeout)) throw new ConfigError("OCR_LLM_TIMEOUT must be a number of seconds.");
    const port = env.RUNNER_HEALTH_PORT ? whole(env, "RUNNER_HEALTH_PORT", 0, 1, 65535) : null;
    return {
        serverUrl,
        secret,
        name: (env.RUNNER_NAME || hostname()).slice(0, 100),
        concurrency: whole(env, "RUNNER_CONCURRENCY", 1, 1, 32),
        cacheDir: path.resolve(env.RUNNER_CACHE_DIR || path.join(tmpdir(), "triagent-runner-cache")),
        workDir: path.resolve(env.RUNNER_WORK_DIR || path.join(tmpdir(), "triagent-runner")),
        pollMs: whole(env, "RUNNER_POLL_SECONDS", 3, 1, 300) * 1000,
        healthPort: port,
        ocrBin: env.OCR_BIN || "ocr",
        gitBin: env.GIT_BIN || "git",
        llmTimeout,
        path: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    };
}
