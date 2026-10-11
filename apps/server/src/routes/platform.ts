// Health, the API description, the MCP endpoint and GitHub webhooks.

import { log } from "@triagent/shared/log";
import { z } from "zod";
import { ApiError, forbidden, notFound } from "../errors.ts";
import { openapi } from "../http/openapi.ts";
import { json, type Route, route } from "../http/route.ts";
import { createMcp } from "../mcp/server.ts";
import { RequestLimiter } from "../security.ts";
import { MAX_ENVELOPE_BYTES } from "../services/browser-reports.ts";
import type { Services } from "../services/index.ts";

/** A plain-text map of the API for agents. Public: it holds no data. */
export function llmsTxt(origin: string): string {
    return `# Triagent

> Open Code Review findings for your projects, triaged by people and AI agents together.

Everything lives in a workspace. An API token belongs to one workspace; send it as \`Authorization: Bearer tri_…\`.

## For agents

- MCP (Streamable HTTP, stateless): POST ${origin}/mcp with your token. Start with list_projects, then claim_next_issue / get_issue / update_issue.
- REST: ${origin}/api/v1/openapi.json
- Markdown: ${origin}/api/v1/w/{workspace}/p/{project}/issues.md, …/overview.md, …/issues/{id}/markdown

## Working safely alongside others

- claim_next_issue (POST …/issues/claim) hands each caller a different issue.
- Send the issue's \`rev\` with a change: a stale one is refused (409) with the current version.
- Issues flagged needsDiscussion wait for a person.
`;
}

let unhealthyAt = 0;
/** A page that keeps failing reports it a few times, not without end. */
const reportLimiter = new RequestLimiter(30);

export function platformRoutes(services: Services, all: () => Route[]): Route[] {
    const mcp = createMcp(services);
    let document: ReturnType<typeof openapi> | null = null;
    return [
        route({
            method: "GET",
            path: "/healthz",
            scope: "public",
            tag: "Platform",
            summary: "Health check: 200 when the server can reach its database",
            async handler() {
                try {
                    await services.store.ping();
                    return json({ status: "ok" });
                } catch (err) {
                    // Asked every few seconds: said once a minute while it lasts.
                    if (Date.now() - unhealthyAt > 60_000) {
                        unhealthyAt = Date.now();
                        log.error("The health check failed: the database can't be reached", { err });
                    }
                    return json({ status: "failing", checks: { database: "unreachable" } }, 503);
                }
            },
        }),
        route({
            method: "GET",
            path: "/api/v1/openapi.json",
            scope: "public",
            tag: "Platform",
            summary: "This API, as OpenAPI 3.1",
            async handler() {
                // The routes are fixed once the server is up, so the document is built once.
                document ??= openapi(all(), services.config.publicOrigin);
                return json(document);
            },
        }),
        route({
            method: "GET",
            path: "/llms.txt",
            scope: "public",
            tag: "Platform",
            summary: "A plain-text guide for agents",
            async handler({ c }) {
                return c.text(llmsTxt(services.config.publicOrigin));
            },
        }),
        route({
            method: "POST",
            path: "/api/v1/telemetry",
            scope: "public",
            tag: "Platform",
            summary: "The web app's error reports, passed on to Sentry (when SENTRY_DSN is set)",
            description:
                "For this site's own pages only. Takes a Sentry envelope for the project the instance was set up with, and nothing else.",
            rawBody: true,
            bodyLimit: MAX_ENVELOPE_BYTES,
            async handler({ c, services: s, readRaw, ip }) {
                const reports = s.browserReports;
                if (!reports) throw notFound(`Nothing at ${c.req.method} ${c.req.path}.`);
                // From our own pages: a browser says where a POST comes from, and another site's isn't taken.
                const origin = c.req.header("origin");
                const site = c.req.header("sec-fetch-site");
                if (origin ? origin !== s.config.publicOrigin : site !== undefined && site !== "same-origin")
                    throw forbidden("Reports are only taken from this site's own pages.");
                if (!reportLimiter.allow(ip)) {
                    c.header("Retry-After", "60");
                    throw new ApiError(429, "Too many reports. Try again in a minute.");
                }
                const { status, retryAfter } = await reports.forward(await readRaw());
                if (retryAfter) c.header("Retry-After", retryAfter);
                return json({}, status);
            },
        }),
        route({
            method: "POST",
            path: "/mcp",
            scope: "user",
            tag: "Agents",
            summary: "Model Context Protocol (stateless Streamable HTTP), with an API token",
            description: "Tools are listed for what the token's scope allows.",
            body: z.unknown(),
            async handler({ c, services: s, principal, body, actor }) {
                // Blocks DNS rebinding: a browser page elsewhere can't drive the MCP endpoint.
                const origin = c.req.header("origin");
                if (origin && origin !== s.config.publicOrigin) throw forbidden("Origin not allowed.");
                if (principal?.kind !== "token") throw forbidden("Connect to MCP with an API token: Authorization: Bearer tri_…");
                const workspace = await s.store.workspaces.get(principal.token.workspaceId);
                if (!workspace) throw new ApiError(401, "This token's workspace no longer exists.");
                const [status, payload] = await mcp(
                    body,
                    { workspace, grant: { kind: "token", scope: principal.token.scope, role: principal.role } },
                    actor,
                );
                if (status === 202) return c.body(null, 202);
                return json(payload, status);
            },
        }),
        route({
            method: "POST",
            path: "/api/v1/github/webhook/{webhookId}",
            scope: "public",
            tag: "GitHub",
            summary: "GitHub webhook deliveries (verified by their X-Hub-Signature-256)",
            rawBody: true,
            bodyLimit: 5 * 1024 * 1024,
            async handler({ c, services: s, params, readRaw }) {
                const out = await s.webhooks.deliver(
                    params.webhookId as string,
                    readRaw,
                    c.req.header("x-hub-signature-256"),
                    c.req.header("x-github-event"),
                    c.req.header("x-github-delivery")?.slice(0, 80),
                );
                return json(out);
            },
        }),
    ];
}
