// Turns declared routes into Hono handlers, applying the same checks to every one.

import { getConnInfo } from "@hono/node-server/conninfo";
import { BROWSER_ONLY, permissionsOf, SCOPE_INFO } from "@triagent/shared";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { ZodError } from "zod";
import { ApiError, forbidden, notFound } from "../errors.ts";
import { safeEqual } from "../security.ts";
import type { Access, Principal } from "../services/accounts.ts";
import type { Actor } from "../services/core.ts";
import type { Services } from "../services/index.ts";
import { type HandlerResult, needsBrowser, type RequestContext, type Route } from "./route.ts";

export const DEFAULT_BODY_LIMIT = 256 * 1024;

export function cookieName(services: Services): string {
    return services.config.cookieSecure ? "__Host-triagent_sid" : "triagent_sid";
}

/** The client's address: the socket's, or, behind N trusted proxies, the Nth address from the right of X-Forwarded-For. */
export function clientIp(c: Context, proxyHops: number): string {
    const socket = (() => {
        try {
            return getConnInfo(c).remote.address ?? "unknown";
        } catch {
            return "unknown";
        }
    })();
    if (!proxyHops) return socket;
    const fwd = (c.req.header("x-forwarded-for") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    // Each proxy appends what it saw, so anything further left came from the client and can't be trusted.
    return fwd.length >= proxyHops ? (fwd[fwd.length - proxyHops] as string) : socket;
}

/** Read the body, refusing anything over `limit` bytes without buffering it all first. */
export async function readBody(c: Context, limit: number): Promise<Buffer> {
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > limit) throw tooLarge(limit);
    const stream = c.req.raw.body;
    if (!stream) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > limit) throw tooLarge(limit);
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

const tooLarge = (limit: number) =>
    new ApiError(413, `The request body is larger than ${limit >= 1 << 20 ? `${limit / (1 << 20)} MB` : `${limit / 1024} KB`}.`);

export function parseJson(raw: Buffer, c: Context): unknown {
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) throw new ApiError(415, "Send the body as application/json.");
    if (!raw.length) return {};
    try {
        return JSON.parse(raw.toString("utf8"));
    } catch {
        throw new ApiError(400, "The request body isn't valid JSON.");
    }
}

/** A cookie-authenticated write must come from our own pages: same Origin, and the session's CSRF token. */
function checkCsrf(c: Context, services: Services, principal: Principal): void {
    if (principal.kind !== "session") return;
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    const sameOrigin = origin ? origin === services.config.publicOrigin : !site || site === "same-origin" || site === "none";
    if (!sameOrigin || !safeEqual(c.req.header("x-csrf-token") ?? "", principal.session.csrf)) {
        throw new ApiError(
            403,
            "Request blocked: missing or invalid CSRF token, or another site's origin. Reload the page and try again.",
            { code: "csrf" },
        );
    }
}

export async function authenticate(c: Context, services: Services): Promise<Principal | null | "invalid"> {
    const header = c.req.header("authorization");
    if (header) {
        const m = /^Bearer\s+(\S+)$/i.exec(header);
        return (m && (await services.accounts.token(m[1] as string))) || "invalid";
    }
    return services.accounts.session(getCookie(c, cookieName(services)));
}

export function actorOf(principal: Principal | null, via: Actor["via"], ip: string, clientId?: string): Actor {
    if (!principal) return { name: "anonymous", userId: null, via, ip };
    if (principal.kind === "token")
        return { name: principal.token.name, userId: principal.token.ownerUserId, via: via === "web" ? "token" : via, ip };
    return { name: principal.user.displayName, userId: principal.user.id, via, ip, ...(clientId ? { clientId } : {}) };
}

function refuse(principal: Principal, access: Access, permission: string): ApiError {
    if (principal.kind === "token") {
        const scope = access.grant.kind === "scope" ? access.grant.scope : "read";
        return forbidden(
            `This token has "${scope}" access (${SCOPE_INFO[scope]}), which doesn't include ${permission}. Ask an admin for a token with more access.`,
        );
    }
    return forbidden(`Your role in this workspace doesn't allow ${permission}.`);
}

export function errorResponse(c: Context, err: unknown): Response {
    if (err instanceof ApiError) {
        return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...err.details }, err.status as 400);
    }
    if (err instanceof ZodError) {
        return c.json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
    }
    console.error(err);
    return c.json({ error: "Internal error. Check the server log." }, 500);
}

function toResponse(c: Context, result: HandlerResult): Response {
    if (result instanceof Response) return result;
    if ("markdown" in result)
        return c.body(result.markdown, (result.status ?? 200) as 200, { "content-type": "text/markdown; charset=utf-8" });
    return c.json(result.json as object, (result.status ?? 200) as 200);
}

export function mount(app: Hono, services: Services, routes: Route[]): void {
    for (const r of routes) {
        const path = r.path.replace(/\{(\w+)\}/g, ":$1");
        app.on(r.method, path, async (c) => {
            const ip = clientIp(c, services.config.proxyHops);
            let principal: Principal | null = null;
            if (r.scope !== "public") {
                const auth = await authenticate(c, services);
                if (auth === "invalid") throw new ApiError(401, "Invalid or expired API token.");
                if (!auth) throw new ApiError(401, "Sign in, or send Authorization: Bearer <token>.");
                principal = auth;
                if (principal.kind === "token" && needsBrowser(r)) {
                    throw forbidden(
                        r.scope === "instance"
                            ? "Only an instance administrator, signed in through the browser, can do that."
                            : "API tokens can't do that, whatever their scope: it needs a person signed in through the browser.",
                    );
                }
                if (r.method !== "GET") checkCsrf(c, services, principal);
                if (principal.kind === "session" && principal.user.mustChangePassword && !r.duringPasswordChange) {
                    throw new ApiError(403, "Set a new password before continuing.", { code: "password_change_required" });
                }
                if (r.scope === "instance" && !(principal.kind === "session" && principal.user.isInstanceAdmin))
                    throw forbidden("Only instance administrators can do that.");
            }

            const params = c.req.param() as Record<string, string>;
            let access: Access | null = null;
            let project = null;
            if (r.scope === "workspace" || r.scope === "project") {
                if (!principal || !r.permission) throw new Error(`Route ${r.method} ${r.path} needs a permission.`);
                access = await services.accounts.access(principal, params.workspace ?? "");
                // Outsiders get the same answer whether or not the workspace exists.
                if (!access) throw notFound(`No workspace "${(params.workspace ?? "").slice(0, 60)}" that you can see.`);
                if (!permissionsOf(access.grant).has(r.permission)) throw refuse(principal, access, r.permission);
                if (r.scope === "project") project = await services.projects.get(services.store, access.workspace, params.project ?? "");
            }

            const clientId = /^[\w-]{8,64}$/.test(c.req.header("x-client-id") ?? "") ? c.req.header("x-client-id") : undefined;
            const actor = actorOf(principal, principal?.kind === "token" ? "token" : "web", ip, clientId);
            let raw: Buffer | null = null;
            let body: unknown;
            if (r.method !== "GET" && r.method !== "DELETE" ? true : Boolean(r.body)) {
                raw = await readBody(c, r.bodyLimit ?? DEFAULT_BODY_LIMIT);
                if (!r.rawBody) body = r.body ? r.body.parse(parseJson(raw, c)) : undefined;
            }
            const query = r.query ? r.query.parse(Object.fromEntries(new URL(c.req.url).searchParams)) : undefined;
            const grant = access?.grant;
            const ctx: RequestContext<undefined, undefined> = {
                c,
                services,
                principal,
                actor,
                access,
                project,
                params,
                query: query as undefined,
                body: body as undefined,
                raw: r.rawBody ? raw : null,
                ip,
                can: (p) => Boolean(grant && permissionsOf(grant).has(p) && !(principal?.kind === "token" && BROWSER_ONLY.has(p))),
            };
            return toResponse(c, await r.handler(ctx as never));
        });
    }
}
