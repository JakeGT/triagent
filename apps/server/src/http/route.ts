// Every API route is declared here with what it needs: its scope (whose data), the permission it
// requires, and schemas for its query and body. One wrapper then applies authentication, CSRF checks,
// workspace isolation, permissions and validation the same way everywhere, and the same declarations
// produce the OpenAPI document and the "every route has a permission" test.

import { BROWSER_ONLY, type Grant, type Permission, permissionsOf } from "@triagent/shared";
import type { Context } from "hono";
import type { z } from "zod";
import type { Access, Principal } from "../services/accounts.ts";
import type { Actor } from "../services/core.ts";
import type { Services } from "../services/index.ts";
import type { Project } from "../store/types.ts";

/**
 * public: anyone (the route checks its own credential, e.g. a webhook signature).
 * user: any signed-in person or token, with no workspace.
 * workspace / project: a workspace in the path (`{workspace}`), and a project in it (`{project}`).
 * instance: instance administrators, in the browser.
 */
export type RouteScope = "public" | "user" | "workspace" | "project" | "instance";
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type Schema = z.ZodType | undefined;
type Infer<S extends Schema> = S extends z.ZodType ? z.infer<S> : undefined;

export interface RequestContext<Q extends Schema, B extends Schema> {
    c: Context;
    services: Services;
    principal: Principal | null;
    actor: Actor;
    access: Access | null;
    project: Project | null;
    params: Record<string, string>;
    query: Infer<Q>;
    body: Infer<B>;
    /** The raw body, for routes declared with `rawBody`. */
    raw: Buffer | null;
    ip: string;
    can(permission: Permission): boolean;
}

/** What a handler returns: a JSON body (status 200 unless given), or a ready-made Response. */
export type HandlerResult = Response | { status?: number; json: unknown } | { status?: number; markdown: string };

export interface Route<Q extends Schema = Schema, B extends Schema = Schema> {
    method: Method;
    /** OpenAPI-style path: /api/v1/w/{workspace}/p/{project}/issues/{id} */
    path: string;
    scope: RouteScope;
    /** Required for workspace and project routes. */
    permission?: Permission;
    /** Only a person signed in through the browser (implied for browser-only permissions and instance routes). */
    browserOnly?: boolean;
    /** Allowed while the account must still replace a temporary password. */
    duringPasswordChange?: boolean;
    tag: string;
    summary: string;
    description?: string;
    query?: Q;
    body?: B;
    /** Largest accepted body, in bytes. Default 256 KB. */
    bodyLimit?: number;
    /** The handler gets the body's bytes in `raw` instead (webhooks, upload links). */
    rawBody?: boolean;
    /** What the success response is, for the API document. */
    produces?: "json" | "markdown" | "csv" | "event-stream";
    handler(ctx: RequestContext<Q, B>): Promise<HandlerResult>;
}

/** Declare a route, with its handler typed from its schemas. */
export function route<Q extends Schema = undefined, B extends Schema = undefined>(r: Route<Q, B>): Route {
    return r as unknown as Route;
}

export function needsBrowser(r: Route): boolean {
    return Boolean(r.browserOnly) || r.scope === "instance" || (r.permission !== undefined && BROWSER_ONLY.has(r.permission));
}

export function grantAllows(grant: Grant, permission: Permission): boolean {
    return permissionsOf(grant).has(permission);
}

export const json = (body: unknown, status = 200) => ({ status, json: body });
export const markdown = (text: string) => ({ markdown: text });
