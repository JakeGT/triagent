// Health, the API description, the MCP endpoint and GitHub webhooks.

import { z } from "zod";
import { ApiError, forbidden } from "../errors.ts";
import { openapi } from "../http/openapi.ts";
import { json, type Route, route } from "../http/route.ts";
import { createMcp } from "../mcp/server.ts";
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

export function platformRoutes(services: Services, all: () => Route[]): Route[] {
    const mcp = createMcp(services);
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
                } catch {
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
                return json(openapi(all(), services.config.publicOrigin));
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
