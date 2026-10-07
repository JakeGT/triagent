// Response shapes of the v1 API, mirroring apps/server (services/*.ts and domain/branch.ts). The
// vocabulary (severities, roles, permissions…) comes from @triagent/shared.

import type { Category, Grant, ReportScope, Role, Severity, Status, TokenScope, Via } from "@triagent/shared";

export interface ApiErrorBody {
    error: string;
    code?: string;
    current?: unknown;
    [key: string]: unknown;
}

export interface PublicUser {
    id: string;
    username: string | null;
    displayName: string;
    email: string | null;
    isInstanceAdmin: boolean;
    createdAt: string;
    lastLoginAt: string | null;
}

export interface WorkspaceSummary {
    id: string;
    slug: string;
    name: string;
    kind: "personal" | "org";
    createdAt: string;
    role?: Role;
}

export interface NotifyPrefs {
    scope: "mine" | "all" | "none";
    problemsOnly: boolean;
}

export interface Me {
    kind: "session";
    user: PublicUser;
    authMode: "local";
    csrf: string;
    mustChangePassword: boolean;
    notify: NotifyPrefs;
    workspaces: WorkspaceSummary[];
}

export interface WorkspaceDetail extends WorkspaceSummary {
    access: Grant;
}

export interface Project {
    id: string;
    slug: string;
    name: string;
    repoUrl: string | null;
    defaultBranch: string;
    createdAt: string;
}

export interface ProjectListItem extends Project {
    branches: number;
    findings: number;
}

export interface Branch {
    name: string;
    isDefault: boolean;
    fileName: string;
    uploadedAt: string;
    uploadedBy: string;
    commit: string | null;
    scope: ReportScope;
    issues: number;
    unresolved: number;
    inProgress: number;
    done: number;
}

export interface Branches {
    defaultBranch: string;
    items: Branch[];
}

export interface Note {
    id: string;
    at: string;
    by: string;
    authorKey: string;
    text: string;
    editedAt?: string;
    editedBy?: string;
}

export interface IssueSummary {
    id: string;
    index: number;
    severity: Severity;
    category: Category;
    reviewerSeverity: Severity | null;
    reviewerCategory: Category | null;
    status: Status;
    assignee: string | null;
    path: string;
    startLine: number | null;
    endLine: number | null;
    title: string;
    hasSuggestion: boolean;
    addedBy: string | null;
    sourceUrl: string | null;
    noteCount: number;
    rev: number;
    needsDiscussion: boolean;
    duplicateOf: string | null;
    duplicateCount: number;
    updatedAt: string | null;
}

export interface IssueDetail extends IssueSummary {
    content: string;
    existingCode: string | null;
    suggestionCode: string | null;
    notes: Note[];
    duplicates: { id: string; title: string; path: string; startLine: number | null }[];
    duplicateOfTitle: string | null;
    updatedBy: string | null;
    tasks: { id: string; section: string; title: string }[];
}

export interface Counts {
    severity: Record<Severity, number>;
    category: Record<Category, number>;
    status: Record<Status, number>;
}

export interface IssueList {
    branch: string;
    total: number;
    offset: number;
    limit: number;
    counts: Counts;
    items: IssueSummary[];
}

export interface TaskSummary {
    id: string;
    sectionId: string;
    section: string;
    position: number;
    title: string;
    markdown: string;
    status: Status;
    assignee: string | null;
    files: string[];
    issueCount: number;
    issuesDone: number;
    issueStatus: Record<Status, number>;
    noteCount: number;
    rev: number;
    updatedAt: string | null;
}

export interface TaskDetail extends TaskSummary {
    body: string;
    notes: Note[];
    updatedBy: string | null;
    issues: IssueSummary[];
}

export interface TaskList {
    branch: string;
    sections: { id: string; title: string; taskCount: number }[];
    total: number;
    items: TaskSummary[];
}

export interface FileRow {
    path: string;
    total: number;
    open: number;
    weight: number;
    severity: Record<Severity, number>;
    status: Record<Status, number>;
    tasks: string[];
}

export interface FileList {
    total: number;
    items: FileRow[];
}

export interface UploadMeta {
    id: string;
    branch: string;
    commit: string | null;
    fileName: string;
    uploadedAt: string;
    uploadedBy: string;
    sha256: string | null;
    scope: ReportScope;
}

export interface ReviewMeta {
    loaded: boolean;
    upload: UploadMeta | null;
    status: unknown;
    sessionId: unknown;
    llm: unknown;
    summary: unknown;
    warnings: { file: string; message: string; type: string }[];
}

export interface ActivityRow {
    id: string;
    workspaceId: string;
    projectId: string | null;
    project?: string | null;
    branch: string | null;
    at: string;
    actor: string;
    actorUserId: string | null;
    via: Via;
    kind: string;
    itemId: string;
    changes: Record<string, unknown>;
}

export interface Overview {
    branch: string;
    meta: ReviewMeta;
    flags: { needsDiscussion: number; duplicates: number };
    totals: { issues: number; files: number; tasks: number; done: number; remaining: number };
    status: Record<Status, number>;
    bySeverity: ({ severity: Severity; total: number } & Record<Status, number>)[];
    byCategory: ({ category: Category; total: number; done: number } & Record<Severity, number>)[];
    hotspots: FileRow[];
    themesTitle: string | null;
    themes: TaskSummary[];
    grid: [string, Severity, Status, string][];
    recentActivity: ActivityRow[];
}

export interface Summary {
    markdown: string;
    sections: { id: string; title: string; intro: string; taskIds: string[] }[];
}

export interface History {
    branch: string;
    current: ReviewMeta | null;
    archived: { upload: UploadMeta; archivedAt: string; reason: "replaced" | "deleted"; findings: number }[];
}

export interface Comparison {
    base: string;
    head: string;
    headScope: ReportScope;
    added: { total: number; severity: Record<Severity, number>; items: IssueSummary[] };
    gone: { total: number; severity: Record<Severity, number>; items: IssueSummary[] };
    shared: { total: number; doneOnBase: number; doneOnHead: number };
}

/** What uploading a report would do (the preview, and the 409 asking for confirmation). */
export interface UploadPreview {
    current: { loaded: boolean; fileName: string | null; issues: number; unresolved: number; inProgress: number };
    next: { issues: number; files: number; tasks: number; bySeverity: Record<Severity, number> };
    carriedOver: number;
    withTriage: number;
    added: number;
    removed: number;
    removedUnresolved: number;
    requiresConfirmation: boolean;
    stillReportedResolved: number;
    branch: string;
    newBranch: boolean;
    identical: boolean;
    reopen: boolean;
    keptAdded: number;
}

export interface UploadResult extends Omit<UploadPreview, "current"> {
    ok: true;
    reopened: number;
    current: ReviewMeta;
}

export interface SecretView {
    name: string;
    set: boolean;
    hint: string | null;
    setBy: string | null;
    setAt: string | null;
}

export interface Automation {
    enabled: boolean;
    pollMinutes: number;
    nightlyHourUtc: number | null;
    failOnCritical: boolean;
    maxTokensBudget: number | null;
    archiveDeletedBranches: boolean;
    reviewTimeoutMinutes: number;
    fullScanTimeoutMinutes: number;
}

export interface GithubSettings {
    repoUrl: string | null;
    defaultBranch: string;
    connection: { method: "token" | "none"; token: SecretView };
    webhook: { secretSet: boolean; setBy: string | null; setAt: string | null; url: string };
}

export interface Provider {
    id: string;
    name: string;
    url: string;
    defaultModel: string;
    keysUrl: string | null;
    model: string;
    key: SecretView;
}

export interface ReviewModel {
    provider: string;
    model: string | null;
    ready: boolean;
    providers: Provider[];
}

export interface Member {
    user: PublicUser;
    role: Role;
    since: string;
}

export interface ApiToken {
    id: string;
    workspaceId: string;
    ownerUserId: string | null;
    name: string;
    scope: TokenScope;
    prefix: string;
    createdAt: string;
    createdBy: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    owner: { id: string; displayName: string } | null;
}

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

export interface InstanceUser extends PublicUser {
    mustChangePassword: boolean;
    sessions: number;
}

/** A `change` notice from the live event stream. */
export interface LiveEvent {
    seq: number;
    at: string;
    workspace: string;
    project: string | null;
    branch: string | null;
    kind: string;
    id: string;
    actor: string;
    via: string;
    fields: string[];
    clientId?: string;
}
