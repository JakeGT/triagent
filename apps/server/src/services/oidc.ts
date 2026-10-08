// Signing in through an OpenID Connect provider (AUTH_MODE=oidc), with openid-client: discovery, the
// authorization code flow with PKCE, state and nonce, and ID token checks (signature against the
// provider's JWKS, iss, aud, azp, exp, nonce, and auth_time when a max_age was asked for).
//
// What the flow must remember between sending someone to the provider and their return (state, nonce,
// PKCE verifier and where to go next) travels in a short-lived cookie, encrypted and authenticated with a
// key derived from TRIAGENT_SECRETS_KEY, so the browser can neither read nor alter it.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import * as client from "openid-client";
import type { OidcConfig } from "../config.ts";

/** How long someone has to finish signing in at the provider. */
export const LOGIN_STATE_SECONDS = 600;
const STATE_AAD = Buffer.from("triagent-oidc-login-state-v1");

/** Who the provider says signed in, from a verified ID token. */
export interface Identity {
    issuer: string;
    subject: string;
    email: string | null;
    emailVerified: boolean;
    name: string | null;
    preferredUsername: string | null;
    groups: string[];
    /** When the person actually authenticated at the provider (ms), if it said. */
    authTime: number | null;
}

interface LoginState {
    state: string;
    nonce: string;
    verifier: string;
    next: string;
    maxAge: number | null;
    expires: number;
}

/** Why a sign-in couldn't finish. Shown to people as a short message chosen by the code. */
export class OidcError extends Error {
    readonly code: "expired" | "denied" | "failed" | "unavailable";
    constructor(code: OidcError["code"], message: string) {
        super(message);
        this.code = code;
    }
}

/**
 * A same-origin path to return to after signing in, or "/". Anything else (another origin, a
 * protocol-relative `//host`, a backslash trick, control characters) is refused, so a link can't use
 * the sign-in flow to send someone elsewhere.
 */
export function safeNext(value: unknown): string {
    if (typeof value !== "string" || value.length > 2000) return "/";
    if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
    if (/[\\\u0000-\u001f\u007f]/.test(value)) return "/";
    try {
        // Resolved against a dummy origin: still on it means it's a path, not an address.
        const url = new URL(value, "http://triagent.invalid");
        if (url.origin !== "http://triagent.invalid") return "/";
        return `${url.pathname}${url.search}${url.hash}`;
    } catch {
        return "/";
    }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export class Oidc {
    readonly settings: OidcConfig;
    readonly redirectUri: string;
    private readonly publicOrigin: string;
    private readonly key: Buffer;
    private configuration: Promise<client.Configuration> | null = null;
    /** Replaces fetch for requests to the provider (tests run a provider in the same process). */
    fetch: typeof fetch | null = null;

    constructor(settings: OidcConfig, publicOrigin: string, secretsKey: Buffer | null) {
        this.settings = settings;
        this.publicOrigin = publicOrigin;
        this.redirectUri = `${publicOrigin}/auth/callback`;
        // Without a configured key (development only), a per-process one: a restart just means signing in again.
        this.key = Buffer.from(hkdfSync("sha256", secretsKey ?? randomBytes(32), Buffer.alloc(0), "triagent oidc login state", 32));
    }

    /** The provider's configuration, discovered on first use and kept; a failed discovery is tried again next time. */
    private config(): Promise<client.Configuration> {
        if (!this.configuration) {
            const issuer = new URL(this.settings.issuer);
            const execute = [client.enableNonRepudiationChecks];
            if (issuer.protocol === "http:") execute.push(client.allowInsecureRequests);
            this.configuration = client
                .discovery(
                    issuer,
                    this.settings.clientId,
                    { id_token_signed_response_alg: "RS256" },
                    client.ClientSecretBasic(this.settings.clientSecret),
                    { execute, ...(this.fetch ? { [client.customFetch]: this.fetch as client.CustomFetch } : {}) },
                )
                .catch((err: unknown) => {
                    this.configuration = null;
                    console.error(`Couldn't read the identity provider's configuration from ${issuer.href}: ${describe(err)}`);
                    throw new OidcError("unavailable", "The sign-in provider can't be reached.");
                });
        }
        return this.configuration;
    }

    /** Where to send someone to sign in, and the sealed cookie that remembers this attempt. */
    async start(input: { next: string; prompt?: string | null; maxAge?: number | null }): Promise<{ url: string; cookie: string }> {
        const config = await this.config();
        const verifier = client.randomPKCECodeVerifier();
        const state: LoginState = {
            state: client.randomState(),
            nonce: client.randomNonce(),
            verifier,
            next: safeNext(input.next),
            maxAge: input.maxAge ?? null,
            expires: Date.now() + LOGIN_STATE_SECONDS * 1000,
        };
        const params: Record<string, string> = {
            redirect_uri: this.redirectUri,
            scope: this.settings.scopes,
            code_challenge: await client.calculatePKCECodeChallenge(verifier),
            code_challenge_method: "S256",
            state: state.state,
            nonce: state.nonce,
        };
        if (input.prompt) params.prompt = input.prompt;
        if (input.maxAge !== null && input.maxAge !== undefined) params.max_age = String(input.maxAge);
        return { url: client.buildAuthorizationUrl(config, params).href, cookie: this.seal(state) };
    }

    /**
     * Finish a sign-in: check the returned state against the cookie, exchange the code (with the PKCE
     * verifier) and verify the ID token. `search` is the callback's query string.
     */
    async finish(search: string, cookie: string | undefined): Promise<{ identity: Identity; idToken: string; next: string }> {
        const state = cookie ? this.open(cookie) : null;
        if (!state || state.expires < Date.now())
            throw new OidcError("expired", "The sign-in took too long or started in another browser.");
        const params = new URLSearchParams(search);
        if (params.get("error")) {
            // Shown in the log only: the provider's own words, trimmed, never the request.
            console.warn(`The identity provider refused a sign-in: ${String(params.get("error")).slice(0, 80)}`);
            throw new OidcError("denied", "The sign-in provider didn't let you in.");
        }
        const config = await this.config();
        // Built from PUBLIC_ORIGIN, not the request: behind a proxy the request's own address differs, and
        // the redirect_uri sent with the code must match the one used to start.
        const currentUrl = new URL(`${this.redirectUri}?${params.toString()}`);
        let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
        try {
            tokens = await client.authorizationCodeGrant(config, currentUrl, {
                pkceCodeVerifier: state.verifier,
                expectedState: state.state,
                expectedNonce: state.nonce,
                idTokenExpected: true,
                ...(state.maxAge !== null ? { maxAge: state.maxAge } : {}),
            });
        } catch (err) {
            console.warn(`A sign-in failed its checks: ${describe(err)}`);
            throw new OidcError("failed", "The sign-in couldn't be verified.");
        }
        const claims = tokens.claims();
        const idToken = tokens.id_token;
        if (!claims || !idToken) throw new OidcError("failed", "The provider sent no ID token.");
        // openid-client checks azp when there are several audiences; a token for one audience naming another
        // authorised party isn't ours either.
        if (claims.azp !== undefined && claims.azp !== this.settings.clientId) {
            console.warn("A sign-in failed its checks: the ID token's azp names another client.");
            throw new OidcError("failed", "The sign-in couldn't be verified.");
        }
        const groups = Array.isArray(claims.groups) ? claims.groups.filter((g): g is string => typeof g === "string") : [];
        return {
            identity: {
                issuer: claims.iss,
                subject: claims.sub,
                email: str(claims.email)?.toLowerCase() ?? null,
                emailVerified: claims.email_verified === true,
                name: str(claims.name),
                preferredUsername: str(claims.preferred_username),
                groups,
                authTime: typeof claims.auth_time === "number" ? claims.auth_time * 1000 : null,
            },
            idToken,
            next: state.next,
        };
    }

    /** RP-initiated logout at the provider, returning to Triagent's front page. Null if the provider doesn't offer it. */
    async endSessionUrl(idToken: string | null | undefined): Promise<string | null> {
        let config: client.Configuration;
        try {
            config = await this.config();
        } catch {
            return null;
        }
        if (!config.serverMetadata().end_session_endpoint) return null;
        const params: Record<string, string> = { post_logout_redirect_uri: this.publicOrigin };
        if (idToken) params.id_token_hint = idToken;
        return client.buildEndSessionUrl(config, params).href;
    }

    private seal(state: LoginState): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        cipher.setAAD(STATE_AAD);
        const body = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
        return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
    }

    private open(value: string): LoginState | null {
        try {
            const raw = Buffer.from(value, "base64url");
            if (raw.length < 29 || raw.length > 4096) return null;
            const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
            decipher.setAAD(STATE_AAD);
            decipher.setAuthTag(raw.subarray(raw.length - 16));
            const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
            const state = JSON.parse(text) as LoginState;
            return typeof state.state === "string" && typeof state.verifier === "string" ? state : null;
        } catch {
            return null;
        }
    }
}

/** An error's code and message for the log: openid-client's messages describe the check that failed, never a token. */
function describe(err: unknown): string {
    if (err instanceof Error) {
        const code = (err as { code?: unknown }).code;
        return `${typeof code === "string" ? `${code}: ` : ""}${err.message}`.slice(0, 300);
    }
    return String(err).slice(0, 300);
}
