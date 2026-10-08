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
    authMode: "local" | "oidc";
    /** The identity provider, when AUTH_MODE=oidc. */
    oidc: OidcConfig | null;
    /** Who may create an account by signing in: only people with an invite (or in the admin group), or anyone. */
    signupMode: "invite" | "open";
    /** Shown with invites and on the "You need an invite" page, e.g. how to get onto the provider's allowlist. */
    inviteHint: string | null;
    /** Setting secrets needs a sign-in at most this many minutes old. */
    reauthMinutes: number;
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
    /** Fetch OpenRouter's public model catalogue (model names and prices). */
    openrouterCatalogue: boolean;
    production: boolean;
}

export interface OidcConfig {
    /** The issuer identifier, exactly as the provider's discovery document gives it. */
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    /** The sign-in button's label: "Sign in with {providerName}". */
    providerName: string;
    /** Members of this group (from the ID token's `groups` claim) are instance administrators. */
    adminGroup: string;
    /** Treat the provider's email addresses as verified even without `email_verified: true`. */
    trustEmail: boolean;
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

    const authMode = env.AUTH_MODE || "local";
    if (authMode !== "local" && authMode !== "oidc") throw new ConfigError(`AUTH_MODE must be "local" or "oidc", got "${authMode}".`);

    const adminUser = env.TRIAGENT_ADMIN_USER;
    const adminPassword = secretFromEnv(env, "TRIAGENT_ADMIN_PASSWORD");
    if (Boolean(adminUser) !== Boolean(adminPassword))
        throw new ConfigError("Set both TRIAGENT_ADMIN_USER and TRIAGENT_ADMIN_PASSWORD, or neither.");
    if (authMode === "oidc" && adminUser)
        throw new ConfigError(
            "TRIAGENT_ADMIN_USER only applies to AUTH_MODE=local. With OIDC, members of OIDC_ADMIN_GROUP are instance admins: remove it.",
        );
    const oidc = authMode === "oidc" ? oidcConfig(env, Boolean(publicOrigin)) : null;

    const signupMode = env.SIGNUP_MODE || "invite";
    if (signupMode !== "invite" && signupMode !== "open")
        throw new ConfigError(`SIGNUP_MODE must be "invite" or "open", got "${signupMode}".`);
    const inviteHint = (env.INVITE_HINT ?? "").trim() || null;
    if (inviteHint && inviteHint.length > 300) throw new ConfigError("Keep INVITE_HINT under 300 characters.");

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
        oidc,
        signupMode,
        inviteHint,
        reauthMinutes: whole(env, "REAUTH_MINUTES", 15, 1, 1440),
        bootstrapAdmin: adminUser && adminPassword ? { username: adminUser, password: adminPassword } : null,
        secretsKey,
        databaseUrl,
        databaseSchema,
        defaultBranch: env.DEFAULT_BRANCH ?? "main",
        requestsPerMinute: whole(env, "REQUESTS_PER_MINUTE", 600, 10, 1_000_000),
        sessionIdleMinutes: whole(env, "SESSION_IDLE_MINUTES", 480, 5, 525_600),
        sessionMaxHours: whole(env, "SESSION_MAX_HOURS", 72, 1, 8760),
        webDistDir: env.WEB_DIST_DIR || null,
        openrouterCatalogue: flag(env, "OPENROUTER_CATALOGUE", true),
        production,
    };
}

/** Loopback addresses, where a plain-http issuer is allowed (a provider running on the same machine, or tests). */
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

function oidcConfig(env: Env, publicOriginSet: boolean): OidcConfig {
    if (!publicOriginSet)
        throw new ConfigError(
            "AUTH_MODE=oidc needs PUBLIC_ORIGIN: the provider sends people back to PUBLIC_ORIGIN/auth/callback, which must match exactly.",
        );
    const issuer = env.OIDC_ISSUER ?? "";
    let url: URL;
    try {
        url = new URL(issuer);
    } catch {
        throw new ConfigError(
            `OIDC_ISSUER must be the provider's issuer URL, like https://auth.example.com/application/o/triagent/, got "${issuer}".`,
        );
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.test(url.hostname)))
        throw new ConfigError(`OIDC_ISSUER must use https (plain http is only allowed for localhost), got "${issuer}".`);
    if (url.search || url.hash) throw new ConfigError("OIDC_ISSUER must not have a query string or fragment.");
    const clientId = env.OIDC_CLIENT_ID ?? "";
    if (!clientId) throw new ConfigError("Set OIDC_CLIENT_ID: the client ID of Triagent's application at the provider.");
    const clientSecret = secretFromEnv(env, "OIDC_CLIENT_SECRET");
    if (!clientSecret) throw new ConfigError("Set OIDC_CLIENT_SECRET_FILE (or OIDC_CLIENT_SECRET): the client secret from the provider.");
    const scopes = (env.OIDC_SCOPES || "openid email profile").trim().split(/\s+/);
    if (!scopes.includes("openid")) throw new ConfigError(`OIDC_SCOPES must include "openid", got "${scopes.join(" ")}".`);
    if (!scopes.every((s) => /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)))
        throw new ConfigError("OIDC_SCOPES must be scope names separated by spaces.");
    const providerName = (env.OIDC_PROVIDER_NAME || "your identity provider").trim();
    if (providerName.length > 60) throw new ConfigError("Keep OIDC_PROVIDER_NAME under 60 characters.");
    const adminGroup = (env.OIDC_ADMIN_GROUP ?? "platform-admin").trim();
    if (!adminGroup) throw new ConfigError("OIDC_ADMIN_GROUP can't be empty: name the group whose members are instance admins.");
    return {
        issuer: url.href,
        clientId,
        clientSecret,
        scopes: scopes.join(" "),
        providerName,
        adminGroup,
        trustEmail: flag(env, "OIDC_TRUST_EMAIL", false),
    };
}
