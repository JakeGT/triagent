// Response shapes of the v1 API, mirroring apps/server (services/*.ts and domain/branch.ts). The
// vocabulary (severities, roles, permissions…) comes from @triagent/shared.

import type { Category, Grant, ReportScope, Role, RunOptions, Severity, Status, TokenScope, Via } from "@triagent/shared";

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
    tutorial: {
        status: TutorialStatus;
        step: number;
        example: { workspace: string; project: string } | null;
        /** Account setup: offered after the tutorial until it's done. */
        setup: "pending" | "done";
    };
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
    /** The models that found it, when the review ran with several; null otherwise. */
    foundBy: string[] | null;
    sourceUrl: string | null;
    noteCount: number;
    rev: number;
    needsDiscussion: boolean;
    duplicateOf: string | null;
    duplicateCount: number;
    updatedAt: string | null;
}

export interface OtherFinding {
    model: string;
    severity: Severity | null;
    category: Category | null;
    startLine: number | null;
    endLine: number | null;
    content: string;
    suggestionCode: string | null;
}

export interface IssueDetail extends IssueSummary {
    content: string;
    existingCode: string | null;
    suggestionCode: string | null;
    /** What the other models that found it said (reviews run with several). */
    alsoFound: OtherFinding[];
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
    /** The models the review ran with, when it ran with several. */
    models?: string[] | null;
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
    /** The models the review ran with, when it ran with several. */
    models: string[] | null;
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
    /** Null: no time limit. */
    reviewTimeoutMinutes: number | null;
    fullScanTimeoutMinutes: number | null;
    /** Stop a review whose model has printed nothing for this long; null to never. */
    stallMinutes: number | null;
    reviewPullRequestsFrom: "collaborators" | "everyone";
    /** When a pull request's first review happens by itself: once its checks pass, as soon as it's ready, or never. */
    firstReview: "checks" | "ready" | "manual";
    /** Patterns for files that don't need a review. */
    skipPaths: string[];
    skipBots: boolean;
    /** The models reviews run with: favourite models' ids (or "instance"), for every review and for each kind. A set left out falls through. */
    models: ProjectModels;
    /** Options for reviews run with several models, for those that don't choose their own. Anything left out is off. */
    options: ProjectOptions;
}

/** A review's options as they're asked for (anything left out is off), and a project's own. */
export type RunOptionsInput = Record<string, never>;
export type ProjectOptions = RunOptionsInput;

/** A project's sets of models: for every review, or for one kind of review (which wins). */
export const MODEL_SETS = ["all", "pr", "changes", "full"] as const;
export type ModelSet = (typeof MODEL_SETS)[number];
export type ProjectModels = Partial<Record<ModelSet, string[]>>;

/** The instance's model, chosen like a favourite when the workspace has an allowance. */
export interface InstanceModel {
    id: "instance";
    provider: string;
    providerName: string;
    model: string | null;
    name: string;
    ready: boolean;
    /** Why it can't be used now. */
    reason: string | null;
}

/** What reviews can run with (GET …/models), and for a project what each kind of review uses when a run doesn't choose. */
export interface ModelChoices {
    favourites: Favourite[];
    defaultId: string | null;
    instance: InstanceModel | null;
    /** How many models one review can use. */
    max: number;
    /** With nothing chosen anywhere: the default favourite, or the instance's model. */
    fallback: string[];
    rules?: Record<RunKind, { ids: string[]; from: "kind" | "project" | "default" }>;
}

export interface GithubSettings {
    repoUrl: string | null;
    defaultBranch: string;
    connection: { method: "token" | "none"; token: SecretView };
    webhook: { secretSet: boolean; setBy: string | null; setAt: string | null; url: string };
    /** How the project reaches GitHub now: the GitHub App, its own token, or not at all. */
    mode: "app" | "token" | "none";
    /** False once GitHub has refused to show this connection a commit's check runs; null until it's been asked. */
    checksReadable: boolean | null;
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
    /** The most model tokens the review has said it used so far. */
    tokens?: number;
    /** With several models: how many, and how many have finished, e.g. "3 models (1 finished)". */
    model?: string;
    /** With several models: each one's own progress, in the run's order. The fields above are all of them together. */
    models?: RunModelProgress[];
}

/** Why a model's review was stopped before it finished: it went quiet, or passed the time limit or its token budget. */
export type StopReason = "stalled" | "timeLimit" | "overBudget";

/** One model's progress in a review with several: waiting for its turn, reviewing, or how it ended. */
export interface RunModelProgress {
    label?: string;
    /** "waiting", then the review's own phases, then "done", "failed" or "cancelled". */
    phase?: string;
    files?: number;
    round?: string;
    tokens?: number;
    /** How long it has been going, or took. */
    seconds?: number;
    reason?: StopReason | string;
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
        gaps: { groups: number; files: string[]; reasons: string[]; models?: string[]; note: string } | null;
        counts: { added: number; carriedOver: number; removed: number; reopened: number } | null;
        tokens: { input: number; output: number; cacheRead: number; total: number } | null;
        github?: string[];
        /** A review run with several models: how each went. */
        models?: {
            label: string;
            provider: string;
            model: string;
            status: "done" | "partial" | "failed" | "cancelled";
            total: number | null;
            tokens: number | null;
            seconds: number | null;
            error: string | null;
            /** Why it was stopped, if it was. Absent on older runs. */
            reason?: StopReason | null;
        }[];
        /** A made-up run in the tutorial's example project: nothing ran. */
        example?: boolean;
    } | null;
    error: string | null;
    /** The models it was asked to use (favourite models' ids, or "instance"); null for the project's own. */
    requestedModels: string[] | null;
    /** Its options for several models: those asked for while it's queued, those it runs with after. Null for none, or the project's. */
    options: RunOptions | null;
    /** What it ran with, as it was then. */
    model: {
        provider: string;
        model: string;
        /** How people knew it: the favourite's nickname, or its name. Absent on older runs. */
        label?: string;
        keySource: "workspace" | "instance";
        /** Every model, when it runs with several. */
        models?: { provider: string; model: string; label: string; keySource?: "workspace" | "instance" }[];
    } | null;
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
    /** Commits pushed since the reviewed one, when GitHub could say. */
    commitsSince?: number | null;
    run: { id: string; status: RunStatus } | null;
    lastDecision: {
        number: number;
        title: string;
        sha: string | null;
        action: "queued" | "skipped" | "waiting";
        code?: string;
        why: string;
    } | null;
}

export interface PullRequests {
    connected: boolean;
    mode: "app" | "token" | null;
    repository: string | null;
    automation: { enabled: boolean; pollMinutes: number; firstReview: Automation["firstReview"] };
    /** False once GitHub has refused to show this connection check runs: reviews then start when ready. */
    checksReadable: boolean | null;
    /** What the last scheduled scan did. */
    scheduledScan: { at: string; action: "queued" | "skipped"; why: string } | null;
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
    /** In use: set up at all (a key, an address, a region), or the provider of a favourite. */
    connected: boolean;
    /** What the provider itself still needs, whichever model is used with it. */
    needs: string | null;
}

/** A model in use: a provider's model, with a nickname if it has one. Its id never changes. */
export interface Favourite {
    id: string;
    provider: string;
    providerName: string;
    model: string;
    name: string | null;
    isDefault: boolean;
    ready: boolean;
    /** What it still needs, as "Add …" would finish it. */
    missing: string | null;
}

export interface ReviewModel {
    /** The default favourite's provider and model. */
    provider: string;
    model: string | null;
    ready: boolean;
    missing: string | null;
    providers: Provider[];
    favourites: Favourite[];
    defaultId: string | null;
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
    via: Via;
    fields: string[];
    clientId?: string;
}
