// A fake OpenID Connect provider for tests: discovery, JWKS, an authorization endpoint that approves a
// configurable identity straight away, a token endpoint (client secret, PKCE, one-use codes) and an
// end-session endpoint. It answers fetch-style Requests, so tests run it in the same process (no
// network), and fake-oidc-server.ts serves it over HTTP for the browser tests. ID tokens are RS256,
// signed with node:crypto; `tamper` breaks them in the ways the checks must catch.

import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

export interface FakeIdentity {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    preferred_username?: string;
    groups?: string[];
}

/** Ways to spoil the next ID tokens. */
export interface Tamper {
    aud?: string | string[];
    azp?: string;
    iss?: string;
    nonce?: string;
    /** Seconds from now; negative for an expired token. */
    expiresIn?: number;
    /** Sign with a key that isn't in the JWKS (same kid). */
    badSignature?: boolean;
    /** Seconds before now that the person "authenticated". */
    authAgo?: number;
    /** Leave auth_time out of the ID token, as some providers do when not asked for max_age. */
    noAuthTime?: boolean;
    /** Send this state back instead of the one given. */
    state?: string;
}

interface Grant {
    redirectUri: string;
    challenge: string;
    nonce: string | undefined;
    identity: FakeIdentity;
}

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

export class FakeProvider {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUris: string[];
    /** Who the next authorization approves; null refuses (access_denied). */
    identity: FakeIdentity | null = { sub: "user-1", email: "sam@example.com", email_verified: true, name: "Sam Example" };
    tamper: Tamper = {};
    /** Every authorization request's parameters, for assertions. */
    readonly authorizations: URLSearchParams[] = [];
    readonly endSessions: URLSearchParams[] = [];
    /** Every ID token handed out. */
    readonly issued: string[] = [];
    private readonly control: boolean;
    private readonly key: KeyObject;
    private readonly otherKey: KeyObject;
    private readonly jwk: Record<string, unknown>;
    private readonly codes = new Map<string, Grant>();

    constructor(options: { issuer: string; clientId: string; clientSecret: string; redirectUris: string[]; control?: boolean }) {
        this.issuer = options.issuer;
        this.clientId = options.clientId;
        this.clientSecret = options.clientSecret;
        this.redirectUris = options.redirectUris;
        this.control = options.control ?? false;
        const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
        this.key = pair.privateKey;
        this.otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
        this.jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
    }

    private url(path: string): string {
        return new URL(path, this.issuer.endsWith("/") ? this.issuer : `${this.issuer}/`).href;
    }

    /** Answer a request, as `fetch` would. */
    fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const req = input instanceof Request ? input : new Request(input, init);
        return this.handle(req);
    };

    handle = async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        const path = url.href.split("?")[0] as string;
        if (path === this.url(".well-known/openid-configuration")) return Response.json(this.discovery());
        if (path === this.url("jwks")) return Response.json({ keys: [this.jwk] });
        if (path === this.url("authorize")) return this.authorize(url.searchParams);
        if (path === this.url("token") && req.method === "POST") return this.token(req);
        if (path === this.url("end-session")) return this.endSession(url.searchParams);
        if (this.control && url.pathname === "/__control" && req.method === "POST") {
            const body = (await req.json()) as { identity?: FakeIdentity | null; tamper?: Tamper };
            if (body.identity !== undefined) this.identity = body.identity;
            this.tamper = body.tamper ?? {};
            return Response.json({ ok: true });
        }
        return new Response("Not found", { status: 404 });
    };

    discovery() {
        return {
            issuer: this.issuer,
            authorization_endpoint: this.url("authorize"),
            token_endpoint: this.url("token"),
            jwks_uri: this.url("jwks"),
            end_session_endpoint: this.url("end-session"),
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
            grant_types_supported: ["authorization_code"],
            scopes_supported: ["openid", "email", "profile"],
        };
    }

    private authorize(q: URLSearchParams): Response {
        this.authorizations.push(q);
        const redirectUri = q.get("redirect_uri") ?? "";
        if (q.get("client_id") !== this.clientId || !this.redirectUris.includes(redirectUri))
            return new Response("Unknown client or redirect URI", { status: 400 });
        const back = new URL(redirectUri);
        back.searchParams.set("state", this.tamper.state ?? q.get("state") ?? "");
        if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
            back.searchParams.set("error", "invalid_request");
        } else if (!this.identity) {
            back.searchParams.set("error", "access_denied");
        } else {
            const code = randomBytes(16).toString("base64url");
            this.codes.set(code, {
                redirectUri,
                challenge: q.get("code_challenge") as string,
                nonce: q.get("nonce") ?? undefined,
                identity: this.identity,
            });
            back.searchParams.set("code", code);
        }
        return new Response(null, { status: 302, headers: { location: back.href } });
    }

    private async token(req: Request): Promise<Response> {
        const form = new URLSearchParams(await req.text());
        let id = form.get("client_id");
        let secret = form.get("client_secret");
        const basic = /^Basic (.+)$/.exec(req.headers.get("authorization") ?? "");
        if (basic) {
            // The secret may itself contain ":", so split at the first one only (RFC 7617).
            const pair = Buffer.from(basic[1] as string, "base64").toString();
            const colon = pair.indexOf(":");
            id = decodeURIComponent(colon < 0 ? pair : pair.slice(0, colon));
            secret = decodeURIComponent(colon < 0 ? "" : pair.slice(colon + 1));
        }
        const fail = (error: string) => Response.json({ error }, { status: 400 });
        if (id !== this.clientId || secret !== this.clientSecret) return Response.json({ error: "invalid_client" }, { status: 401 });
        if (form.get("grant_type") !== "authorization_code") return fail("unsupported_grant_type");
        const code = form.get("code") ?? "";
        const grant = this.codes.get(code);
        this.codes.delete(code);
        if (!grant || grant.redirectUri !== form.get("redirect_uri")) return fail("invalid_grant");
        const verifier = form.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return fail("invalid_grant");
        const idToken = this.idToken(grant);
        this.issued.push(idToken);
        return Response.json({
            access_token: randomBytes(16).toString("base64url"),
            token_type: "Bearer",
            expires_in: 300,
            id_token: idToken,
        });
    }

    private idToken(grant: Grant): string {
        const t = this.tamper;
        const now = Math.floor(Date.now() / 1000);
        const { sub, ...profile } = grant.identity;
        const claims: Record<string, unknown> = {
            iss: t.iss ?? this.issuer,
            sub,
            aud: t.aud ?? this.clientId,
            exp: now + (t.expiresIn ?? 300),
            iat: now,
            ...(t.noAuthTime ? {} : { auth_time: now - (t.authAgo ?? 0) }),
            ...(t.azp ? { azp: t.azp } : {}),
            ...((t.nonce ?? grant.nonce) ? { nonce: t.nonce ?? grant.nonce } : {}),
            ...profile,
        };
        const data = `${b64({ alg: "RS256", typ: "JWT", kid: "test-key" })}.${b64(claims)}`;
        const signature = sign("sha256", Buffer.from(data), t.badSignature ? this.otherKey : this.key).toString("base64url");
        return `${data}.${signature}`;
    }

    private endSession(q: URLSearchParams): Response {
        this.endSessions.push(q);
        const back = q.get("post_logout_redirect_uri");
        if (back) return new Response(null, { status: 302, headers: { location: back } });
        return new Response("Signed out", { status: 200 });
    }
}
