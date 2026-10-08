// An in-process server in AUTH_MODE=oidc, wired to the fake provider in fake-oidc.ts: the server's
// requests to the provider go straight to it (no network), and `signIn` walks a browser's part of the
// flow (Triagent → provider → Triagent) by following the redirects by hand.

import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Route } from "../src/http/route.ts";
import { createServices, type Services } from "../src/services/index.ts";
import type { Store } from "../src/store/types.ts";
import { type FakeIdentity, FakeProvider, type Tamper } from "./fake-oidc.ts";
import { ORIGIN, type Session, testStore } from "./helpers.ts";

export const ISSUER = "https://idp.test/application/o/triagent/";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field in the tests
type Body = any;

export interface Reply {
    status: number;
    body: Body;
    text: string;
    location: string | null;
    /** Cookies the response set, by name ("" when cleared). */
    cookies: Record<string, string>;
}

export interface SignInResult {
    /** Where Triagent sent the browser at the end. */
    location: string | null;
    session: Session | null;
    /** The authorization request the provider saw. */
    authorization: URLSearchParams;
}

export interface OidcTestApp {
    app: Hono;
    routes: Route[];
    services: Services;
    provider: FakeProvider;
    request(
        path: string,
        init?: { method?: string; body?: unknown; session?: Session; cookies?: Record<string, string>; headers?: Record<string, string> },
    ): Promise<Reply>;
    /** Sign in as `identity` (or whoever the provider is set to approve), optionally from an existing session. */
    signIn(
        identity?: FakeIdentity | null,
        options?: {
            next?: string;
            query?: string;
            tamper?: Tamper;
            from?: Session;
            editAuthorize?(url: URL): void;
            editCallback?(url: URL): void;
        },
    ): Promise<SignInResult>;
}

function cookiesOf(res: Response): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const i = (pair ?? "").indexOf("=");
        if (i > 0) out[(pair as string).slice(0, i)] = decodeURIComponent((pair as string).slice(i + 1));
    }
    return out;
}

export async function oidcTestApp(env: Record<string, string> = {}, store?: Store): Promise<OidcTestApp> {
    const provider = new FakeProvider({
        issuer: ISSUER,
        clientId: "triagent",
        clientSecret: "client-secret-for-tests",
        redirectUris: [`${ORIGIN}/auth/callback`],
    });
    const config = loadConfig({
        PUBLIC_ORIGIN: ORIGIN,
        COOKIE_SECURE: "false",
        AUTH_MODE: "oidc",
        OIDC_ISSUER: ISSUER,
        OIDC_CLIENT_ID: "triagent",
        OIDC_CLIENT_SECRET: "client-secret-for-tests",
        OIDC_PROVIDER_NAME: "Test ID",
        TRIAGENT_SECRETS_KEY: randomBytes(32).toString("base64"),
        REQUESTS_PER_MINUTE: "1000000",
        ...env,
    });
    const services = createServices(config, store ?? (await testStore()));
    if (!services.oidc) throw new Error("expected OIDC");
    services.oidc.fetch = provider.fetch;
    const { app, routes } = createApp(services);

    const request: OidcTestApp["request"] = async (path, init = {}) => {
        const headers: Record<string, string> = { ...init.headers };
        if (init.body !== undefined) headers["content-type"] = "application/json";
        const cookies = { ...init.cookies };
        if (init.session) {
            const [name, value] = init.session.cookie.split("=");
            cookies[name as string] = value as string;
            headers["x-csrf-token"] = init.session.csrf;
            headers.origin = ORIGIN;
        }
        const cookieHeader = Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
        if (cookieHeader) headers.cookie = cookieHeader;
        const res = await app.request(path.startsWith("http") ? path : `${ORIGIN}${path}`, {
            method: init.method ?? "GET",
            headers,
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        const text = await res.text();
        let body: unknown = text;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            // not JSON
        }
        return { status: res.status, body, text, location: res.headers.get("location"), cookies: cookiesOf(res) };
    };

    const signIn: OidcTestApp["signIn"] = async (identity, options = {}) => {
        if (identity !== undefined) provider.identity = identity;
        provider.tamper = options.tamper ?? {};
        const fromCookies: Record<string, string> = {};
        if (options.from) {
            const [name, value] = options.from.cookie.split("=");
            fromCookies[name as string] = value as string;
        }
        const query = options.query ?? (options.next !== undefined ? `next=${encodeURIComponent(options.next)}` : "");
        const start = await request(`/auth/login${query ? `?${query}` : ""}`, { cookies: fromCookies });
        if (start.status !== 302 || !start.location) throw new Error(`/auth/login answered ${start.status}: ${start.text}`);
        const state = start.cookies.triagent_oidc;
        if (!state) throw new Error("no login state cookie");
        const authorizeUrl = new URL(start.location);
        options.editAuthorize?.(authorizeUrl);
        const authorize = await provider.fetch(authorizeUrl);
        const callback = new URL(authorize.headers.get("location") ?? "");
        options.editCallback?.(callback);
        const done = await request(`${callback.pathname}${callback.search}`, { cookies: { ...fromCookies, triagent_oidc: state } });
        const authorization = provider.authorizations.at(-1) as URLSearchParams;
        provider.tamper = {};
        const sid = done.cookies.triagent_sid;
        if (!sid) return { location: done.location, session: null, authorization };
        const cookie = `triagent_sid=${sid}`;
        const me = await request("/api/v1/me", { session: { cookie, csrf: "" } });
        return { location: done.location, session: { cookie, csrf: me.body.csrf }, authorization };
    };

    return { app, routes, services, provider, request, signIn };
}
