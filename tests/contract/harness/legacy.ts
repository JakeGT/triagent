// Runs the contract against the prototype server (the app Triagent is rebuilt from). It isn't in this
// repository: point LEGACY_APP_DIR at a checkout of it. Each test file gets its own server and data folder.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
    Body,
    Caller,
    Finding,
    Query,
    Reply,
    Report,
    Role,
    SessionCaller,
    Target,
    TokenCaller,
    TokenScope,
    UploadInput,
} from "./types.ts";

const ADMIN = "admin";

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            srv.close(() => (addr && typeof addr === "object" ? resolve(addr.port) : reject(new Error("No port"))));
        });
    });
}

const password = () => `pw-${randomBytes(18).toString("base64url")}`;
const enc = encodeURIComponent;

export class LegacyTarget implements Target {
    readonly name = "legacy";
    readonly defaultProject = "default";
    readonly defaultBranch = "main";
    private readonly base: string;
    private readonly child: ChildProcess;
    private readonly dataDir: string;
    private readonly adminPassword: string;
    private readonly output: string[];
    private adminCaller: SessionCaller | null = null;
    private seq = 0;

    private constructor(base: string, child: ChildProcess, dataDir: string, adminPassword: string, output: string[]) {
        this.base = base;
        this.child = child;
        this.dataDir = dataDir;
        this.adminPassword = adminPassword;
        this.output = output;
    }

    static async start(): Promise<LegacyTarget> {
        const appDir = process.env.LEGACY_APP_DIR;
        if (!appDir) throw new Error("Set LEGACY_APP_DIR to the prototype app's folder (the one with server.mjs).");
        const port = await freePort();
        const dataDir = await mkdtemp(path.join(tmpdir(), "triagent-legacy-"));
        const adminPassword = password();
        const base = `http://127.0.0.1:${port}`;
        const output: string[] = [];
        const child = spawn(process.execPath, ["server.mjs"], {
            cwd: appDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                PATH: process.env.PATH,
                HOME: dataDir,
                DATA_DIR: dataDir,
                HOST: "127.0.0.1",
                PORT: String(port),
                PUBLIC_ORIGIN: base,
                COOKIE_SECURE: "false",
                OCR_ADMIN_USER: ADMIN,
                OCR_ADMIN_PASSWORD: adminPassword,
                OCR_UPDATE_CHECK: "false",
                REQUESTS_PER_MINUTE: "100000",
                // Nothing in the contract may reach GitHub, the GitHub CLI or OCR.
                GH_BIN: "/nonexistent/gh",
                OCR_BIN: "/nonexistent/ocr",
                GITHUB_API_URL: "http://127.0.0.1:9",
            },
        });
        for (const stream of [child.stdout, child.stderr]) stream?.on("data", (d: Buffer) => output.push(d.toString()));
        const target = new LegacyTarget(base, child, dataDir, adminPassword, output);
        await target.waitUntilReady();
        return target;
    }

    private async waitUntilReady(): Promise<void> {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            if (this.child.exitCode !== null) break;
            try {
                if ((await fetch(`${this.base}/healthz`)).ok) return;
            } catch {
                // not listening yet
            }
            await new Promise((r) => setTimeout(r, 100));
        }
        await this.close();
        throw new Error(`The prototype server didn't start.\n${this.output.join("")}`);
    }

    async close(): Promise<void> {
        if (this.child.exitCode === null) {
            const exited = new Promise((r) => this.child.once("exit", r));
            this.child.kill("SIGTERM");
            await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
            if (this.child.exitCode === null) this.child.kill("SIGKILL");
        }
        await rm(this.dataDir, { recursive: true, force: true });
    }

    // ---- HTTP ---------------------------------------------------------------------

    private async request(
        c: Caller,
        method: string,
        pathAndQuery: string,
        body?: unknown,
        extra: Record<string, string> = {},
    ): Promise<Reply> {
        const headers: Record<string, string> = { ...extra };
        if (body !== undefined) headers["content-type"] = "application/json";
        if (c.kind === "session") {
            headers.cookie = c.cookie;
            if (c.csrf) headers["x-csrf-token"] = c.csrf;
            if (c.origin) headers.origin = c.origin;
        } else if (c.kind === "token") {
            headers.authorization = `Bearer ${c.token}`;
        }
        const res = await fetch(`${this.base}${pathAndQuery}`, {
            method,
            headers,
            redirect: "manual",
            body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        });
        const text = await res.text();
        let parsed: Body = text;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            // not JSON: keep the text
        }
        return { status: res.status, body: parsed };
    }

    private q(project: string, branch?: string, extra: Query = {}): string {
        const params = new URLSearchParams({ project, ...(branch ? { branch } : {}), ...extra });
        return `?${params}`;
    }

    // ---- people and tokens ----------------------------------------------------------

    private async signIn(username: string, pw: string): Promise<SessionCaller> {
        const res = await fetch(`${this.base}/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: this.base },
            body: JSON.stringify({ username, password: pw }),
        });
        if (res.status !== 200) throw new Error(`Sign-in as ${username} failed: ${res.status} ${await res.text()}`);
        const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        const caller: SessionCaller = { kind: "session", name: username, cookie, csrf: null, origin: this.base };
        const session = await this.request(caller, "GET", "/api/session");
        caller.csrf = session.body?.csrf ?? null;
        return caller;
    }

    async admin(): Promise<SessionCaller> {
        this.adminCaller ??= await this.signIn(ADMIN, this.adminPassword);
        return { ...this.adminCaller };
    }

    async user(role: Role): Promise<SessionCaller> {
        const username = `${role}${++this.seq}`;
        const temporary = password();
        const created = await this.request(await this.admin(), "POST", "/api/users", { username, password: temporary, role });
        if (created.status !== 201) throw new Error(`Couldn't create ${username}: ${JSON.stringify(created.body)}`);
        // Accounts made by an admin must choose their own password before anything else.
        const caller = await this.signIn(username, temporary);
        const changed = await this.request(caller, "POST", "/api/account/password", { current: temporary, password: password() });
        if (changed.status !== 200) throw new Error(`Couldn't set ${username}'s password: ${JSON.stringify(changed.body)}`);
        return caller;
    }

    async token(owner: SessionCaller, scope: TokenScope): Promise<TokenCaller> {
        const r = await this.createToken(owner, scope);
        if (r.status !== 201) throw new Error(`Couldn't create a ${scope} token: ${JSON.stringify(r.body)}`);
        return { kind: "token", name: r.body.record.name, token: r.body.token };
    }

    createToken(c: Caller, scope: TokenScope): Promise<Reply> {
        return this.request(c, "POST", "/api/tokens", { name: `${scope}-agent-${++this.seq}`, scope });
    }

    listTokens(c: Caller): Promise<Reply> {
        return this.request(c, "GET", "/api/tokens");
    }

    // ---- projects -------------------------------------------------------------------

    createProject(c: Caller, id: string, name?: string): Promise<Reply> {
        return this.request(c, "POST", "/api/projects", { id, name: name ?? id });
    }

    deleteProject(c: Caller, id: string): Promise<Reply> {
        return this.request(c, "DELETE", `/api/projects/${enc(id)}`);
    }

    // ---- reports and branches -------------------------------------------------------

    upload(c: Caller, project: string, input: UploadInput): Promise<Reply> {
        return this.request(c, "POST", `/api/review${this.q(project)}`, { fileName: "code_review.json", ...input });
    }

    previewUpload(c: Caller, project: string, input: UploadInput): Promise<Reply> {
        return this.request(c, "POST", `/api/review/preview${this.q(project)}`, { fileName: "code_review.json", ...input });
    }

    branches(c: Caller, project: string): Promise<Reply> {
        return this.request(c, "GET", `/api/branches${this.q(project)}`);
    }

    moveBranch(c: Caller, project: string, body: { from: string; to: string; makeDefault?: boolean }): Promise<Reply> {
        return this.request(c, "POST", `/api/branches/move${this.q(project)}`, body);
    }

    deleteBranch(c: Caller, project: string, body: { branch: string; confirm?: boolean }): Promise<Reply> {
        return this.request(c, "POST", `/api/branches/delete${this.q(project)}`, body);
    }

    createUploadLink(c: Caller, project: string, body: { branch: string; confirm?: boolean }): Promise<Reply> {
        return this.request(c, "POST", `/api/review/links${this.q(project)}`, body);
    }

    async useUploadLink(url: string, report: Report): Promise<Reply> {
        const pathAndQuery = new URL(url).pathname;
        return this.request({ kind: "anonymous" }, "POST", pathAndQuery, JSON.stringify(report), { "content-type": "application/json" });
    }

    // ---- issues ---------------------------------------------------------------------

    listIssues(c: Caller, project: string, branch: string, query: Query = {}): Promise<Reply> {
        return this.request(c, "GET", `/api/issues${this.q(project, branch, { limit: "1000", ...query })}`);
    }

    getIssue(c: Caller, project: string, branch: string, id: string): Promise<Reply> {
        return this.request(c, "GET", `/api/issues/${enc(id)}${this.q(project, branch)}`);
    }

    updateIssue(c: Caller, project: string, branch: string, id: string, patch: Record<string, unknown>): Promise<Reply> {
        return this.request(c, "PATCH", `/api/issues/${enc(id)}${this.q(project, branch)}`, patch);
    }

    bulkUpdate(c: Caller, project: string, branch: string, body: Record<string, unknown>): Promise<Reply> {
        return this.request(c, "POST", `/api/issues/bulk${this.q(project, branch)}`, body);
    }

    claimNext(c: Caller, project: string, branch: string, body: Record<string, unknown> = {}): Promise<Reply> {
        return this.request(c, "POST", `/api/issues/claim${this.q(project, branch)}`, body);
    }

    releaseIssue(c: Caller, project: string, branch: string, id: string, body: Record<string, unknown> = {}): Promise<Reply> {
        return this.request(c, "POST", `/api/issues/${enc(id)}/release${this.q(project, branch)}`, body);
    }

    addFinding(c: Caller, project: string, branch: string, finding: Finding): Promise<Reply> {
        return this.request(c, "POST", `/api/issues${this.q(project, branch)}`, finding);
    }

    editNote(c: Caller, project: string, branch: string, issueId: string, noteId: string, text: string): Promise<Reply> {
        return this.request(c, "PATCH", `/api/issues/${enc(issueId)}/notes/${enc(noteId)}${this.q(project, branch)}`, { text });
    }

    deleteNote(c: Caller, project: string, branch: string, issueId: string, noteId: string): Promise<Reply> {
        return this.request(c, "DELETE", `/api/issues/${enc(issueId)}/notes/${enc(noteId)}${this.q(project, branch)}`);
    }

    // ---- GitHub ---------------------------------------------------------------------

    generateWebhookSecret(c: Caller, project: string): Promise<Reply> {
        return this.request(c, "PUT", `/api/github${this.q(project)}`, { webhookSecret: "generate" });
    }

    githubSettings(c: Caller, project: string): Promise<Reply> {
        return this.request(c, "GET", `/api/github${this.q(project)}`);
    }

    deliverWebhook(project: string, delivery: { event: string; body: string; signature: string | null }): Promise<Reply> {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-github-event": delivery.event,
            "x-github-delivery": randomBytes(8).toString("hex"),
        };
        if (delivery.signature !== null) headers["x-hub-signature-256"] = delivery.signature;
        return this.request({ kind: "anonymous" }, "POST", `/api/github/webhook/${enc(project)}`, delivery.body, headers);
    }

    // ---- MCP ------------------------------------------------------------------------

    mcp(c: Caller, message: Record<string, unknown>): Promise<Reply> {
        return this.request(c, "POST", "/mcp", { jsonrpc: "2.0", ...message });
    }
}
