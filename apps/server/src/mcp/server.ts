// The MCP endpoint: stateless Streamable HTTP (one JSON-RPC message or batch per POST). Agents connect
// with an API token, which belongs to one workspace, so every tool works inside that workspace.

import { BROWSER_ONLY, permissionsOf } from "@triagent/shared";
import { log } from "@triagent/shared/log";
import { ZodError } from "zod";
import { ApiError } from "../errors.ts";
import type { Access } from "../services/accounts.ts";
import type { Actor } from "../services/core.ts";
import type { Services } from "../services/index.ts";
import { TOOLS, type Tool, type ToolContext, toolSchema } from "./tools.ts";

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** The most JSON-RPC messages one POST may carry. */
export const MAX_BATCH = 50;

const INSTRUCTIONS = `Triagent holds Open Code Review findings for the projects in one workspace (your token's).

- Call list_projects and pass "project" to the other tools, matching the repository you're working in by its git remote. Most tools also take "branch" (default: the project's default branch).
- To work through findings: claim_next_issue gives you the most urgent open, unassigned issue and marks it in progress for you, so several agents never pick the same one. When it's fixed, update_issue with status "resolved" and a note saying what you changed; if you stop, release_issue.
- Pass "rev" from get_issue to update_issue: if someone changed the issue meanwhile, nothing is saved and you get the latest version.
- Before writing or changing code in a project, call list_common_issues (with "path" for the files you'll touch): the mistakes reviews keep finding there, each with how to avoid it. An issue under one says so.
- Issues flagged needsDiscussion need a person's decision first; don't fix them on your own.
- To upload a report, create_upload_link and run the curl command it returns, so the report never passes through this conversation.`;

interface RpcMessage {
    jsonrpc?: unknown;
    id?: string | number | null;
    method?: unknown;
    params?: Record<string, unknown>;
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function createMcp(services: Services) {
    function usable(access: Access): Tool[] {
        const allowed = permissionsOf(access.grant);
        return TOOLS.filter((t) => allowed.has(t.permission) && !BROWSER_ONLY.has(t.permission));
    }

    async function call(ctx: ToolContext, params: Record<string, unknown> | undefined) {
        const t = TOOLS.find((x) => x.name === params?.name);
        if (!t) return { error: [-32602, `Unknown tool: ${String(params?.name)}`] as const };
        const fail = (text: string) => ({ result: { content: [{ type: "text", text }], isError: true } });
        if (!ctx.can(t.permission))
            return fail(`This token can't use ${t.name}: it needs "${t.permission}" access. Ask an admin for a token with more access.`);
        const raw = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
        try {
            const args = t.input.parse(raw) as Record<string, unknown>;
            const out = await t.run(ctx, args);
            return {
                result: {
                    content: [{ type: "text", text: out.text }],
                    isError: Boolean(out.isError),
                    ...(out.data !== undefined ? { structuredContent: out.data } : {}),
                },
            };
        } catch (err) {
            if (err instanceof ZodError)
                return fail(`Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")}`);
            if (err instanceof ApiError) {
                if (err.status >= 500) log.error("An MCP tool failed", { tool: t.name, err });
                const current = err.details?.current;
                return {
                    result: {
                        content: [{ type: "text", text: err.message }],
                        isError: true,
                        ...(current ? { structuredContent: { conflict: true, current } } : {}),
                    },
                };
            }
            log.error("An MCP tool failed", { tool: t.name, err });
            return { error: [-32603, "Internal error"] as const };
        }
    }

    async function dispatch(msg: RpcMessage, ctx: ToolContext) {
        if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid Request");
        const notification = msg.id === undefined;
        const reply = (result: unknown) => (notification ? null : { jsonrpc: "2.0", id: msg.id, result });
        switch (msg.method) {
            case "initialize": {
                const requested = msg.params?.protocolVersion;
                return reply({
                    protocolVersion:
                        typeof requested === "string" && SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: "triagent", title: "Triagent", version: "0.1.0" },
                    instructions: INSTRUCTIONS,
                });
            }
            case "ping":
                return reply({});
            case "tools/list":
                return reply({
                    tools: usable(ctx.access).map((t) => ({
                        name: t.name,
                        title: t.title,
                        description: t.description,
                        inputSchema: toolSchema(t),
                        annotations: {
                            title: t.title,
                            readOnlyHint: Boolean(t.readOnly),
                            destructiveHint: Boolean(t.destructive),
                            openWorldHint: false,
                        },
                    })),
                });
            case "tools/call": {
                const r = await call(ctx, msg.params);
                if ("error" in r && r.error) return notification ? null : rpcError(msg.id, r.error[0], r.error[1]);
                return reply((r as { result: unknown }).result);
            }
            default:
                // A notification never gets a reply, not even an error.
                if (notification || msg.method.startsWith("notifications/")) return null;
                return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
        }
    }

    /** Handle one parsed body. Returns [status, payload or null for 202]. */
    return async function handle(body: unknown, access: Access, actor: Actor): Promise<[number, unknown]> {
        const grant = access.grant;
        const ctx: ToolContext = {
            services,
            access,
            actor: { ...actor, via: "mcp" },
            can: (p) => permissionsOf(grant).has(p) && !BROWSER_ONLY.has(p),
        };
        if (Array.isArray(body)) {
            if (!body.length) return [400, rpcError(null, -32600, "Empty batch")];
            if (body.length > MAX_BATCH) return [400, rpcError(null, -32600, `Too many messages in one batch: send at most ${MAX_BATCH}.`)];
            // One after another, in the order sent, so a batch can't fan out into many tool calls at once.
            const out = [];
            for (const m of body) {
                const reply = await dispatch(m as RpcMessage, ctx);
                if (reply) out.push(reply);
            }
            return out.length ? [200, out] : [202, null];
        }
        const out = await dispatch(body as RpcMessage, ctx);
        return out ? [200, out] : [202, null];
    };
}
