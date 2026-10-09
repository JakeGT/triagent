// Invitations by email address. An instance invite lets someone create an account by signing in through
// the identity provider; a workspace invite also adds them to that workspace with a role. Invites are
// accepted when someone signs in with a verified email address that matches (services/accounts.ts):
// email delivery comes later, so for now the person is told some other way.

import { ROLES, type Role } from "@triagent/shared";
import { badRequest, conflict, notFound } from "../errors.ts";
import { now, randomId } from "../security.ts";
import type { Invite, Repos, User, Workspace } from "../store/types.ts";
import type { Access } from "./accounts.ts";
import type { Actor, Core, Write } from "./core.ts";

export const DEFAULT_INVITE_DAYS = 14;
// A practical check, not RFC 5322: one @, something either side, a dot in the domain, no spaces.
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

export function inviteStatus(i: Invite, at = Date.now()): "pending" | "expired" | "accepted" {
    if (i.acceptedAt) return "accepted";
    // Written this way round so an unreadable date counts as expired.
    return Date.parse(i.expiresAt) >= at ? "pending" : "expired";
}

export class Invites {
    private readonly core: Core;

    constructor(core: Core) {
        this.core = core;
    }

    private async view(tx: Repos, i: Invite) {
        const by = i.createdBy ? await tx.users.get(i.createdBy) : null;
        const acceptedBy = i.acceptedBy ? await tx.users.get(i.acceptedBy) : null;
        return {
            id: i.id,
            email: i.email,
            role: i.role,
            status: inviteStatus(i),
            createdAt: i.createdAt,
            createdBy: by ? { id: by.id, displayName: by.displayName } : null,
            expiresAt: i.expiresAt,
            acceptedAt: i.acceptedAt,
            acceptedBy: acceptedBy ? { id: acceptedBy.id, displayName: acceptedBy.displayName } : null,
        };
    }

    async list(workspace: Workspace | null) {
        const out = [];
        for (const i of await this.core.store.invites.list(workspace?.id ?? null)) out.push(await this.view(this.core.store, i));
        return out;
    }

    private checkMode(): void {
        if (this.core.config.authMode !== "oidc")
            throw badRequest(
                "Email invites are for AUTH_MODE=oidc, where people accept them by signing in through the identity provider. Create an account, or add an existing one by username.",
            );
    }

    /** Invite an address to have an account (`access` null: an instance invite) or to join a workspace with a role. */
    async create(actor: Actor, access: Access | null, input: { email: string; role?: Role | null; expiresInDays?: number | null }) {
        this.checkMode();
        const email = input.email.trim().toLowerCase();
        if (!EMAIL.test(email) || email.length > 254) throw badRequest("Enter an email address, like sam@example.com.");
        const days = input.expiresInDays ?? DEFAULT_INVITE_DAYS;
        if (!(Number.isInteger(days) && days >= 1 && days <= 90)) throw badRequest("Invites can last 1 to 90 days.");
        const workspace = access?.workspace ?? null;
        let role: Role | null = null;
        if (workspace) {
            if (workspace.kind === "personal")
                throw badRequest("Personal workspaces have one member. Create an organisation to work with others.");
            role = input.role ?? "editor";
            if (!ROLES.includes(role)) throw badRequest(`Role must be one of: ${ROLES.join(", ")}.`);
            const mine = access?.grant.kind === "role" ? access.grant.role : "viewer";
            if (role === "owner" && mine !== "owner") throw badRequest("Only owners can invite owners.");
        }
        return this.core.write(actor, async (w) => {
            for (const existing of await w.tx.invites.pendingFor(email)) {
                if (existing.workspaceId !== (workspace?.id ?? null)) continue;
                if (inviteStatus(existing) === "pending")
                    throw conflict(`${email} already has an invite${workspace ? " to this workspace" : ""}. Revoke it to send a new one.`);
                // An expired one makes way for the new one.
                await w.tx.invites.delete(existing.id);
            }
            const invite: Invite = {
                id: randomId(),
                email,
                workspaceId: workspace?.id ?? null,
                role,
                createdBy: actor.userId,
                createdAt: now(),
                expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
                acceptedAt: null,
                acceptedBy: null,
            };
            await w.tx.invites.put(invite);
            await w.audit({
                workspaceId: invite.workspaceId,
                kind: "invite",
                target: invite.id,
                changes: { created: { email, role, expiresAt: invite.expiresAt } },
            });
            return { invite: await this.view(w.tx, invite), hint: this.core.config.inviteHint };
        });
    }

    async revoke(actor: Actor, workspace: Workspace | null, id: string) {
        return this.core.write(actor, async (w) => {
            const invite = await w.tx.invites.get(id);
            // Another workspace's invite is answered the same as a missing one.
            if (!invite || invite.workspaceId !== (workspace?.id ?? null)) throw notFound("No such invite.");
            if (invite.acceptedAt) throw badRequest("That invite has been accepted. Remove the member or account instead.");
            await w.tx.invites.delete(id);
            await w.audit({ workspaceId: invite.workspaceId, kind: "invite", target: id, changes: { revoked: { email: invite.email } } });
            return { revoked: true };
        });
    }

    /** Pending, unexpired invites for a verified address. */
    async openFor(tx: Repos, email: string | null): Promise<Invite[]> {
        if (!email) return [];
        return (await tx.invites.pendingFor(email)).filter((i) => inviteStatus(i) === "pending");
    }

    /**
     * Accept every open invite for the address, inside the sign-in's transaction: a workspace invite adds
     * the membership (unless they're already a member, or the workspace has gone), an instance invite just
     * records that it was used.
     */
    async accept(w: Write, user: User, invites: Invite[]): Promise<void> {
        for (const invite of invites) {
            const fresh = await w.tx.invites.get(invite.id);
            if (!fresh || fresh.acceptedAt) continue;
            await w.tx.invites.put({ ...fresh, acceptedAt: now(), acceptedBy: user.id });
            let joined: Role | null = null;
            if (fresh.workspaceId && fresh.role && (await w.tx.workspaces.get(fresh.workspaceId))) {
                if (!(await w.tx.memberships.get(fresh.workspaceId, user.id))) {
                    await w.tx.memberships.put({ workspaceId: fresh.workspaceId, userId: user.id, role: fresh.role, createdAt: now() });
                    joined = fresh.role;
                }
            }
            await w.audit({
                workspaceId: fresh.workspaceId,
                kind: "invite",
                target: fresh.id,
                changes: { accepted: { email: fresh.email, userId: user.id } },
            });
            if (joined)
                await w.audit({
                    workspaceId: fresh.workspaceId,
                    kind: "member",
                    target: user.id,
                    changes: { added: { role: joined, via: "invite" } },
                });
        }
    }
}
