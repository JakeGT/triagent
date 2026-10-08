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

export type AuthMode = "local" | "oidc";

/** How people sign in here (GET /auth/config, public). */
export interface AuthConfig {
    mode: AuthMode;
    providerName: string | null;
    inviteHint: string | null;
    signupMode: "invite" | "open";
}

export type TutorialStatus = "pending" | "in_progress" | "completed" | "dismissed";

export interface Me {
    kind: "session";
    user: PublicUser;
    authMode: AuthMode;
    csrf: string;
    mustChangePassword: boolean;
    notify: NotifyPrefs;
    /** The first-run tutorial: where the person is in it, and where their example project is. */
    tutorial: { status: TutorialStatus; step: number; example: { workspace: string; project: string } | null };
    workspaces: WorkspaceSummary[];
}

/** GET /api/v1/me/tutorial */
export interface TutorialView {
    status: TutorialStatus;
    step: number;
    example: { workspace: string; project: string; name: string; issue: string | null } | null;
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
    /** How the branch's report compares with GitHub (when the project is connected). */
    github?: BranchGithub | null;
}

export interface BranchGithub {
    onGitHub: boolean;
    current: boolean;
    githubSha: string | null;
    /** Commits on GitHub since the reviewed one, when known. */
    behind: number | null;
    diverged: boolean;
}

export interface Branches {
    /** Branches on GitHub that have no report yet (when the project is connected). */
    github?: { fetchedAt: string | null; notReviewed: string[] } | null;
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
    reviewPullRequestsFrom: "collaborators" | "everyone";
}

export interface GithubSettings {
    repoUrl: string | null;
    defaultBranch: string;
    connection: { method: "token" | "none"; token: SecretView };
    webhook: { secretSet: boolean; setBy: string | null; setAt: string | null; url: string };
    /** How the project reaches GitHub now: the GitHub App, its own token, or not at all. */
    mode: "app" | "token" | "none";
    app: { available: true; name: string; slug: string; htmlUrl: string } | { available: false };
    installations: Installation[];
    repository: { installationId: number; repositoryId: number; fullName: string } | null;
}

export interface Installation {
    id: number;
    account: string;
    accountType: string;
    repositorySelection: string;
    suspended: boolean;
    linkedBy: string;
    linkedAt: string;
}

export interface InstallationWithRepos extends Installation {
    repositories: { id: number; fullName: string; private: boolean; defaultBranch: string }[];
    error: string | null;
}

export interface GithubDelivery {
    at: string;
    event: string | null;
    deliveryId: string | null;
    what: string | null;
    outcome: "received" | "ignored" | "refused";
    detail: string;
}

export interface GithubAppStatus {
    configured: boolean;
    app: {
        appId: number;
        slug: string;
        name: string;
        clientId: string;
        htmlUrl: string;
        owner: string | null;
        createdAt: string;
        createdBy: string;
    } | null;
    githubUrl: string;
    webhookUrl: string;
    deliveries: GithubDelivery[];
    refused: RefusedDeliveries | null;
}

/** Deliveries refused for a bad or missing signature since the server started: counted, not listed. */
export interface RefusedDeliveries {
    count: number;
    lastAt: string;
    lastReason: string;
}

// ---- runs ----------------------------------------------------------------------------------------

export type RunStatus = "queued" | "running" | "done" | "partial" | "failed" | "cancelled";
export type RunKind = "pr" | "changes" | "full";

export interface RunProgress {
    phase?: string;
    files?: number;
    filesChanged?: number;
    groups?: number;
    current?: string;
    round?: string;
    roundsFailed?: number;
    toolCalls?: number;
    toolFailures?: number;
}

export interface Run {
    id: string;
    project: string | null;
    kind: RunKind;
    title: string;
    branch: string;
    gitRef: string | null;
    baseRef: string | null;
    headSha: string | null;
    baseSha: string | null;
    pr: { number: number; title: string; url: string | null; headRef: string; author: string | null } | null;
    requestedBy: { name: string; userId: string | null };
    source: "person" | "token" | "automation";
    status: RunStatus;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    elapsedSeconds: number | null;
    cancelRequested: { by: string; at: string } | null;
    progress: RunProgress;
    result: {
        total: number | null;
        bySeverity: Record<Severity, number> | null;
        gaps: { groups: number; files: string[]; reasons: string[]; note: string } | null;
        counts: { added: number; carriedOver: number; removed: number; reopened: number } | null;
        tokens: { input: number; output: number; cacheRead: number; total: number } | null;
        github?: string[];
        /** A made-up run in the tutorial's example project: nothing ran. */
        example?: boolean;
    } | null;
    error: string | null;
    model: { provider: string; model: string; keySource: "workspace" | "instance" } | null;
    log: { lines: number; dropped: number };
    /** For a queued run: why it hasn't started. */
    waiting?: string | null;
}

export interface RunList {
    ready: boolean;
    waiting: string | null;
    concurrency: { instance: number; workspace: number };
    /** Listed for instance administrators only; everyone sees `runnersConnected`. */
    runners: { name: string; slots: number; version: string | null; lastSeenAt: string }[];
    runnersConnected: number;
    running: Run[];
    queued: Run[];
    recent: Run[];
    counts: { running: number; queued: number };
}

export interface LogLine {
    seq: number;
    at: string;
    line: string;
}

export interface RunDetail extends Run {
    logLines: LogLine[];
    next: number;
}

export interface PullRequest {
    number: number;
    title: string;
    branch: string;
    headSha: string;
    draft: boolean;
    url: string | null;
    author: string | null;
    reviewedSha: string | null;
    status: string;
    baseline?: boolean;
    reviewed: boolean;
    run: { id: string; status: RunStatus } | null;
    lastDecision: { number: number; title: string; sha: string | null; action: "queued" | "skipped"; why: string } | null;
}

export interface PullRequests {
    connected: boolean;
    mode: "app" | "token" | null;
    repository: string | null;
    automation: { enabled: boolean; pollMinutes: number };
    lastCheck: { at: string; openPulls?: number; error?: string; note?: string; decisions: unknown[] } | null;
    lastError: { at: string; message: string } | null;
    items: PullRequest[];
    deliveries: GithubDelivery[];
    refused: RefusedDeliveries | null;
}

export type ModelProtocol = "openai" | "openai-responses" | "anthropic" | "anthropic-bedrock";

/** A model provider, its settings and whether its secrets are set (never the secrets). */
export interface Provider {
    id: string;
    name: string;
    group: string;
    protocols: ModelProtocol[];
    protocol: ModelProtocol;
    /** Where requests go; null until a URL is given (Azure, custom), and for Bedrock (the region decides). */
    url: string | null;
    /** The URL given, for providers that take one. */
    endpoint: string | null;
    /** Bedrock's AWS region. */
    region: string | null;
    docs: string;
    keyFormat: string | null;
    keysUrl: string | null;
    keyLabel: string;
    listsModels: boolean;
    suggested: string[];
    fields: ("url" | "region" | "accessKeyId")[];
    model: string;
    key: SecretView;
    accessKeyId: SecretView | null;
    ready: boolean;
    /** What it still needs, as "Add …" would finish it. */
    missing: string | null;
}

export interface ReviewModel {
    provider: string;
    model: string | null;
    ready: boolean;
    missing: string | null;
    providers: Provider[];
}

/** A provider's models, fetched by the server with the stored key. */
export interface ModelList {
    provider: string;
    source: "provider" | "openrouter" | "none";
    models: { id: string; name: string | null }[];
    suggested: string[];
    fetchedAt: string | null;
    error: string | null;
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
    signsInWith: "password" | "provider";
    mustChangePassword: boolean;
    sessions: number;
}

export interface Invite {
    id: string;
    email: string;
    /** Null for an invite to have an account (instance invite). */
    role: Role | null;
    status: "pending" | "expired" | "accepted";
    createdAt: string;
    createdBy: { id: string; displayName: string } | null;
    expiresAt: string;
    acceptedAt: string | null;
    acceptedBy: { id: string; displayName: string } | null;
}

export interface InviteList {
    items: Invite[];
    hint: string | null;
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
