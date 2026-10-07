// People, sign-ins, workspaces, memberships and API tokens.

import { randomBytes } from "node:crypto";
import { type Grant, ROLES, type Role, roleRank, TOKEN_SCOPES, type TokenScope } from "@triagent/shared";
import { isValidSlug, USERNAME } from "../domain/names.ts";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.ts";
import {
    checkNewPassword,
    DUMMY_PASSWORD_HASH,
    FailureLimiter,
    generatePassword,
    hashPassword,
    now,
    randomId,
    safeEqual,
    sha256,
    verifyPassword,
} from "../security.ts";
import type { ApiToken, Membership, NotifyPrefs, Repos, Session, User, Workspace } from "../store/types.ts";
import type { Actor, Core, Write } from "./core.ts";

export const TOKEN_PREFIX = "tri_";
const MAX_SESSIONS_PER_USER = 20;

export type Principal = { kind: "session"; user: User; session: Session } | { kind: "token"; token: ApiToken; owner: User | null };

/** What a principal may do in one workspace. */
export interface Access {
    workspace: Workspace;
    grant: Grant;
}

export const DEFAULT_NOTIFY: NotifyPrefs = { scope: "mine", problemsOnly: false };

export function publicUser(u: User) {
    return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        email: u.email,
        isInstanceAdmin: u.isInstanceAdmin,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
    };
}

export function publicToken(t: ApiToken, owner: User | null) {
    const { hash: _hash, ...rest } = t;
    return { ...rest, owner: owner ? { id: owner.id, displayName: owner.displayName } : null };
}

export function publicWorkspace(w: Workspace, role?: Role) {
    return { id: w.id, slug: w.slug, name: w.name, kind: w.kind, createdAt: w.createdAt, ...(role ? { role } : {}) };
}

export class Accounts {
    private readonly core: Core;
    private readonly ipLimiter = new FailureLimiter(20, 15 * 60_000);
    private readonly pairLimiter = new FailureLimiter(8, 15 * 60_000);
    private readonly userLimiter = new FailureLimiter(100, 15 * 60_000);
    private readonly tokenSeen = new Map<string, number>();
    /** Addresses each account recently signed in from: guessing elsewhere can't lock them out. */
    private readonly knownAddresses = new Map<string, Set<string>>();

    constructor(core: Core) {
        this.core = core;
        setInterval(() => {
            this.ipLimiter.sweep();
            this.pairLimiter.sweep();
            this.userLimiter.sweep();
            const t = Date.now();
            void core.store.sessions
                .sweep(t - core.config.sessionIdleMinutes * 60_000, t - core.config.sessionMaxHours * 3_600_000)
                .catch(() => {});
        }, 5 * 60_000).unref();
    }

    private get repos(): Repos {
        return this.core.store;
    }

    // ---- local accounts -----------------------------------------------------------------

    /** Create a local account, with its personal workspace. */
    async createLocalUser(
        tx: Repos,
        input: { username: string; password: string; isInstanceAdmin?: boolean; mustChangePassword?: boolean },
    ): Promise<User> {
        const username = input.username.trim();
        if (!USERNAME.test(username)) throw badRequest("Usernames may use letters, numbers and . _ @ - (up to 64).");
        try {
            checkNewPassword(input.password, username);
        } catch (err) {
            throw badRequest((err as Error).message);
        }
        if (await tx.users.byUsername(username)) throw conflict(`There's already an account called "${username}".`);
        const user: User = {
            id: randomId(),
            username,
            displayName: username,
            email: null,
            passwordHash: await hashPassword(input.password),
            mustChangePassword: input.mustChangePassword ?? false,
            isInstanceAdmin: input.isInstanceAdmin ?? false,
            issuer: null,
            subject: null,
            notify: DEFAULT_NOTIFY,
            createdAt: now(),
            lastLoginAt: null,
        };
        await tx.users.put(user);
        await this.createPersonalWorkspace(tx, user);
        return user;
    }

    /** First start: the admin named in the environment, if there are no accounts yet. */
    async bootstrap(): Promise<User | null> {
        const admin = this.core.config.bootstrapAdmin;
        if (!admin || (await this.repos.users.count()) > 0) return null;
        return this.core.store.transaction((tx) => this.createLocalUser(tx, { ...admin, isInstanceAdmin: true }));
    }

    private async createPersonalWorkspace(tx: Repos, user: User): Promise<Workspace> {
        const base =
            (user.username ?? user.displayName)
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 32) || "me";
        let slug = isValidSlug(base) ? base : `u-${base}`.slice(0, 40);
        for (let n = 2; await tx.workspaces.bySlug(slug); n++) slug = `${base.slice(0, 34)}-${n}`;
        const workspace: Workspace = { id: randomId(), slug, name: user.displayName, kind: "personal", createdAt: now() };
        await tx.workspaces.put(workspace);
        await tx.memberships.put({ workspaceId: workspace.id, userId: user.id, role: "owner", createdAt: now() });
        return workspace;
    }

    async signIn(username: string, password: string, ip: string): Promise<{ user: User; cookie: string } | { retryAfter: number }> {
        const name = username.toLowerCase();
        const pair = `${name}|${ip}`;
        // The per-account limit (distributed guessing) doesn't apply from addresses the account recently
        // signed in from, so guessing elsewhere can't lock its owner out.
        const known = this.knownAddresses.get(name)?.has(ip) ?? false;
        const wait = Math.max(
            this.ipLimiter.retryAfter(ip),
            this.pairLimiter.retryAfter(pair),
            known ? 0 : this.userLimiter.retryAfter(name),
        );
        if (wait) return { retryAfter: wait };
        // Counted before checking, so parallel attempts can't all slip under the limits; forgiven on success.
        this.ipLimiter.fail(ip);
        this.pairLimiter.fail(pair);
        this.userLimiter.fail(name);
        const user = await this.repos.users.byUsername(username);
        const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
        if (!user?.passwordHash || !ok) return { retryAfter: 0 };
        const cookie = await this.core.store.transaction(async (tx) => {
            // The password may have changed while we were checking it.
            const fresh = await tx.users.get(user.id);
            if (!fresh || fresh.passwordHash !== user.passwordHash) return null;
            await tx.users.put({ ...fresh, lastLoginAt: now() });
            return this.startSession(tx, fresh);
        });
        if (!cookie) return { retryAfter: 0 };
        this.ipLimiter.clear(ip);
        this.pairLimiter.clear(pair);
        this.userLimiter.forgive(name);
        const addresses = this.knownAddresses.get(name) ?? new Set<string>();
        addresses.add(ip);
        if (addresses.size > 20) addresses.delete(addresses.values().next().value as string);
        this.knownAddresses.set(name, addresses);
        return { user, cookie };
    }

    /** A new session; returns the cookie value (only its hash is stored). */
    private async startSession(tx: Repos, user: User): Promise<string> {
        const id = randomBytes(32).toString("base64url");
        const t = Date.now();
        // At most MAX_SESSIONS_PER_USER each: signing in again ends the oldest.
        const theirs = (await tx.sessions.listForUser(user.id)).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
        for (const s of theirs.slice(0, Math.max(0, theirs.length - MAX_SESSIONS_PER_USER + 1))) await tx.sessions.delete(s.idHash);
        await tx.sessions.put({
            idHash: sha256(id),
            userId: user.id,
            csrf: randomBytes(24).toString("base64url"),
            credential: user.passwordHash ? sha256(user.passwordHash) : null,
            createdAt: t,
            lastSeenAt: t,
        });
        return id;
    }

    /** The session for a cookie value, if it's still valid. Changing the password or removing the account ends it. */
    async session(cookie: string | undefined, { touch = true } = {}): Promise<Principal | null> {
        if (!cookie) return null;
        const s = await this.repos.sessions.get(sha256(cookie));
        return s ? this.validSession(s, { touch }) : null;
    }

    async validSession(s: Session, { touch = true } = {}): Promise<Principal | null> {
        const t = Date.now();
        const { sessionIdleMinutes, sessionMaxHours } = this.core.config;
        const user = await this.repos.users.get(s.userId);
        const credential = user?.passwordHash ? sha256(user.passwordHash) : null;
        if (
            !user ||
            credential !== s.credential ||
            t - s.lastSeenAt > sessionIdleMinutes * 60_000 ||
            t - s.createdAt > sessionMaxHours * 3_600_000
        ) {
            await this.repos.sessions.delete(s.idHash);
            return null;
        }
        // Record activity at most once a minute, without bringing back a session ended meanwhile.
        if (touch && t - s.lastSeenAt > 60_000) {
            await this.core.store.transaction(async (tx) => {
                const current = await tx.sessions.get(s.idHash);
                if (current) await tx.sessions.put({ ...current, lastSeenAt: t });
            });
        }
        return { kind: "session", user, session: s };
    }

    async signOut(idHash: string): Promise<void> {
        await this.repos.sessions.delete(idHash);
    }

    /** End a person's sessions, except one. Returns how many ended. */
    async signOutUser(tx: Repos, userId: string, except?: string): Promise<number> {
        const sessions = (await tx.sessions.listForUser(userId)).filter((s) => s.idHash !== except);
        for (const s of sessions) await tx.sessions.delete(s.idHash);
        return sessions.length;
    }

    async changeOwnPassword(
        principal: Principal & { kind: "session" },
        current: string,
        next: string,
        ip: string,
        actor: Actor,
    ): Promise<{ signedOutSessions: number }> {
        const { user, session } = principal;
        if (!user.username || !user.passwordHash)
            throw badRequest("This account signs in through its identity provider, so it has no password here.");
        const check = await this.signIn(user.username, current, ip);
        if ("retryAfter" in check)
            throw new ApiError(
                check.retryAfter ? 429 : 400,
                check.retryAfter ? "Too many failed attempts. Try again later." : "Your current password is wrong.",
            );
        // signIn started a session we don't need.
        await this.repos.sessions.delete(sha256(check.cookie));
        if (next === current) throw badRequest("The new password must be different from the current one.");
        try {
            checkNewPassword(next, user.username);
        } catch (err) {
            throw badRequest((err as Error).message);
        }
        const hash = await hashPassword(next);
        return this.core.write(actor, async (w) => {
            const fresh = await w.tx.users.get(user.id);
            if (!fresh || fresh.passwordHash !== user.passwordHash)
                throw conflict("Your password was changed by another request. Sign in again.");
            // Stay signed in here (updated first, so this session never looks stale), but nowhere else.
            const current = await w.tx.sessions.get(session.idHash);
            if (current) await w.tx.sessions.put({ ...current, credential: sha256(hash) });
            await w.tx.users.put({ ...fresh, passwordHash: hash, mustChangePassword: false });
            const n = await this.signOutUser(w.tx, user.id, session.idHash);
            await w.audit({ workspaceId: null, kind: "user", target: user.id, changes: { password: "changed", signedOutSessions: n } });
            return { signedOutSessions: n };
        });
    }

    async setNotify(user: User, prefs: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
        return this.core.store.transaction(async (tx) => {
            const fresh = await tx.users.get(user.id);
            if (!fresh) throw notFound("Your account no longer exists.");
            const notify = { ...fresh.notify, ...prefs };
            await tx.users.put({ ...fresh, notify });
            return notify;
        });
    }

    // ---- instance administration (local accounts) ------------------------------------------

    async adminCreateUser(actor: Actor, input: { username: string; password?: string | null; isInstanceAdmin?: boolean }) {
        const generated = !input.password;
        const password = input.password || generatePassword();
        return this.core.write(actor, async (w) => {
            const user = await this.createLocalUser(w.tx, {
                username: input.username,
                password,
                isInstanceAdmin: input.isInstanceAdmin ?? false,
                mustChangePassword: true,
            });
            await w.audit({
                workspaceId: null,
                kind: "user",
                target: user.id,
                changes: { created: { username: user.username, isInstanceAdmin: user.isInstanceAdmin } },
            });
            return { user: publicUser(user), password: generated ? password : null };
        });
    }

    async adminResetPassword(actor: Actor, userId: string, password?: string | null) {
        if (userId === actor.userId) throw badRequest("Change your own password from your account settings.");
        const user = await this.repos.users.get(userId);
        if (!user?.username) throw notFound("No local account with that id.");
        const generated = !password;
        const value = password || generatePassword();
        try {
            checkNewPassword(value, user.username);
        } catch (err) {
            throw badRequest((err as Error).message);
        }
        const hash = await hashPassword(value);
        return this.core.write(actor, async (w) => {
            const fresh = await w.tx.users.get(user.id);
            if (!fresh) throw notFound("No local account with that id.");
            await w.tx.users.put({ ...fresh, passwordHash: hash, mustChangePassword: true });
            const n = await this.signOutUser(w.tx, user.id);
            await w.audit({ workspaceId: null, kind: "user", target: user.id, changes: { password: "reset", signedOutSessions: n } });
            return { password: generated ? value : null, signedOutSessions: n };
        });
    }

    async adminDeleteUser(actor: Actor, userId: string) {
        if (userId === actor.userId) throw badRequest("You can't remove your own account.");
        return this.core.write(actor, async (w) => {
            const user = await w.tx.users.get(userId);
            if (!user) throw notFound("No account with that id.");
            if (user.isInstanceAdmin && (await w.tx.users.list()).filter((u) => u.isInstanceAdmin).length <= 1)
                throw badRequest("There must always be at least one instance admin.");
            for (const m of await w.tx.memberships.forUser(userId)) {
                const workspace = await w.tx.workspaces.get(m.workspaceId);
                // Their personal workspace goes with them.
                if (workspace?.kind === "personal") {
                    await w.tx.workspaces.delete(workspace.id);
                    continue;
                }
                if (m.role === "owner" && workspace?.kind === "org" && (await this.owners(w.tx, m.workspaceId)).length <= 1) {
                    throw badRequest(`${user.displayName} is the only owner of ${workspace.name}. Make someone else an owner first.`);
                }
                await w.tx.memberships.delete(m.workspaceId, userId);
                await this.revokeTokensOf(w, m.workspaceId, userId);
            }
            w.afterCommit(() => this.core.events.disconnect(`user:${userId}`));
            await this.signOutUser(w.tx, userId);
            await w.tx.users.delete(userId);
            await w.audit({ workspaceId: null, kind: "user", target: userId, changes: { removed: { username: user.username } } });
            return { removed: true };
        });
    }

    async adminSignOutUser(actor: Actor, userId: string) {
        return this.core.write(actor, async (w) => {
            const n = await this.signOutUser(w.tx, userId);
            await w.audit({ workspaceId: null, kind: "user", target: userId, changes: { signedOutSessions: n } });
            return { signedOutSessions: n };
        });
    }

    // ---- workspaces and members ----------------------------------------------------------

    async workspacesOf(user: User) {
        const out = [];
        for (const m of await this.repos.memberships.forUser(user.id)) {
            const w = await this.repos.workspaces.get(m.workspaceId);
            if (w) out.push(publicWorkspace(w, m.role));
        }
        return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "personal" ? -1 : 1));
    }

    async createOrganisation(actor: Actor & { userId: string }, input: { slug: string; name: string }) {
        const slug = input.slug.trim().toLowerCase();
        const name = input.name.trim() || slug;
        if (!isValidSlug(slug))
            throw badRequest("Workspace ids are lower-case letters, numbers and dashes (up to 40), starting with a letter or number.");
        if (name.length > 80) throw badRequest("Keep the name under 80 characters.");
        return this.core.write(actor, async (w) => {
            if (await w.tx.workspaces.bySlug(slug)) throw conflict(`The id "${slug}" is taken.`);
            const workspace: Workspace = { id: randomId(), slug, name, kind: "org", createdAt: now() };
            await w.tx.workspaces.put(workspace);
            await w.tx.memberships.put({ workspaceId: workspace.id, userId: actor.userId, role: "owner", createdAt: now() });
            await w.audit({ workspaceId: workspace.id, kind: "workspace", target: workspace.id, changes: { created: { slug, name } } });
            return publicWorkspace(workspace, "owner");
        });
    }

    async renameWorkspace(actor: Actor, workspace: Workspace, name: string) {
        const value = name.trim();
        if (!value || value.length > 80) throw badRequest("Give the workspace a name (up to 80 characters).");
        return this.core.write(actor, async (w) => {
            const current = await w.tx.workspaces.get(workspace.id);
            if (!current) throw notFound("The workspace no longer exists.");
            await w.tx.workspaces.put({ ...current, name: value });
            await w.audit({
                workspaceId: workspace.id,
                kind: "workspace",
                target: workspace.id,
                changes: { name: { from: current.name, to: value } },
            });
            return publicWorkspace({ ...current, name: value });
        });
    }

    /**
     * What a principal may do in a workspace, or null if it has no access (callers answer 404, so a
     * workspace's existence isn't revealed to outsiders).
     */
    async access(principal: Principal, slug: string): Promise<Access | null> {
        const workspace = await this.repos.workspaces.bySlug(slug);
        if (!workspace) return null;
        if (principal.kind === "token")
            return principal.token.workspaceId === workspace.id
                ? { workspace, grant: { kind: "scope", scope: principal.token.scope } }
                : null;
        const m = await this.repos.memberships.get(workspace.id, principal.user.id);
        return m ? { workspace, grant: { kind: "role", role: m.role } } : null;
    }

    private async owners(tx: Repos, workspaceId: string): Promise<Membership[]> {
        return (await tx.memberships.forWorkspace(workspaceId)).filter((m) => m.role === "owner");
    }

    async members(workspace: Workspace) {
        const out = [];
        for (const m of await this.repos.memberships.forWorkspace(workspace.id)) {
            const u = await this.repos.users.get(m.userId);
            if (u) out.push({ user: publicUser(u), role: m.role, since: m.createdAt });
        }
        return out.sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.user.displayName.localeCompare(b.user.displayName));
    }

    /** Only owners can make or unmake owners; admins manage everyone else. */
    private checkRoleChange(actorRole: Role, from: Role | null, to: Role | null): void {
        if ((from === "owner" || to === "owner") && actorRole !== "owner") throw forbidden("Only owners can add, remove or change owners.");
    }

    async addMember(actor: Actor, access: Access, input: { username: string; role: Role }) {
        if (!ROLES.includes(input.role)) throw badRequest(`Role must be one of: ${ROLES.join(", ")}.`);
        if (access.workspace.kind === "personal")
            throw badRequest("Personal workspaces have one member. Create an organisation to work with others.");
        this.checkRoleChange(this.roleOf(access), null, input.role);
        return this.core.write(actor, async (w) => {
            const user = await w.tx.users.byUsername(input.username.trim());
            if (!user) throw notFound(`No account called "${input.username}".`);
            if (await w.tx.memberships.get(access.workspace.id, user.id)) throw conflict(`${user.displayName} is already a member.`);
            await w.tx.memberships.put({ workspaceId: access.workspace.id, userId: user.id, role: input.role, createdAt: now() });
            await w.audit({ workspaceId: access.workspace.id, kind: "member", target: user.id, changes: { added: { role: input.role } } });
            return { user: publicUser(user), role: input.role };
        });
    }

    async setMemberRole(actor: Actor, access: Access, userId: string, role: Role) {
        if (!ROLES.includes(role)) throw badRequest(`Role must be one of: ${ROLES.join(", ")}.`);
        if (userId === actor.userId) throw badRequest("You can't change your own role. Ask another owner or admin.");
        return this.core.write(actor, async (w) => {
            const m = await w.tx.memberships.get(access.workspace.id, userId);
            if (!m) throw notFound("That person isn't a member.");
            this.checkRoleChange(this.roleOf(access), m.role, role);
            await w.tx.memberships.put({ ...m, role });
            // Their live connections pick up the new role when they reconnect.
            w.afterCommit(() => this.core.events.disconnect(`user:${userId}`, access.workspace.id));
            await w.audit({
                workspaceId: access.workspace.id,
                kind: "member",
                target: userId,
                changes: { role: { from: m.role, to: role } },
            });
            return { userId, role };
        });
    }

    async removeMember(actor: Actor, access: Access, userId: string) {
        return this.core.write(actor, async (w) => {
            const m = await w.tx.memberships.get(access.workspace.id, userId);
            if (!m) throw notFound("That person isn't a member.");
            if (userId !== actor.userId) this.checkRoleChange(this.roleOf(access), m.role, null);
            if (m.role === "owner" && (await this.owners(w.tx, access.workspace.id)).length <= 1)
                throw badRequest("A workspace needs at least one owner.");
            await w.tx.memberships.delete(access.workspace.id, userId);
            const revoked = await this.revokeTokensOf(w, access.workspace.id, userId);
            w.afterCommit(() => this.core.events.disconnect(`user:${userId}`, access.workspace.id));
            if (revoked)
                await w.audit({ workspaceId: access.workspace.id, kind: "token", target: userId, changes: { revokedWithMember: revoked } });
            await w.audit({ workspaceId: access.workspace.id, kind: "member", target: userId, changes: { removed: { role: m.role } } });
            return { removed: true };
        });
    }

    /** Revoke the tokens that act for someone leaving a workspace: they'd otherwise keep its access. */
    private async revokeTokensOf(w: Write, workspaceId: string, userId: string): Promise<number> {
        let n = 0;
        for (const t of await w.tx.tokens.forWorkspace(workspaceId)) {
            if (t.ownerUserId !== userId) continue;
            await w.tx.tokens.delete(t.id);
            w.afterCommit(() => this.core.events.disconnect(`token:${t.id}`));
            n++;
        }
        return n;
    }

    private roleOf(access: Access): Role {
        return access.grant.kind === "role" ? access.grant.role : "viewer";
    }

    // ---- API tokens --------------------------------------------------------------------

    /** The token for an Authorization header value, if valid. */
    async token(raw: string): Promise<Principal | null> {
        if (!raw.startsWith(TOKEN_PREFIX) || raw.length > 200) return null;
        const token = await this.repos.tokens.byHash(sha256(raw));
        if (!token || !safeEqual(token.hash, sha256(raw))) return null;
        if (token.expiresAt && Date.parse(token.expiresAt) < Date.now()) return null;
        // Record "last used" at most every 10 minutes per token.
        const last = this.tokenSeen.get(token.id) ?? 0;
        if (Date.now() - last > 600_000) {
            this.tokenSeen.set(token.id, Date.now());
            await this.core.store
                .transaction(async (tx) => {
                    const current = await tx.tokens.get(token.id);
                    if (current) await tx.tokens.put({ ...current, lastUsedAt: now() });
                })
                .catch(() => {});
        }
        const owner = token.ownerUserId ? await this.repos.users.get(token.ownerUserId) : null;
        return { kind: "token", token, owner };
    }

    async tokenStillValid(id: string): Promise<boolean> {
        const t = await this.repos.tokens.get(id);
        return Boolean(t) && !(t?.expiresAt && Date.parse(t.expiresAt) < Date.now());
    }

    async listTokens(workspace: Workspace) {
        const out = [];
        for (const t of await this.repos.tokens.forWorkspace(workspace.id)) {
            out.push(publicToken(t, t.ownerUserId ? await this.repos.users.get(t.ownerUserId) : null));
        }
        return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    private async checkOwner(tx: Repos, workspace: Workspace, ownerUserId: string | null): Promise<User | null> {
        if (!ownerUserId) return null;
        const user = await tx.users.get(ownerUserId);
        if (!user || !(await tx.memberships.get(workspace.id, user.id)))
            throw badRequest("A token can only act for a member of its workspace.");
        return user;
    }

    async createToken(
        actor: Actor,
        workspace: Workspace,
        input: { name: string; scope: TokenScope; expiresInDays?: number | null; ownerUserId?: string | null },
    ) {
        const name = input.name.trim();
        if (!/^[\w .@:-]{1,64}$/.test(name)) throw badRequest("Token names may use letters, numbers, spaces and . _ @ : - (up to 64).");
        if (!TOKEN_SCOPES.includes(input.scope)) throw badRequest(`Scope must be one of: ${TOKEN_SCOPES.join(", ")}.`);
        const days = input.expiresInDays ?? null;
        if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650))
            throw badRequest("Expiry must be 1–3650 days, or empty for none.");
        const raw = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
        return this.core.write(actor, async (w) => {
            // By default a token acts for the person creating it.
            const owner = await this.checkOwner(w.tx, workspace, input.ownerUserId === undefined ? actor.userId : input.ownerUserId);
            // Names show up as the author of an agent's changes, so they're unique in the workspace.
            if ((await w.tx.tokens.forWorkspace(workspace.id)).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
                throw conflict(`There's already a token called "${name}" in this workspace.`);
            }
            const token: ApiToken = {
                id: randomBytes(6).toString("hex"),
                workspaceId: workspace.id,
                ownerUserId: owner?.id ?? null,
                name,
                scope: input.scope,
                hash: sha256(raw),
                prefix: raw.slice(0, 10),
                createdAt: now(),
                createdBy: actor.name,
                expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
                lastUsedAt: null,
            };
            await w.tx.tokens.put(token);
            await w.audit({
                workspaceId: workspace.id,
                kind: "token",
                target: token.id,
                changes: { created: { name, scope: token.scope, owner: owner?.displayName ?? null } },
            });
            return { token: raw, record: publicToken(token, owner) };
        });
    }

    async setTokenOwner(actor: Actor, workspace: Workspace, id: string, ownerUserId: string | null) {
        return this.core.write(actor, async (w) => {
            const token = await w.tx.tokens.get(id);
            if (!token || token.workspaceId !== workspace.id) throw notFound("No such token.");
            const owner = await this.checkOwner(w.tx, workspace, ownerUserId);
            await w.tx.tokens.put({ ...token, ownerUserId: owner?.id ?? null });
            await w.audit({ workspaceId: workspace.id, kind: "token", target: id, changes: { owner: owner?.displayName ?? null } });
            return publicToken({ ...token, ownerUserId: owner?.id ?? null }, owner);
        });
    }

    async revokeToken(actor: Actor, workspace: Workspace, id: string) {
        return this.core.write(actor, async (w) => {
            const token = await w.tx.tokens.get(id);
            if (!token || token.workspaceId !== workspace.id) throw notFound("No such token.");
            await w.tx.tokens.delete(id);
            w.afterCommit(() => this.core.events.disconnect(`token:${id}`));
            await w.audit({ workspaceId: workspace.id, kind: "token", target: id, changes: { revoked: { name: token.name } } });
            return { revoked: true };
        });
    }
}
