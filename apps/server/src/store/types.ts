// Records and the storage interface. The in-memory store implements it now; Postgres will implement the
// same interface, so services never know which they're using. Everything is async for that reason.

import type { Category, Role, Severity, Status, TokenScope, Via } from "@triagent/shared";
import type { RawReport, UploadMeta } from "../domain/report.ts";

export interface NotifyPrefs {
    scope: "mine" | "all" | "none";
    problemsOnly: boolean;
}

export interface User {
    id: string;
    /** Local accounts sign in with this; accounts from an identity provider may have none. */
    username: string | null;
    displayName: string;
    email: string | null;
    passwordHash: string | null;
    mustChangePassword: boolean;
    isInstanceAdmin: boolean;
    /** The identity provider's issuer and subject: the stable identity for OIDC accounts. */
    issuer: string | null;
    subject: string | null;
    notify: NotifyPrefs;
    createdAt: string;
    lastLoginAt: string | null;
}

export interface Workspace {
    id: string;
    slug: string;
    name: string;
    /** Everyone has one personal workspace; organisations are shared. */
    kind: "personal" | "org";
    createdAt: string;
}

export interface Membership {
    workspaceId: string;
    userId: string;
    role: Role;
    createdAt: string;
}

export interface Session {
    /** sha256 of the cookie value: the value itself is never stored. */
    idHash: string;
    userId: string;
    csrf: string;
    /** Fingerprint of the password the session signed in with: changing it ends other sessions. */
    credential: string | null;
    createdAt: number;
    lastSeenAt: number;
}

export interface ApiToken {
    id: string;
    workspaceId: string;
    /** The person the token acts for (who hears about the reviews it starts), if any. */
    ownerUserId: string | null;
    name: string;
    scope: TokenScope;
    /** sha256 of the token: the token itself is shown once and never stored. */
    hash: string;
    prefix: string;
    createdAt: string;
    createdBy: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
}

export interface Project {
    id: string;
    workspaceId: string;
    slug: string;
    name: string;
    repoUrl: string | null;
    /** The branch the project opens on, reviews compare with, and that can't be deleted. */
    defaultBranch: string;
    /** Opaque id in the project's webhook address, so addresses reveal nothing and never collide. */
    webhookId: string;
    createdAt: string;
}

export interface StoredReport {
    projectId: string;
    branch: string;
    report: RawReport;
    upload: UploadMeta;
    /** Increases on every write; used to cache the parsed report. */
    version: number;
}

export interface ArchivedReport {
    projectId: string;
    branch: string;
    report: RawReport;
    upload: UploadMeta;
    archivedAt: string;
    reason: "replaced" | "deleted";
    /** A deleted branch's triage, kept with its report. */
    triage?: TriageRecord[];
}

export interface Note {
    id: string;
    at: string;
    /** The author's name, as shown. */
    by: string;
    /** Who the author is (see services/core.ts authorKey): decides who may edit or delete it. */
    authorKey: string;
    text: string;
    editedAt?: string;
    editedBy?: string;
}

export type ItemKind = "issue" | "task";

/** Triage of one issue or task on one branch. Absent until someone changes it. */
export interface TriageRecord {
    projectId: string;
    branch: string;
    kind: ItemKind;
    itemId: string;
    status: Status;
    assignee: string | null;
    /** Corrections of the reviewer's rating (issues only). */
    severity: Severity | null;
    category: Category | null;
    duplicateOf: string | null;
    needsDiscussion: boolean;
    notes: Note[];
    /** Increases on every change; callers send it back to refuse stale writes. */
    rev: number;
    updatedAt: string | null;
    updatedBy: string | null;
}

export interface ActivityRow {
    id: string;
    workspaceId: string;
    projectId: string | null;
    branch: string | null;
    at: string;
    actor: string;
    actorUserId: string | null;
    via: Via;
    kind: string;
    itemId: string;
    changes: Record<string, unknown>;
}

/** Administrative events (people, tokens, settings, secrets), kept apart from triage activity. */
export interface AuditRow {
    id: string;
    workspaceId: string | null;
    at: string;
    actor: string;
    actorUserId: string | null;
    via: Via;
    kind: string;
    target: string;
    changes: Record<string, unknown>;
    ip: string | null;
}

export interface UploadLink {
    hash: string;
    projectId: string;
    params: {
        branch: string;
        commit: string | null;
        confirm: boolean;
        reopen: boolean;
        fileName: string | null;
        actor: string;
        actorUserId: string | null;
        /** The token that made the link, if one did: the link stops working if it's revoked. */
        actorTokenId: string | null;
    };
    expiresAt: number;
}

/** An encrypted secret. See services/secrets.ts. */
export interface SecretRecord {
    workspaceId: string | null;
    projectId: string | null;
    name: string;
    sealed: string;
    /** The last few characters, so people can tell which one is set. */
    hint: string;
    setBy: string;
    setAt: string;
}

export interface SettingRecord {
    workspaceId: string;
    projectId: string | null;
    key: string;
    value: unknown;
}

export interface Page {
    limit: number;
    before?: string;
}

/** Everything a request can read or change. Writes inside `Store.transaction` happen all together or not at all. */
export interface Repos {
    users: {
        get(id: string): Promise<User | null>;
        byUsername(username: string): Promise<User | null>;
        list(): Promise<User[]>;
        count(): Promise<number>;
        put(user: User): Promise<void>;
        delete(id: string): Promise<void>;
    };
    sessions: {
        get(idHash: string): Promise<Session | null>;
        listForUser(userId: string): Promise<Session[]>;
        put(session: Session): Promise<void>;
        delete(idHash: string): Promise<void>;
        /** Remove sessions idle since `idleBefore` or created before `createdBefore`. */
        sweep(idleBefore: number, createdBefore: number): Promise<number>;
    };
    workspaces: {
        get(id: string): Promise<Workspace | null>;
        bySlug(slug: string): Promise<Workspace | null>;
        list(): Promise<Workspace[]>;
        put(workspace: Workspace): Promise<void>;
        /** Delete the workspace with its projects, memberships, tokens, settings and secrets. */
        delete(id: string): Promise<void>;
    };
    memberships: {
        get(workspaceId: string, userId: string): Promise<Membership | null>;
        forUser(userId: string): Promise<Membership[]>;
        forWorkspace(workspaceId: string): Promise<Membership[]>;
        put(membership: Membership): Promise<void>;
        delete(workspaceId: string, userId: string): Promise<void>;
    };
    tokens: {
        get(id: string): Promise<ApiToken | null>;
        byHash(hash: string): Promise<ApiToken | null>;
        forWorkspace(workspaceId: string): Promise<ApiToken[]>;
        put(token: ApiToken): Promise<void>;
        delete(id: string): Promise<void>;
    };
    projects: {
        get(id: string): Promise<Project | null>;
        bySlug(workspaceId: string, slug: string): Promise<Project | null>;
        byWebhookId(webhookId: string): Promise<Project | null>;
        forWorkspace(workspaceId: string): Promise<Project[]>;
        put(project: Project): Promise<void>;
        /** Delete the project and everything stored for it. */
        delete(id: string): Promise<void>;
    };
    reports: {
        get(projectId: string, branch: string): Promise<StoredReport | null>;
        branches(projectId: string): Promise<StoredReport[]>;
        /** Store a branch's report; `version` is assigned by the store. */
        put(report: Omit<StoredReport, "version">): Promise<StoredReport>;
        delete(projectId: string, branch: string): Promise<void>;
        archive(entry: ArchivedReport, keep: number): Promise<void>;
        archived(projectId: string, branch: string): Promise<ArchivedReport[]>;
        renameArchive(projectId: string, from: string, to: string): Promise<void>;
    };
    triage: {
        get(projectId: string, branch: string, kind: ItemKind, itemId: string): Promise<TriageRecord | null>;
        forBranch(projectId: string, branch: string): Promise<TriageRecord[]>;
        put(record: TriageRecord): Promise<void>;
        deleteBranch(projectId: string, branch: string): Promise<void>;
        renameBranch(projectId: string, from: string, to: string): Promise<void>;
    };
    activity: {
        add(row: ActivityRow): Promise<void>;
        /** Newest first. */
        list(filter: { workspaceId: string; projectId?: string; branch?: string }, page: Page): Promise<ActivityRow[]>;
    };
    audit: {
        add(row: AuditRow): Promise<void>;
        /** Newest first. `workspaceId: null` lists instance-wide events. */
        list(filter: { workspaceId: string | null }, page: Page): Promise<AuditRow[]>;
    };
    uploadLinks: {
        put(link: UploadLink): Promise<void>;
        get(hash: string): Promise<UploadLink | null>;
        /** Remove and return the link, so it works exactly once. */
        take(hash: string): Promise<UploadLink | null>;
        count(): Promise<number>;
        sweep(now: number): Promise<void>;
    };
    secrets: {
        get(workspaceId: string | null, projectId: string | null, name: string): Promise<SecretRecord | null>;
        list(workspaceId: string | null, projectId: string | null): Promise<SecretRecord[]>;
        put(secret: SecretRecord): Promise<void>;
        delete(workspaceId: string | null, projectId: string | null, name: string): Promise<void>;
    };
    settings: {
        get(workspaceId: string, projectId: string | null, key: string): Promise<SettingRecord | null>;
        put(setting: SettingRecord): Promise<void>;
    };
}

export interface Store extends Repos {
    /**
     * Run `fn` so that its reads and writes see one consistent state and its writes apply all together:
     * if it throws, nothing it wrote is kept. Transactions don't overlap.
     *
     * A transaction started inside another joins it rather than nesting: if the inner one throws, the
     * outer one must fail too. Never catch an inner failure and carry on.
     */
    transaction<T>(fn: (tx: Repos) => Promise<T>): Promise<T>;
    /** Quick liveness check for /healthz. */
    ping(): Promise<void>;
    close(): Promise<void>;
}
