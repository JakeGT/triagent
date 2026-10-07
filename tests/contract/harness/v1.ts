// Runs the contract against the rebuilt server (apps/server). Each test file starts its own server; the
// tests work in an organisation workspace the admin creates, so members can be added with any role.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/server/src/main.ts");
const ADMIN = "admin";
const WORKSPACE = "contract";

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

/** The contract's findings use OCR's spelling; the API's add-finding body uses camelCase. */
function findingBody(f: Finding): Record<string, unknown> {
    const { start_line, end_line, existing_code, suggestion_code, ...rest } = f;
    return { ...rest, startLine: start_line, endLine: end_line, existingCode: existing_code, suggestionCode: suggestion_code };
}

export class V1Target implements Target {
    readonly name = "v1";
    readonly defaultProject = null;
    readonly defaultBranch = "main";
    private readonly base: string;
    private readonly child: ChildProcess;
    private readonly adminPassword: string;
    private readonly output: string[];
    private adminCaller: SessionCaller | null = null;
    private readonly hooks = new Map<string, string>();
    private seq = 0;

    private constructor(base: string, child: ChildProcess, adminPassword: string, output: string[]) {
        this.base = base;
        this.child = child;
        this.adminPassword = adminPassword;
        this.output = output;
    }

    static async start(): Promise<V1Target> {
        const port = await freePort();
        const base = `http://127.0.0.1:${port}`;
        const adminPassword = password();
        const output: string[] = [];
        const child = spawn(process.execPath, [SERVER], {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                PATH: process.env.PATH,
                HOST: "127.0.0.1",
                PORT: String(port),
                PUBLIC_ORIGIN: base,
                COOKIE_SECURE: "false",
                TRIAGENT_ADMIN_USER: ADMIN,
                TRIAGENT_ADMIN_PASSWORD: adminPassword,
                TRIAGENT_SECRETS_KEY: randomBytes(32).toString("base64"),
                REQUESTS_PER_MINUTE: "100000",
            },
        });
        for (const stream of [child.stdout, child.stderr]) stream?.on("data", (d: Buffer) => output.push(d.toString()));
        const target = new V1Target(base, child, adminPassword, output);
        await target.waitUntilReady();
        const created = await target.request(await target.admin(), "POST", "/api/v1/workspaces", {
            slug: WORKSPACE,
            name: "Contract tests",
        });
        if (created.status !== 201) throw new Error(`Couldn't create the test workspace: ${JSON.stringify(created.body)}`);
        return target;
    }

    private async waitUntilReady(): Promise<void> {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && this.child.exitCode === null) {
            try {
                if ((await fetch(`${this.base}/healthz`)).ok) return;
            } catch {
                // not listening yet
            }
            await new Promise((r) => setTimeout(r, 100));
        }
        await this.close();
        throw new Error(`The server didn't start.\n${this.output.join("")}`);
    }

    async close(): Promise<void> {
        if (this.child.exitCode !== null) return;
        const exited = new Promise((r) => this.child.once("exit", r));
        this.child.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
        if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }

    private async request(
        c: Caller,
        method: string,
        pathAndQuery: string,
        body?: unknown,
        extra: Record<string, string> = {},
    ): Promise<Reply> {
        const headers: Record<string, string> = { ...extra };
        if (body !== undefined) headers["content-type"] ??= "application/json";
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
            // not JSON
        }
        return { status: res.status, body: parsed };
    }

    private w = (rest = "") => `/api/v1/w/${WORKSPACE}${rest}`;
    private p = (project: string, rest = "", query: Query = {}) => {
        const qs = new URLSearchParams(query).toString();
        return `${this.w(`/p/${enc(project)}${rest}`)}${qs ? `?${qs}` : ""}`;
    };

    // ---- people and tokens ----------------------------------------------------------------

    private async signIn(username: string, pw: string): Promise<SessionCaller> {
        const res = await fetch(`${this.base}/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: this.base },
            body: JSON.stringify({ username, password: pw }),
        });
        if (res.status !== 200) throw new Error(`Sign-in as ${username} failed: ${res.status} ${await res.text()}`);
        const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        const caller: SessionCaller = { kind: "session", name: username, cookie, csrf: null, origin: this.base };
        caller.csrf = (await this.request(caller, "GET", "/api/v1/me")).body?.csrf ?? null;
        return caller;
    }

    async admin(): Promise<SessionCaller> {
        this.adminCaller ??= await this.signIn(ADMIN, this.adminPassword);
        return { ...this.adminCaller };
    }

    async user(role: Role): Promise<SessionCaller> {
        const username = `${role}${++this.seq}`;
        const temporary = password();
        const admin = await this.admin();
        const created = await this.request(admin, "POST", "/api/v1/instance/users", { username, password: temporary });
        if (created.status !== 201) throw new Error(`Couldn't create ${username}: ${JSON.stringify(created.body)}`);
        const caller = await this.signIn(username, temporary);
        const changed = await this.request(caller, "POST", "/api/v1/me/password", { current: temporary, password: password() });
        if (changed.status !== 200) throw new Error(`Couldn't set ${username}'s password: ${JSON.stringify(changed.body)}`);
        const added = await this.request(admin, "POST", this.w("/settings/members"), { username, role });
        if (added.status !== 201) throw new Error(`Couldn't add ${username}: ${JSON.stringify(added.body)}`);
        return caller;
    }

    async token(owner: SessionCaller, scope: TokenScope): Promise<TokenCaller> {
        const r = await this.createToken(owner, scope);
        if (r.status !== 201) throw new Error(`Couldn't create a ${scope} token: ${JSON.stringify(r.body)}`);
        return { kind: "token", name: r.body.record.name, token: r.body.token };
    }

    createToken(c: Caller, scope: TokenScope): Promise<Reply> {
        return this.request(c, "POST", this.w("/settings/tokens"), { name: `${scope}-agent-${++this.seq}`, scope });
    }

    listTokens(c: Caller): Promise<Reply> {
        return this.request(c, "GET", this.w("/settings/tokens"));
    }

    // ---- projects ---------------------------------------------------------------------------

    createProject(c: Caller, id: string, name?: string): Promise<Reply> {
        return this.request(c, "POST", this.w("/projects"), { slug: id, name: name ?? id });
    }

    deleteProject(c: Caller, id: string): Promise<Reply> {
        return this.request(c, "DELETE", this.p(id), { confirm: id });
    }

    // ---- reports and branches ------------------------------------------------------------------

    upload(c: Caller, project: string, input: UploadInput): Promise<Reply> {
        return this.request(c, "POST", this.p(project, "/reports"), { fileName: "code_review.json", ...input });
    }

    previewUpload(c: Caller, project: string, input: UploadInput): Promise<Reply> {
        return this.request(c, "POST", this.p(project, "/reports/preview"), { fileName: "code_review.json", ...input });
    }

    branches(c: Caller, project: string): Promise<Reply> {
        return this.request(c, "GET", this.p(project, "/branches"));
    }

    moveBranch(c: Caller, project: string, body: { from: string; to: string; makeDefault?: boolean }): Promise<Reply> {
        return this.request(c, "POST", this.p(project, "/branches/move"), body);
    }

    deleteBranch(c: Caller, project: string, body: { branch: string; confirm?: boolean }): Promise<Reply> {
        return this.request(c, "POST", this.p(project, "/branches/delete"), body);
    }

    createUploadLink(c: Caller, project: string, body: { branch: string; confirm?: boolean }): Promise<Reply> {
        return this.request(c, "POST", this.p(project, "/upload-links"), body);
    }

    useUploadLink(url: string, report: Report): Promise<Reply> {
        return this.request({ kind: "anonymous" }, "POST", new URL(url).pathname, JSON.stringify(report));
    }

    // ---- issues -------------------------------------------------------------------------------

    listIssues(c: Caller, project: string, branch: string, query: Query = {}): Promise<Reply> {
        return this.request(c, "GET", this.p(project, "/issues", { branch, limit: "1000", ...query }));
    }

    getIssue(c: Caller, project: string, branch: string, id: string): Promise<Reply> {
        return this.request(c, "GET", this.p(project, `/issues/${enc(id)}`, { branch }));
    }

    updateIssue(c: Caller, project: string, branch: string, id: string, patch: Record<string, unknown>): Promise<Reply> {
        return this.request(c, "PATCH", this.p(project, `/issues/${enc(id)}`, { branch }), patch);
    }

    bulkUpdate(c: Caller, project: string, branch: string, body: Record<string, unknown>): Promise<Reply> {
        return this.request(c, "POST", this.p(project, "/issues/bulk", { branch }), body);
    }

    claimNext(c: Caller, project: string, branch: string, body: Record<string, unknown> = {}): Promise<Reply> {
        return this.request(c, "POST", this.p(project, "/issues/claim", { branch }), body);
    }

    releaseIssue(c: Caller, project: string, branch: string, id: string, body: Record<string, unknown> = {}): Promise<Reply> {
        return this.request(c, "POST", this.p(project, `/issues/${enc(id)}/release`, { branch }), body);
    }

    addFinding(c: Caller, project: string, branch: string, finding: Finding): Promise<Reply> {
        return this.request(c, "POST", this.p(project, "/issues", { branch }), findingBody(finding));
    }

    editNote(c: Caller, project: string, branch: string, issueId: string, noteId: string, text: string): Promise<Reply> {
        return this.request(c, "PATCH", this.p(project, `/issues/${enc(issueId)}/notes/${enc(noteId)}`, { branch }), { text });
    }

    deleteNote(c: Caller, project: string, branch: string, issueId: string, noteId: string): Promise<Reply> {
        return this.request(c, "DELETE", this.p(project, `/issues/${enc(issueId)}/notes/${enc(noteId)}`, { branch }));
    }

    // ---- GitHub ---------------------------------------------------------------------------------

    generateWebhookSecret(c: Caller, project: string): Promise<Reply> {
        return this.request(c, "POST", this.p(project, "/settings/github/webhook-secret"));
    }

    githubSettings(c: Caller, project: string): Promise<Reply> {
        return this.request(c, "GET", this.p(project, "/settings/github"));
    }

    async deliverWebhook(project: string, delivery: { event: string; body: string; signature: string | null }): Promise<Reply> {
        // Webhook addresses are opaque, so look this project's up once.
        let hookPath = this.hooks.get(project);
        if (!hookPath) {
            const settings = await this.githubSettings(await this.admin(), project);
            hookPath = new URL(settings.body.webhook.url).pathname;
            this.hooks.set(project, hookPath);
        }
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-github-event": delivery.event,
            "x-github-delivery": randomBytes(8).toString("hex"),
        };
        if (delivery.signature !== null) headers["x-hub-signature-256"] = delivery.signature;
        return this.request({ kind: "anonymous" }, "POST", hookPath, delivery.body, headers);
    }

    // ---- MCP ----------------------------------------------------------------------------------

    mcp(c: Caller, message: Record<string, unknown>): Promise<Reply> {
        return this.request(c, "POST", "/mcp", { jsonrpc: "2.0", ...message });
    }
}
