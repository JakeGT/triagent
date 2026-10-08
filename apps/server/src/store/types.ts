// Records and the storage interface. The in-memory store and the Postgres store both implement it, so
// services never know which they're using. Everything is async for that reason.

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
    /** When the person last proved who they are (signed in, or confirmed it): setting secrets needs a recent one. */
    authAt: number;
    /** The identity provider's ID token, kept only as the hint for signing out there. Never sent anywhere else. */
    idToken?: string | null;
}

/** An invitation for an email address: to have an account (instance invite), or to join a workspace with a role. */
export interface Invite {
    id: string;
    /** Lower-cased. Matched against the verified email address someone signs in with. */
    email: string;
    /** Null for an instance invite. */
    workspaceId: string | null;
    /** Null for an instance invite. */
    role: Role | null;
    /** The id of the person who sent it. */
    createdBy: string | null;
    createdAt: string;
    expiresAt: string;
    acceptedAt: string | null;
    acceptedBy: string | null;
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

/** How a finished review is described: everything analytics needs beyond the indexed columns. */
export interface ReviewDetails {
    prNumber?: number;
    commit?: string | null;
    /** Who asked for it: a person's or token's name, or "automation". */
    requestedBy?: string | null;
    ocrVersion?: string | null;
    queuedAt?: string;
    startedAt?: string;
    queueSeconds?: number;
    runSeconds?: number;
    findings?: { total: number; bySeverity: Record<Severity, number> };
    /** What the resulting upload did to the branch's triage. */
    counts?: { added: number; carriedOver: number; removed: number; reopened: number };
    files?: { reviewed?: number; groups?: number; failedGroups?: number };
    toolCalls?: { total: number; failed: number; byTool?: Record<string, number>; failedByTool?: Record<string, number> };
    llm?: { requests?: number; retries?: number; failures?: number; maxGapSeconds?: number };
    error?: string | null;
    /** Findings this review reported for the first time on its branch, by the reviewer's severity: when each first appeared. */
    addedIds?: Partial<Record<Severity, string[]>>;
}

/** One finished review: a run on the server, or a report someone uploaded. Kept for analytics and allowances. */
export interface ReviewRecord {
    id: string;
    workspaceId: string;
    /** No foreign key: analytics keep a deleted project's history. */
    projectId: string | null;
    branch: string;
    /** When it finished, or was uploaded. */
    at: string;
    source: "run" | "upload";
    kind: "pr" | "changes" | "full" | "upload";
    status: "done" | "partial" | "failed" | "cancelled";
    model: string | null;
    provider: string | null;
    /** Whose model key paid for it: the workspace's own, or the instance's (counted against an allowance). */
    keySource: "workspace" | "instance" | null;
    tokens: { input: number; output: number; cacheRead: number; total: number } | null;
    details: ReviewDetails;
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

/** A workspace allowed to use the instance's model key, up to a number of tokens each calendar month (UTC). */
export interface ModelGrant {
    workspaceId: string;
    monthlyTokens: number;
    grantedBy: string;
    grantedAt: string;
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
        /** The account an identity provider's issuer and subject belong to. */
        byIdentity(issuer: string, subject: string): Promise<User | null>;
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
        /** Delete the workspace with its projects, memberships, tokens, settings, secrets and activity (not its audit log). */
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
    reviewHistory: {
        add(record: ReviewRecord): Promise<void>;
        /** Newest first, finished at or after `since` (ISO time) if given. */
        list(filter: { workspaceId: string; projectId?: string; branch?: string; since?: string }, limit: number): Promise<ReviewRecord[]>;
        /** Model tokens used since `since`, optionally only those paid with one kind of key. */
        tokensSince(workspaceId: string, since: string, keySource?: ReviewRecord["keySource"]): Promise<number>;
        /** The same, for every workspace with any: workspace id → tokens. */
        tokensByWorkspace(since: string, keySource?: ReviewRecord["keySource"]): Promise<Record<string, number>>;
    };
    settings: {
        get(workspaceId: string, projectId: string | null, key: string): Promise<SettingRecord | null>;
        put(setting: SettingRecord): Promise<void>;
    };
    /** Settings of the instance as a whole (not of any workspace). */
    instanceSettings: {
        get(key: string): Promise<unknown | null>;
        put(key: string, value: unknown): Promise<void>;
    };
    modelGrants: {
        get(workspaceId: string): Promise<ModelGrant | null>;
        list(): Promise<ModelGrant[]>;
        put(grant: ModelGrant): Promise<void>;
        delete(workspaceId: string): Promise<void>;
    };
    invites: {
        get(id: string): Promise<Invite | null>;
        /** A workspace's invites, or the instance invites (`null`), newest first. */
        list(workspaceId: string | null): Promise<Invite[]>;
        /** Invites for an email address that haven't been accepted (expired ones included). */
        pendingFor(email: string): Promise<Invite[]>;
        put(invite: Invite): Promise<void>;
        delete(id: string): Promise<void>;
    };
}

export interface Store extends Repos {
    /**
     * Run `fn` so that its reads and writes see one consistent state and its writes apply all together:
     * if it throws, nothing it wrote is kept. Transactions behave as if they ran one at a time.
     *
     * `fn` may be run more than once (Postgres retries a transaction that lost to a concurrent one), so it
     * must have no effects outside the store: anything that should happen once the change is saved, such
     * as announcing it, goes through `afterCommit`.
     *
     * A transaction started inside another joins it rather than nesting: if the inner one throws, the
     * outer one must fail too. Never catch an inner failure and carry on.
     */
    transaction<T>(fn: (tx: Repos) => Promise<T>): Promise<T>;
    /**
     * Run `fn` once the current transaction (the outermost, if they're joined) is saved, and never if it
     * fails or is retried. Outside a transaction, run it now.
     */
    afterCommit(fn: () => void): void;
    /** Quick liveness check for /healthz. */
    ping(): Promise<void>;
    close(): Promise<void>;
}
