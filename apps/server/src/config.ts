// Settings from the environment. Every secret can come from a file instead (NAME_FILE=/run/secrets/…), the
// Docker secrets convention, so secrets needn't sit in the process environment.

import { readFileSync } from "node:fs";

export interface Config {
    host: string;
    port: number;
    /** The address people use, e.g. https://code-review.example.com. Used for Origin checks and links. */
    publicOrigin: string;
    /** Trust X-Forwarded-* from this many proxies in front (0: trust none). */
    proxyHops: number;
    cookieSecure: boolean;
    authMode: "local";
    /** Created at start-up if no accounts exist yet. */
    bootstrapAdmin: { username: string; password: string } | null;
    /** 32-byte key that encrypts stored secrets, base64. Null only in development. */
    secretsKey: Buffer | null;
    /** Postgres connection string. Null keeps everything in memory (development only). */
    databaseUrl: string | null;
    /** The schema to keep Triagent's tables in, if not the database's default. */
    databaseSchema: string | null;
    defaultBranch: string;
    requestsPerMinute: number;
    sessionIdleMinutes: number;
    sessionMaxHours: number;
    /** The built web app to serve, or null for this repository's apps/web/dist. */
    webDistDir: string | null;
    production: boolean;
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

/** NAME, or the contents of the file named by NAME_FILE (trailing newline removed). Not both. */
export function secretFromEnv(env: Env, name: string): string | undefined {
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
    if (!/^\d+$/.test(v)) throw new ConfigError(`${name} must be a whole number, got "${v}".`);
    const n = Number(v);
    if (n < min || n > max) throw new ConfigError(`${name} must be from ${min} to ${max}, got ${n}.`);
    return n;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    throw new ConfigError(`${name} must be true or false, got "${v}".`);
}

export function loadConfig(env: Env = process.env): Config {
    const production = env.NODE_ENV === "production";
    const port = whole(env, "PORT", 8080, 1, 65535);
    const publicOrigin = (env.PUBLIC_ORIGIN ?? "").replace(/\/+$/, "");
    if (publicOrigin && !/^https?:\/\/[^/\s]+$/.test(publicOrigin))
        throw new ConfigError(`PUBLIC_ORIGIN must be a scheme and host, like https://code-review.example.com, got "${publicOrigin}".`);
    if (!publicOrigin && production) throw new ConfigError("Set PUBLIC_ORIGIN, the address people use to reach Triagent.");

    const authMode = env.AUTH_MODE ?? "local";
    if (authMode !== "local") throw new ConfigError(`AUTH_MODE "${authMode}" isn't available yet. Use "local".`);

    const adminUser = env.TRIAGENT_ADMIN_USER;
    const adminPassword = secretFromEnv(env, "TRIAGENT_ADMIN_PASSWORD");
    if (Boolean(adminUser) !== Boolean(adminPassword))
        throw new ConfigError("Set both TRIAGENT_ADMIN_USER and TRIAGENT_ADMIN_PASSWORD, or neither.");

    const keyText = secretFromEnv(env, "TRIAGENT_SECRETS_KEY");
    let secretsKey: Buffer | null = null;
    if (keyText) {
        secretsKey = Buffer.from(keyText, "base64");
        if (secretsKey.length !== 32)
            throw new ConfigError("TRIAGENT_SECRETS_KEY must be 32 random bytes, base64-encoded (e.g. `openssl rand -base64 32`).");
    } else if (production) {
        throw new ConfigError("Set TRIAGENT_SECRETS_KEY_FILE (or TRIAGENT_SECRETS_KEY): the key that encrypts stored secrets.");
    }

    const databaseUrl = secretFromEnv(env, "DATABASE_URL") ?? null;
    if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl))
        throw new ConfigError("DATABASE_URL must be a Postgres connection string, like postgres://triagent:…@db:5432/triagent.");
    if (!databaseUrl && production)
        throw new ConfigError("Set DATABASE_URL_FILE (or DATABASE_URL): without a database, everything is lost when the server stops.");
    const databaseSchema = env.DATABASE_SCHEMA || null;
    if (databaseSchema && !/^[a-z_][a-z0-9_]{0,62}$/.test(databaseSchema))
        throw new ConfigError(`DATABASE_SCHEMA must be lower-case letters, digits and underscores, got "${databaseSchema}".`);

    return {
        host: env.HOST ?? "127.0.0.1",
        port,
        publicOrigin: publicOrigin || `http://localhost:${port}`,
        proxyHops: whole(env, "PROXY_HOPS", 0, 0, 10),
        cookieSecure: flag(env, "COOKIE_SECURE", true),
        authMode,
        bootstrapAdmin: adminUser && adminPassword ? { username: adminUser, password: adminPassword } : null,
        secretsKey,
        databaseUrl,
        databaseSchema,
        defaultBranch: env.DEFAULT_BRANCH ?? "main",
        requestsPerMinute: whole(env, "REQUESTS_PER_MINUTE", 600, 10, 1_000_000),
        sessionIdleMinutes: whole(env, "SESSION_IDLE_MINUTES", 480, 5, 525_600),
        sessionMaxHours: whole(env, "SESSION_MAX_HOURS", 72, 1, 8760),
        webDistDir: env.WEB_DIST_DIR || null,
        production,
    };
}
