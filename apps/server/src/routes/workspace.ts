// Workspace-wide routes. Configuration lives under /settings; activity and the live event stream are
// for everyone with read access.

import { permissionsOf } from "@triagent/shared";
import { z } from "zod";
import { notFound } from "../errors.ts";
import { json, type Route, route } from "../http/route.ts";
import type { Access } from "../services/accounts.ts";
import type { LiveEvent } from "../services/events.ts";
import { MAX_FAVOURITE_NAME, MAX_FAVOURITES } from "../services/model-setup.ts";
import { PROVIDER_IDS } from "../services/providers.ts";
import { PagingQuery, pageOf, RoleSchema, ScopeSchema, W } from "./common.ts";
import { guardKeyDestination, ModelChoiceBody, ProviderSettingsBody } from "./instance-models.ts";

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
            const granted = [...permissionsOf(a.grant)].sort().join(",");
            // Still signed in, still in this workspace, with the same access as when the stream opened.
            const stillValid = async () => {
                const current =
                    principal?.kind === "token"
                        ? await services.accounts.tokenNow(principal.token.id)
                        : principal?.kind === "session"
                          ? await services.accounts.validSession(principal.session, { touch: false })
                          : null;
                const now = current && (await services.accounts.access(current, a.workspace.slug));
                return Boolean(now) && [...permissionsOf((now as Access).grant)].sort().join(",") === granted;
            };
            const encoder = new TextEncoder();
            let stop = () => {};
            let closed = false;
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    // The client can go away at any moment, leaving the stream closed or errored under us.
                    const send = (text: string) => {
                        if (closed) return;
                        try {
                            controller.enqueue(encoder.encode(text));
                        } catch {
                            stop();
                            closed = true;
                        }
                    };
                    const end = () => {
                        if (closed) return;
                        send("event: bye\ndata: {}\n\n");
                        stop();
                        if (closed) return;
                        closed = true;
                        try {
                            controller.close();
                        } catch {
                            // already closed
                        }
                    };
                    const unsubscribe = services.events.subscribe({
                        workspaceId: a.workspace.id,
                        userKey,
                        permissions: permissionsOf(a.grant),
                        send: (e: LiveEvent) => send(`id: ${e.seq}\nevent: change\ndata: ${JSON.stringify(e)}\n\n`),
                        close: end,
                    });
                    if (!unsubscribe) {
                        send('event: error\ndata: {"error":"Too many live connections. Close some tabs."}\n\n');
                        closed = true;
                        controller.close();
                        return;
                    }
                    send(`retry: 5000\n\nevent: hello\ndata: ${JSON.stringify({ workspace: a.workspace.slug })}\n\n`);
                    // If access can't be checked (the database is away), close: the client reconnects and is checked afresh.
                    const timer = setInterval(() => {
                        stillValid().then(
                            (ok) => (ok ? send(": ping\n\n") : end()),
                            () => end(),
                        );
                    }, HEARTBEAT_MS);
                    stop = () => {
                        clearInterval(timer);
                        unsubscribe();
                    };
                    c.req.raw.signal.addEventListener("abort", () => {
                        stop();
                        closed = true;
                    });
                },
                cancel() {
                    stop();
                    closed = true;
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
        async handler({ services, access, can }) {
            const items = await services.accounts.members((access as Access).workspace);
            // Email addresses are for the people who manage members.
            return json({ items: can("members") ? items : items.map((m) => ({ ...m, user: { ...m.user, email: null } })) });
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

    // ---- settings: models (providers, their keys, and the favourites) ---------------------------------
    route({
        method: "GET",
        path: `${W}/settings/review-model`,
        scope: "workspace",
        permission: "read",
        tag: "Settings",
        summary: "The default model reviews use, the favourite models, and which providers have a key (never the keys)",
        async handler({ services, access, can }) {
            const model = await services.settings.reviewModel((access as Access).workspace);
            if (can("configure")) return json(model);
            // Without configure access: whether each key is set, not its hint or who set it.
            return json({
                ...model,
                providers: model.providers.map((p) => ({
                    ...p,
                    key: { name: p.key.name, set: p.key.set, hint: null, setBy: null, setAt: null },
                    accessKeyId: p.accessKeyId && {
                        name: p.accessKeyId.name,
                        set: p.accessKeyId.set,
                        hint: null,
                        setBy: null,
                        setAt: null,
                    },
                })),
            });
        },
    }),
    route({
        method: "PATCH",
        path: `${W}/settings/review-model`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Choose the provider and model reviews use by default, and that provider's protocol, endpoint URL or AWS region",
        description: "The default favourite becomes this model; other favourites are left as they are.",
        body: ModelChoiceBody,
        async handler({ services, access, body, actor, principal, can }) {
            guardKeyDestination({ services, principal, can }, body, await services.settings.reviewModel((access as Access).workspace));
            await services.settings.setReviewModel(actor, (access as Access).workspace, body);
            return json(await services.settings.reviewModel((access as Access).workspace));
        },
    }),
    route({
        method: "PATCH",
        path: `${W}/settings/review-model/providers/{provider}`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Change one provider's protocol, endpoint URL or AWS region, whichever model is the default",
        body: ProviderSettingsBody,
        async handler({ services, access, params, body, actor, principal, can }) {
            const ws = (access as Access).workspace;
            const provider = params.provider as string;
            guardKeyDestination({ services, principal, can }, { ...body, provider }, await services.settings.reviewModel(ws));
            await services.settings.setProviderSettings(actor, ws, provider, body);
            return json(await services.settings.reviewModel(ws));
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
    route({
        method: "PUT",
        path: `${W}/settings/review-model/keys/{provider}/access-key-id`,
        scope: "workspace",
        permission: "secrets",
        tag: "Settings",
        summary: "Set a provider's AWS access key ID (Amazon Bedrock; stored encrypted, never shown again)",
        body: z.object({ key: z.string().max(500) }),
        async handler({ services, access, params, body, actor }) {
            const ws = (access as Access).workspace;
            return json(await services.settings.setModelKey(actor, ws, params.provider as string, body.key, "accessKeyId"));
        },
    }),
    route({
        method: "DELETE",
        path: `${W}/settings/review-model/keys/{provider}/access-key-id`,
        scope: "workspace",
        permission: "secrets",
        tag: "Settings",
        summary: "Forget a provider's AWS access key ID",
        async handler({ services, access, params, actor }) {
            const ws = (access as Access).workspace;
            return json(await services.settings.setModelKey(actor, ws, params.provider as string, null, "accessKeyId"));
        },
    }),
    route({
        method: "GET",
        path: `${W}/settings/review-model/providers/{provider}/models`,
        scope: "workspace",
        permission: "read",
        tag: "Settings",
        summary: "A provider's models, fetched by the server with the workspace's key (never returned), plus suggestions",
        async handler({ services, access, params }) {
            const view = await services.modelLists.list(
                services.store,
                { kind: "workspace", workspace: (access as Access).workspace },
                params.provider as string,
            );
            if (!view) throw notFound("No such provider.");
            return json(view);
        },
    }),

    route({
        method: "GET",
        path: `${W}/settings/models/favourites`,
        scope: "workspace",
        permission: "read",
        tag: "Settings",
        summary: "The favourite models, in order, each ready or saying what it still needs, and which is the default",
        async handler({ services, access }) {
            return json(await services.settings.favourites((access as Access).workspace));
        },
    }),
    route({
        method: "POST",
        path: `${W}/settings/models/favourites`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Add a favourite model: a provider's model, with a nickname if you like",
        description: `Up to ${MAX_FAVOURITES}. The first is the default; later ones only with \`makeDefault\`.`,
        body: z.object({
            provider: z.enum(PROVIDER_IDS as [string, ...string[]]),
            model: z.string().max(150),
            name: z.string().max(MAX_FAVOURITE_NAME).nullable().optional(),
            makeDefault: z.boolean().optional(),
        }),
        async handler({ services, access, body, actor }) {
            const { name, makeDefault, ...rest } = body;
            return json(
                await services.settings.addFavourite(actor, (access as Access).workspace, {
                    ...rest,
                    ...(name !== undefined ? { name } : {}),
                    ...(makeDefault !== undefined ? { makeDefault } : {}),
                }),
                201,
            );
        },
    }),
    route({
        method: "PUT",
        path: `${W}/settings/models/favourites/order`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Put the favourite models in a new order (every favourite's id, once)",
        body: z.object({ ids: z.array(z.string().max(64)).max(MAX_FAVOURITES) }),
        async handler({ services, access, body, actor }) {
            return json(await services.settings.reorderFavourites(actor, (access as Access).workspace, body.ids));
        },
    }),
    route({
        method: "PATCH",
        path: `${W}/settings/models/favourites/{id}`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Rename a favourite model, or change which of its provider's models it is",
        body: z.object({ name: z.string().max(MAX_FAVOURITE_NAME).nullable().optional(), model: z.string().max(150).optional() }),
        async handler({ services, access, params, body, actor }) {
            const { name, model } = body;
            return json(
                await services.settings.updateFavourite(actor, (access as Access).workspace, params.id as string, {
                    ...(name !== undefined ? { name } : {}),
                    ...(model !== undefined ? { model } : {}),
                }),
            );
        },
    }),
    route({
        method: "DELETE",
        path: `${W}/settings/models/favourites/{id}`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Remove a favourite model",
        description:
            "The last favourite can't be removed. Removing the default needs `defaultId`: the favourite that becomes the default instead. One that projects' reviews use (in their review models, `sets`, or as the model their reviews ask which findings are the same problem, `judge`) is refused with 409 and those `projects`, unless `force=true`, which takes it out of them too.",
        query: z.object({ defaultId: z.string().max(64).optional(), force: z.enum(["true", "false"]).optional() }),
        async handler({ services, access, params, query, actor }) {
            return json(
                await services.settings.removeFavourite(
                    actor,
                    (access as Access).workspace,
                    params.id as string,
                    query.defaultId,
                    query.force === "true",
                ),
            );
        },
    }),
    route({
        method: "PUT",
        path: `${W}/settings/models/default`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Make a favourite model the default: the one reviews use when nothing else is chosen",
        body: z.object({ id: z.string().max(64) }),
        async handler({ services, access, body, actor }) {
            return json(await services.settings.setDefaultFavourite(actor, (access as Access).workspace, body.id));
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
