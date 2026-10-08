// Invites by email address: to the instance (for its administrators) and to a workspace (for people who
// manage its members). People accept them by signing in through the identity provider.

import { z } from "zod";
import { badRequest } from "../errors.ts";
import { json, type Route, route } from "../http/route.ts";
import type { Access } from "../services/accounts.ts";
import { RoleSchema, W } from "./common.ts";

const InviteBody = z.object({
    email: z.string().max(254).optional(),
    expiresInDays: z.number().int().nullable().optional(),
});

export const inviteRoutes: Route[] = [
    route({
        method: "GET",
        path: "/api/v1/instance/invites",
        scope: "instance",
        tag: "Instance",
        summary: "Invites to have an account here, newest first",
        async handler({ services }) {
            return json({ items: await services.invites.list(null), hint: services.config.inviteHint });
        },
    }),
    route({
        method: "POST",
        path: "/api/v1/instance/invites",
        scope: "instance",
        tag: "Instance",
        summary: "Invite an email address to have an account (AUTH_MODE=oidc)",
        description: "Accepted when someone signs in through the identity provider with that verified email address.",
        body: InviteBody.extend({ email: z.string().max(254) }),
        async handler({ services, body, actor }) {
            return json(await services.invites.create(actor, null, body), 201);
        },
    }),
    route({
        method: "DELETE",
        path: "/api/v1/instance/invites/{inviteId}",
        scope: "instance",
        tag: "Instance",
        summary: "Revoke an invite to have an account",
        async handler({ services, params, actor }) {
            return json(await services.invites.revoke(actor, null, params.inviteId as string));
        },
    }),
    route({
        method: "GET",
        path: `${W}/settings/invites`,
        scope: "workspace",
        permission: "members",
        tag: "Settings",
        summary: "Invites to join the workspace, newest first",
        async handler({ services, access }) {
            return json({ items: await services.invites.list((access as Access).workspace), hint: services.config.inviteHint });
        },
    }),
    route({
        method: "POST",
        path: `${W}/settings/invites`,
        scope: "workspace",
        permission: "members",
        tag: "Settings",
        summary: "Invite someone to join with a role: by email (AUTH_MODE=oidc), or an existing account by username (AUTH_MODE=local)",
        description:
            "An email invite is accepted when someone signs in through the identity provider with that verified address; it lets them create an account too. A username adds that account straight away.",
        body: InviteBody.extend({ username: z.string().max(64).optional(), role: RoleSchema.optional() }),
        async handler({ services, access, body, actor }) {
            const a = access as Access;
            if (body.username !== undefined) {
                if (services.config.authMode !== "local")
                    throw badRequest("Accounts here have no usernames: invite people by email address instead.");
                return json(
                    { member: await services.accounts.addMember(actor, a, { username: body.username, role: body.role ?? "editor" }) },
                    201,
                );
            }
            if (body.email === undefined) throw badRequest("Give an email address to invite.");
            return json(
                await services.invites.create(actor, a, {
                    email: body.email,
                    role: body.role ?? null,
                    ...(body.expiresInDays !== undefined ? { expiresInDays: body.expiresInDays } : {}),
                }),
                201,
            );
        },
    }),
    route({
        method: "DELETE",
        path: `${W}/settings/invites/{inviteId}`,
        scope: "workspace",
        permission: "members",
        tag: "Settings",
        summary: "Revoke an invite to join the workspace",
        async handler({ services, access, params, actor }) {
            return json(await services.invites.revoke(actor, (access as Access).workspace, params.inviteId as string));
        },
    }),
];
