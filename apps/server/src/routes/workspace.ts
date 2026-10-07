// Workspace-wide routes. Configuration lives under /settings; activity and the live event stream are
// for everyone with read access.

import { permissionsOf } from "@triagent/shared";
import { z } from "zod";
import { json, type Route, route } from "../http/route.ts";
import type { Access } from "../services/accounts.ts";
import type { LiveEvent } from "../services/events.ts";
import { PROVIDER_IDS } from "../services/settings.ts";
import { PagingQuery, pageOf, RoleSchema, ScopeSchema, W } from "./common.ts";

const HEARTBEAT_MS = 25_000;

export const workspaceRoutes: Route[] = [
    route({
        method: "GET",
        path: W,
        scope: "workspace",
        permission: "read",
        tag: "Workspaces",
        summary: "The workspace, and your role or token scope in it",
        async handler({ access }) {
            const a = access as Access;
            return json({ ...a.workspace, access: a.grant });
        },
    }),
    route({
        method: "GET",
        path: `${W}/activity`,
        scope: "workspace",
        permission: "read",
        tag: "Activity",
        summary: "Recent changes across the workspace's projects, newest first",
        query: PagingQuery,
        async handler({ services, access, query }) {
            const items = await services.store.activity.list({ workspaceId: (access as Access).workspace.id }, pageOf(query));
            const projects = new Map(
                (await services.store.projects.forWorkspace((access as Access).workspace.id)).map((p) => [p.id, p.slug]),
            );
            return json({ items: items.map((r) => ({ ...r, project: r.projectId ? (projects.get(r.projectId) ?? null) : null })) });
        },
    }),
    route({
        method: "GET",
        path: `${W}/events`,
        scope: "workspace",
        permission: "read",
        tag: "Activity",
        summary: "Live updates (Server-Sent Events): a notice for each change in this workspace",
        description:
            "Each `change` event names what changed (kind, project, branch, id); fetch the details yourself. Closed when your session or token stops being valid.",
        produces: "event-stream",
        async handler({ services, access, principal, c }) {
            const a = access as Access;
            const userKey =
                principal?.kind === "token"
                    ? `token:${principal.token.id}`
                    : `user:${principal?.kind === "session" ? principal.user.id : "?"}`;
            const stillValid = async () =>
                principal?.kind === "token"
                    ? services.accounts.tokenStillValid(principal.token.id)
                    : principal?.kind === "session"
                      ? Boolean(await services.accounts.validSession(principal.session, { touch: false }))
                      : false;
            const encoder = new TextEncoder();
            let stop = () => {};
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    const send = (text: string) => controller.enqueue(encoder.encode(text));
                    const unsubscribe = services.events.subscribe({
                        workspaceId: a.workspace.id,
                        userKey,
                        permissions: permissionsOf(a.grant),
                        send: (e: LiveEvent) => send(`id: ${e.seq}\nevent: change\ndata: ${JSON.stringify(e)}\n\n`),
                    });
                    if (!unsubscribe) {
                        send('event: error\ndata: {"error":"Too many live connections. Close some tabs."}\n\n');
                        controller.close();
                        return;
                    }
                    send(`retry: 5000\n\nevent: hello\ndata: ${JSON.stringify({ workspace: a.workspace.slug })}\n\n`);
                    const timer = setInterval(async () => {
                        if (await stillValid()) return send(": ping\n\n");
                        send("event: bye\ndata: {}\n\n");
                        stop();
                        controller.close();
                    }, HEARTBEAT_MS);
                    stop = () => {
                        clearInterval(timer);
                        unsubscribe();
                    };
                    c.req.raw.signal.addEventListener("abort", () => stop());
                },
                cancel() {
                    stop();
                },
            });
            return new Response(stream, {
                headers: {
                    "content-type": "text/event-stream; charset=utf-8",
                    "cache-control": "no-cache, no-transform",
                    "x-accel-buffering": "no",
                },
            });
        },
    }),

    // ---- settings: the workspace -------------------------------------------------------------
    route({
        method: "PATCH",
        path: `${W}/settings/workspace`,
        scope: "workspace",
        permission: "workspace",
        tag: "Settings",
        summary: "Rename the workspace",
        body: z.object({ name: z.string().max(80) }),
        async handler({ services, access, body, actor }) {
            return json(await services.accounts.renameWorkspace(actor, (access as Access).workspace, body.name));
        },
    }),

    // ---- settings: members -----------------------------------------------------------------
    route({
        method: "GET",
        path: `${W}/settings/members`,
        scope: "workspace",
        permission: "read",
        tag: "Settings",
        summary: "Members and their roles",
        async handler({ services, access }) {
            return json({ items: await services.accounts.members((access as Access).workspace) });
        },
    }),
    route({
        method: "POST",
        path: `${W}/settings/members`,
        scope: "workspace",
        permission: "members",
        tag: "Settings",
        summary: "Add an existing account to the workspace",
        body: z.object({ username: z.string().max(64), role: RoleSchema }),
        async handler({ services, access, body, actor }) {
            return json(await services.accounts.addMember(actor, access as Access, body), 201);
        },
    }),
    route({
        method: "PATCH",
        path: `${W}/settings/members/{userId}`,
        scope: "workspace",
        permission: "members",
        tag: "Settings",
        summary: "Change a member's role",
        body: z.object({ role: RoleSchema }),
        async handler({ services, access, params, body, actor }) {
            return json(await services.accounts.setMemberRole(actor, access as Access, params.userId as string, body.role));
        },
    }),
    route({
        method: "DELETE",
        path: `${W}/settings/members/{userId}`,
        scope: "workspace",
        permission: "members",
        tag: "Settings",
        summary: "Remove a member",
        async handler({ services, access, params, actor }) {
            return json(await services.accounts.removeMember(actor, access as Access, params.userId as string));
        },
    }),

    // ---- settings: API tokens ----------------------------------------------------------------
    route({
        method: "GET",
        path: `${W}/settings/tokens`,
        scope: "workspace",
        permission: "tokens",
        tag: "Settings",
        summary: "API tokens (never the tokens themselves)",
        async handler({ services, access }) {
            return json({ items: await services.accounts.listTokens((access as Access).workspace) });
        },
    }),
    route({
        method: "POST",
        path: `${W}/settings/tokens`,
        scope: "workspace",
        permission: "tokens",
        tag: "Settings",
        summary: "Create an API token (shown once)",
        description: "The token acts for `ownerUserId` (default: you), who hears about the reviews it starts.",
        body: z.object({
            name: z.string().max(64),
            scope: ScopeSchema,
            expiresInDays: z.number().int().nullable().optional(),
            ownerUserId: z.string().nullable().optional(),
        }),
        async handler({ services, access, body, actor }) {
            const { ownerUserId, expiresInDays, ...rest } = body;
            return json(
                await services.accounts.createToken(actor, (access as Access).workspace, {
                    ...rest,
                    ...(expiresInDays !== undefined ? { expiresInDays } : {}),
                    ...(ownerUserId !== undefined ? { ownerUserId } : {}),
                }),
                201,
            );
        },
    }),
    route({
        method: "PATCH",
        path: `${W}/settings/tokens/{tokenId}`,
        scope: "workspace",
        permission: "tokens",
        tag: "Settings",
        summary: "Change who a token acts for",
        body: z.object({ ownerUserId: z.string().nullable() }),
        async handler({ services, access, params, body, actor }) {
            return json(
                await services.accounts.setTokenOwner(actor, (access as Access).workspace, params.tokenId as string, body.ownerUserId),
            );
        },
    }),
    route({
        method: "DELETE",
        path: `${W}/settings/tokens/{tokenId}`,
        scope: "workspace",
        permission: "tokens",
        tag: "Settings",
        summary: "Revoke an API token",
        async handler({ services, access, params, actor }) {
            return json(await services.accounts.revokeToken(actor, (access as Access).workspace, params.tokenId as string));
        },
    }),

    // ---- settings: review model and keys ---------------------------------------------------------
    route({
        method: "GET",
        path: `${W}/settings/review-model`,
        scope: "workspace",
        permission: "read",
        tag: "Settings",
        summary: "The provider and model reviews use, and which providers have a key (never the keys)",
        async handler({ services, access }) {
            return json(await services.settings.reviewModel((access as Access).workspace));
        },
    }),
    route({
        method: "PATCH",
        path: `${W}/settings/review-model`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Choose the provider and model reviews use",
        body: z.object({ provider: z.enum(PROVIDER_IDS as [string, ...string[]]).optional(), model: z.string().max(150).optional() }),
        async handler({ services, access, body, actor }) {
            await services.settings.setReviewModel(actor, (access as Access).workspace, body);
            return json(await services.settings.reviewModel((access as Access).workspace));
        },
    }),
    route({
        method: "PUT",
        path: `${W}/settings/review-model/keys/{provider}`,
        scope: "workspace",
        permission: "secrets",
        tag: "Settings",
        summary: "Set a provider's API key (stored encrypted, never shown again)",
        body: z.object({ key: z.string().max(500) }),
        async handler({ services, access, params, body, actor }) {
            return json(await services.settings.setModelKey(actor, (access as Access).workspace, params.provider as string, body.key));
        },
    }),
    route({
        method: "DELETE",
        path: `${W}/settings/review-model/keys/{provider}`,
        scope: "workspace",
        permission: "secrets",
        tag: "Settings",
        summary: "Forget a provider's API key",
        async handler({ services, access, params, actor }) {
            return json(await services.settings.setModelKey(actor, (access as Access).workspace, params.provider as string, null));
        },
    }),

    // ---- settings: audit log ---------------------------------------------------------------
    route({
        method: "GET",
        path: `${W}/settings/audit`,
        scope: "workspace",
        permission: "members",
        tag: "Settings",
        summary: "Administrative changes: members, tokens, settings and secrets (names only), newest first",
        query: PagingQuery,
        async handler({ services, access, query }) {
            return json({ items: await services.store.audit.list({ workspaceId: (access as Access).workspace.id }, pageOf(query)) });
        },
    }),
];
