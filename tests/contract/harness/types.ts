// The contract every Triagent server must meet, written as operations rather than URLs, so the same
// tests run against the prototype (to pin its behaviour down) and against each rebuilt API.

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field in the tests
export type Body = any;

export interface Reply {
    status: number;
    body: Body;
}

export type Role = "viewer" | "editor" | "admin";
export type TokenScope = "read" | "write" | "upload" | "full" | "manage";

/** A person signed in through the browser. Set `csrf` or `origin` to null (the header is then left out) or change it to test request forgery. */
export interface SessionCaller {
    kind: "session";
    name: string;
    cookie: string;
    csrf: string | null;
    origin: string | null;
}

/** An agent, CI job or script using an API token. */
export interface TokenCaller {
    kind: "token";
    name: string;
    token: string;
}

export interface Anonymous {
    kind: "anonymous";
}

export type Caller = SessionCaller | TokenCaller | Anonymous;

/** One finding in an Open Code Review JSON report (the format OCR writes). */
export interface Finding {
    path: string;
    content: string;
    severity?: string;
    category?: string;
    start_line?: number;
    end_line?: number;
    existing_code?: string;
    suggestion_code?: string;
}

export interface Report {
    comments: Finding[];
    project_summary?: string;
    status?: string;
}

export interface UploadInput {
    branch: string;
    report: Report | Record<string, unknown>;
    commit?: string;
    confirm?: boolean;
    reopen?: boolean;
}

export type Query = Record<string, string>;

export interface Target {
    readonly name: string;
    /** A project that always exists and can't be deleted, if the target has one. */
    readonly defaultProject: string | null;
    readonly defaultBranch: string;
    close(): Promise<void>;

    // People and tokens
    admin(): Promise<SessionCaller>;
    /** A new account with this role, signed in and ready to use (any first-sign-in steps done). */
    user(role: Role): Promise<SessionCaller>;
    /** A new API token with this scope, created by `owner`. */
    token(owner: SessionCaller, scope: TokenScope): Promise<TokenCaller>;
    createToken(c: Caller, scope: TokenScope): Promise<Reply>;
    /** The reply's body has `items`, one per token. */
    listTokens(c: Caller): Promise<Reply>;

    // Projects
    createProject(c: Caller, id: string, name?: string): Promise<Reply>;
    deleteProject(c: Caller, id: string): Promise<Reply>;

    // Reports and branches
    upload(c: Caller, project: string, input: UploadInput): Promise<Reply>;
    previewUpload(c: Caller, project: string, input: UploadInput): Promise<Reply>;
    branches(c: Caller, project: string): Promise<Reply>;
    moveBranch(c: Caller, project: string, body: { from: string; to: string; makeDefault?: boolean }): Promise<Reply>;
    deleteBranch(c: Caller, project: string, body: { branch: string; confirm?: boolean }): Promise<Reply>;
    /** A single-use link that accepts one raw OCR JSON file. The reply's body has `url`. */
    createUploadLink(c: Caller, project: string, body: { branch: string; confirm?: boolean }): Promise<Reply>;
    useUploadLink(url: string, report: Report): Promise<Reply>;

    // Issues
    listIssues(c: Caller, project: string, branch: string, query?: Query): Promise<Reply>;
    getIssue(c: Caller, project: string, branch: string, id: string): Promise<Reply>;
    updateIssue(c: Caller, project: string, branch: string, id: string, patch: Record<string, unknown>): Promise<Reply>;
    bulkUpdate(c: Caller, project: string, branch: string, body: Record<string, unknown>): Promise<Reply>;
    claimNext(c: Caller, project: string, branch: string, body?: Record<string, unknown>): Promise<Reply>;
    releaseIssue(c: Caller, project: string, branch: string, id: string, body?: Record<string, unknown>): Promise<Reply>;
    addFinding(c: Caller, project: string, branch: string, finding: Finding): Promise<Reply>;
    editNote(c: Caller, project: string, branch: string, issueId: string, noteId: string, text: string): Promise<Reply>;
    deleteNote(c: Caller, project: string, branch: string, issueId: string, noteId: string): Promise<Reply>;

    // GitHub
    /** Create a new webhook secret for the project. The reply's body has `webhookSecret`, shown this once. */
    generateWebhookSecret(c: Caller, project: string): Promise<Reply>;
    githubSettings(c: Caller, project: string): Promise<Reply>;
    deliverWebhook(project: string, delivery: { event: string; body: string; signature: string | null }): Promise<Reply>;

    // MCP (JSON-RPC over HTTP)
    mcp(c: Caller, message: Record<string, unknown>): Promise<Reply>;
}
