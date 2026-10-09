// The one way the app talks to the server. Every write carries the session's CSRF token, every request
// carries this tab's client id (so the live stream can skip our own changes), and errors come back as
// ApiError with the server's message, code and, on a 409, the current version.

import { localPath } from "./safe-href";
import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    readonly body: ApiErrorBody;

    constructor(status: number, body: ApiErrorBody) {
        super(body.error || `The server answered ${status}.`);
        this.name = "ApiError";
        this.status = status;
        this.code = body.code;
        this.body = body;
    }

    /** On a 409 from a stale `rev`: the version someone else saved. */
    get current(): unknown {
        return this.body.current;
    }
}

export const isApiError = (err: unknown, status?: number): err is ApiError =>
    err instanceof ApiError && (status === undefined || err.status === status);

/** The current version sent back with a 409, if there is one. */
export function conflictCurrent<T>(err: unknown): T | null {
    return isApiError(err, 409) && err.current ? (err.current as T) : null;
}

/** A message for people, whatever was thrown. */
export function errorMessage(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    if (err instanceof TypeError) return "Couldn't reach the server. Check your connection and try again.";
    return err instanceof Error ? err.message : String(err);
}

function randomClientId(): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return `tab-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Identifies this tab to the server; live updates carrying it are our own echo. */
export const CLIENT_ID = randomClientId();

interface Hooks {
    /** The session ended (401): go to sign-in. */
    onSignedOut(): void;
    /** The account must set a new password before anything else (403 password_change_required). */
    onPasswordChangeRequired(): void;
    /**
     * The step needs a recent sign-in (401 reauth_required): ask the person to confirm it's them. Resolves
     * true once they have (the request is then sent again), false if they'd rather not.
     */
    onReauthRequired?(body: ApiErrorBody): Promise<boolean>;
}

const state: { csrf: string; hooks: Hooks | null } = { csrf: "", hooks: null };

export function setCsrfToken(token: string): void {
    state.csrf = token;
}

export function configureApi(hooks: Hooks): void {
    state.hooks = hooks;
}

export type Query = Record<string, string | number | boolean | null | undefined | readonly string[]>;

/** `?a=1&b=x,y`, leaving out empty values. */
export function queryString(query: Query | undefined): string {
    if (!query) return "";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        if (Array.isArray(v)) {
            if (v.length) params.set(k, v.join(","));
        } else params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : "";
}

export interface RequestOptions {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    query?: Query;
    body?: unknown;
    signal?: AbortSignal;
    /** Don't send people to sign-in on a 401 (the sign-in page itself, the first session check). */
    quiet401?: boolean;
    /** Read the body as text (Markdown, CSV). */
    text?: boolean;
    /** Don't ask the person to confirm it's them on a 401 reauth_required (the confirmation itself, a retry). */
    noReauth?: boolean;
}

async function errorBody(res: Response): Promise<ApiErrorBody> {
    try {
        const body = (await res.json()) as ApiErrorBody;
        if (body && typeof body.error === "string") return body;
    } catch {
        // not JSON: fall through
    }
    return { error: res.status >= 500 ? "The server had a problem. Try again in a moment." : `The server answered ${res.status}.` };
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = {
        Accept: options.text ? "text/markdown, text/plain" : "application/json",
        "X-Client-Id": CLIENT_ID,
    };
    if (method !== "GET") headers["X-CSRF-Token"] = state.csrf;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(path + queryString(options.query), {
        method,
        headers,
        credentials: "same-origin",
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
    });
    if (!res.ok) {
        const body = await errorBody(res);
        // Still signed in, but this step needs a recent sign-in: confirm, then try once more.
        if (res.status === 401 && body.code === "reauth_required") {
            if (!options.noReauth && (await state.hooks?.onReauthRequired?.(body))) return request<T>(path, { ...options, noReauth: true });
            throw new ApiError(res.status, body);
        }
        if (res.status === 401 && !options.quiet401) state.hooks?.onSignedOut();
        if (res.status === 403 && body.code === "password_change_required") state.hooks?.onPasswordChangeRequired();
        throw new ApiError(res.status, body);
    }
    if (options.text) return (await res.text()) as T;
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    try {
        return (text ? JSON.parse(text) : undefined) as T;
    } catch {
        // Something between here and the server (a proxy, a cached page) answered with something else.
        throw new ApiError(res.status, { error: "The server's answer couldn't be read. Try again in a moment." });
    }
}

export const api = {
    get: <T>(path: string, query?: Query, options: Omit<RequestOptions, "method" | "query" | "body"> = {}) =>
        request<T>(path, { ...options, query }),
    post: <T>(path: string, body?: unknown, query?: Query) => request<T>(path, { method: "POST", body: body ?? {}, query }),
    put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body: body ?? {} }),
    patch: <T>(path: string, body: unknown, query?: Query) => request<T>(path, { method: "PATCH", body, query }),
    delete: <T>(path: string, body?: unknown, query?: Query) => request<T>(path, { method: "DELETE", body, query }),
};

const enc = encodeURIComponent;

/** API paths. */
export const paths = {
    me: "/api/v1/me",
    workspaces: "/api/v1/workspaces",
    workspace: (ws: string) => `/api/v1/w/${enc(ws)}`,
    project: (ws: string, project: string) => `/api/v1/w/${enc(ws)}/p/${enc(project)}`,
    instanceUsers: "/api/v1/instance/users",
    instanceInvites: "/api/v1/instance/invites",
    authConfig: "/auth/config",
};

/** The address that starts signing in through the identity provider, coming back to `next` (a path here). */
export function providerSignInUrl(next: string, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams(extra);
    params.set("next", localPath(next) ?? "/");
    return `/auth/login?${params.toString()}`;
}
