// The OpenAPI document, generated from the declared routes: paths, permissions, query and body schemas.

import { PERMISSION_INFO } from "@triagent/shared";
import { z } from "zod";
import { needsBrowser, type Route } from "./route.ts";

function schemaOf(s: z.ZodType): Record<string, unknown> {
    const { $schema: _s, ...rest } = z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    return rest;
}

function who(r: Route): string {
    if (r.scope === "public") return "No sign-in: the request carries its own credential.";
    if (r.scope === "instance") return "Instance administrators, signed in through the browser.";
    if (r.scope === "user") return needsBrowser(r) ? "Anyone signed in through the browser." : "Anyone signed in, or any API token.";
    const p = r.permission ? `Needs **${r.permission}** (${PERMISSION_INFO[r.permission]}).` : "";
    return needsBrowser(r) ? `${p} Browser sessions only: no API token can do this.` : p;
}

const CONTENT: Record<NonNullable<Route["produces"]>, string> = {
    json: "application/json",
    markdown: "text/markdown",
    csv: "text/csv",
    "event-stream": "text/event-stream",
};

export function openapi(routes: Route[], origin: string) {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const r of routes) {
        const parameters: unknown[] = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
            name: m[1],
            in: "path",
            required: true,
            schema: { type: "string" },
        }));
        if (r.query && r.query instanceof z.ZodObject) {
            const shape = (r.query as z.ZodObject).shape as Record<string, z.ZodType>;
            for (const [name, s] of Object.entries(shape)) {
                const schema = schemaOf(s);
                parameters.push({
                    name,
                    in: "query",
                    required: !s.safeParse(undefined).success,
                    ...(schema.description ? { description: schema.description } : {}),
                    schema,
                });
            }
        }
        const op: Record<string, unknown> = {
            tags: [r.tag],
            summary: r.summary,
            description: [r.description, who(r)].filter(Boolean).join("\n\n"),
            ...(r.permission ? { "x-permission": r.permission } : {}),
            ...(parameters.length ? { parameters } : {}),
            responses: {
                200: { description: "OK", content: { [CONTENT[r.produces ?? "json"]]: {} } },
                default: { description: 'Error: `{ "error": "…" }`' },
            },
            security: r.scope === "public" ? [] : needsBrowser(r) ? [{ session: [] }] : [{ session: [] }, { bearer: [] }],
        };
        if (r.body) op.requestBody = { required: true, content: { "application/json": { schema: schemaOf(r.body) } } };
        if (r.rawBody) op.requestBody = { required: true, content: { "application/json": { schema: { description: "The raw file" } } } };
        paths[r.path] ??= {};
        (paths[r.path] as Record<string, unknown>)[r.method.toLowerCase()] = op;
    }
    return {
        openapi: "3.1.0",
        info: {
            title: "Triagent API",
            version: "1",
            description:
                "Open Code Review findings, triaged by people and agents. Everything lives in a workspace (`/api/v1/w/{workspace}`); an API token belongs to one workspace. Browser writes need the `X-CSRF-Token` from `GET /api/v1/me`.",
        },
        servers: [{ url: origin }],
        components: {
            securitySchemes: {
                bearer: { type: "http", scheme: "bearer", description: "An API token (tri_…), created in workspace settings." },
                session: { type: "apiKey", in: "cookie", name: "__Host-triagent_sid" },
            },
        },
        paths,
    };
}
