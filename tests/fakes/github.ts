// A fake GitHub for tests: an in-process HTTP server with the REST calls Triagent makes (repositories,
// pull requests, branches, compare, comments, statuses), the GitHub App's calls (JWTs checked against the
// app's key, installation tokens, installations), the OAuth code exchange and the manifest conversion,
// and git over smart HTTP (`git http-backend`) for repositories made with `gitRepo`, which only accepts
// requests carrying a token that may read the repository (sent as git's Authorization header).
//
// Nothing reaches the real GitHub. Tests seed it with the methods below; `tests/fakes/github-server.ts`
// runs it as a process for the end-to-end tests, seeded over /_fake/*.

import { execFile, spawn } from "node:child_process";
import { createHmac, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface FakeRepo {
    id: number;
    owner: string;
    name: string;
    fullName: string;
    defaultBranch: string;
    private: boolean;
    branches: Map<string, string>;
    pulls: Map<number, FakePull>;
    /** Each pull request's comments; `user` is the author's login (an app's is "<slug>[bot]"). */
    comments: Map<number, { id: number; body: string; user: string }[]>;
    statuses: { sha: string; state: string; description: string; context: string; target_url?: string; by: string }[];
    /** A bare repository served over smart HTTP. */
    gitDir: string | null;
    compares: Map<string, { ahead_by: number; behind_by: number }>;
}

export interface FakePull {
    number: number;
    title: string;
    state: "open" | "closed";
    draft: boolean;
    author: string;
    headRef: string;
    headSha: string;
    baseRef: string;
    /** From a fork: the head lives in another repository. */
    fork: boolean;
    /** GitHub's author_association: how the author relates to the repository (MEMBER unless given). */
    association?: string;
}

export interface FakeApp {
    id: number;
    slug: string;
    name: string;
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
    privateKey: string;
    publicKey: string;
    owner: string;
    manifest: Record<string, unknown> | null;
}

export interface FakeInstallation {
    id: number;
    account: { login: string; type: string };
    repoIds: number[];
    selection: "all" | "selected";
    suspended: boolean;
    /** Logins that can see the installation (GET /user/installations). */
    users: Set<string>;
}

export interface Logged {
    method: string;
    path: string;
    auth: string;
    body: unknown;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
};

const GIT_ENV = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fake",
    GIT_AUTHOR_EMAIL: "fake@example.test",
    GIT_COMMITTER_NAME: "Fake",
    GIT_COMMITTER_EMAIL: "fake@example.test",
};

async function git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await run("git", args, { cwd, env: GIT_ENV, maxBuffer: 50 * 1024 * 1024 });
    return stdout.trim();
}

export class FakeGitHub {
    readonly repos = new Map<string, FakeRepo>();
    readonly installations = new Map<number, FakeInstallation>();
    readonly pats = new Map<string, { login: string; repos: Set<string> }>();
    readonly installationTokens = new Map<
        string,
        { installationId: number; repoIds: number[] | null; permissions: Record<string, string> | null; expiresAt: number }
    >();
    readonly userTokens = new Map<string, string>();
    /** Organisation memberships: org → login → role (`GET /user/memberships/orgs/{org}`). */
    readonly orgRoles = new Map<string, Map<string, { role: "admin" | "member"; state: "active" | "pending" }>>();
    /** Installation tokens revoked with `DELETE /installation/token`. */
    readonly revoked = new Set<string>();
    readonly oauthCodes = new Map<string, string>();
    readonly manifestCodes = new Map<string, Record<string, unknown>>();
    readonly log: Logged[] = [];
    /** Git requests: which credential they carried (a token, "none" or "bad"). */
    readonly gitLog: { path: string; token: string }[] = [];
    app: FakeApp | null = null;
    private server: Server | null = null;
    private ids = 1000;
    private readonly root: string;
    url = "";

    /** Answer /_fake/* (seeding over HTTP), for the end-to-end tests' separate process. */
    private readonly admin: boolean;
    /** Who installs the app next through GitHub's installation page (the browser flow), and on what. */
    nextInstall: { account: string; repos: string[]; login: string } | null = null;

    constructor(options: { admin?: boolean } = {}) {
        this.root = mkdtempSync(path.join(tmpdir(), "fake-github-"));
        this.admin = Boolean(options.admin);
    }

    get apiUrl(): string {
        return `${this.url}/api`;
    }

    async start(port = 0): Promise<this> {
        this.server = createServer((req, res) => {
            this.handle(req, res).catch((err: Error) => {
                if (!res.headersSent) json(res, 500, { message: err.message });
                else res.end();
            });
        });
        await new Promise<void>((resolve) => this.server?.listen(port, "127.0.0.1", resolve));
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
        return this;
    }

    async stop(): Promise<void> {
        await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
        this.server?.closeAllConnections();
        rmSync(this.root, { recursive: true, force: true });
    }

    // ---- seeding ------------------------------------------------------------------------------------

    repo(fullName: string, extra: Partial<Pick<FakeRepo, "defaultBranch" | "private">> = {}): FakeRepo {
        const existing = this.repos.get(fullName);
        if (existing) return existing;
        const [owner, name] = fullName.split("/") as [string, string];
        const repo: FakeRepo = {
            id: ++this.ids,
            owner,
            name,
            fullName,
            defaultBranch: extra.defaultBranch ?? "main",
            private: extra.private ?? true,
            branches: new Map(),
            pulls: new Map(),
            comments: new Map(),
            statuses: [],
            gitDir: null,
            compares: new Map(),
        };
        this.repos.set(fullName, repo);
        return repo;
    }

    pat(token: string, login: string, repos: string[]): void {
        this.pats.set(token, { login, repos: new Set(repos) });
    }

    pull(fullName: string, p: Partial<FakePull> & { number: number; headRef: string }): FakePull {
        const repo = this.repo(fullName);
        const pull: FakePull = {
            title: `Pull request ${p.number}`,
            state: "open",
            draft: false,
            author: "octocat",
            baseRef: repo.defaultBranch,
            fork: false,
            headSha: repo.branches.get(p.headRef) ?? randomBytes(20).toString("hex"),
            ...p,
        };
        repo.pulls.set(pull.number, pull);
        return pull;
    }

    /** The instance's app, as if created through the manifest flow. */
    createApp(extra: Partial<FakeApp> = {}): FakeApp {
        const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        this.app = {
            id: ++this.ids,
            slug: "triagent-test",
            name: "Triagent test",
            clientId: `Iv1.${randomBytes(8).toString("hex")}`,
            clientSecret: randomBytes(20).toString("hex"),
            webhookSecret: randomBytes(20).toString("hex"),
            privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
            publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
            owner: "acme",
            manifest: null,
            ...extra,
        };
        return this.app;
    }

    install(account: string, repos: string[], users: string[], extra: Partial<FakeInstallation> = {}): FakeInstallation {
        const inst: FakeInstallation = {
            id: ++this.ids,
            account: { login: account, type: "Organization" },
            repoIds: repos.map((r) => this.repo(r).id),
            selection: "selected",
            suspended: false,
            users: new Set(users),
            ...extra,
        };
        this.installations.set(inst.id, inst);
        return inst;
    }

    /** Make `login` a member of the organisation `org`, with `role`. */
    orgRole(org: string, login: string, role: "admin" | "member", state: "active" | "pending" = "active"): void {
        const roles = this.orgRoles.get(org) ?? new Map();
        roles.set(login, { role, state });
        this.orgRoles.set(org, roles);
    }

    /** A code GitHub would hand back after `login` authorised the app (installation's user authorization). */
    oauthCode(login: string): string {
        const code = randomBytes(10).toString("hex");
        this.oauthCodes.set(code, login);
        return code;
    }

    /** A code GitHub would hand back after the manifest flow, for an app made from `manifest`. */
    manifestCode(manifest: Record<string, unknown>): string {
        const code = randomBytes(10).toString("hex");
        this.manifestCodes.set(code, manifest);
        return code;
    }

    /** A real (bare) repository served over smart HTTP, with `files` committed to its default branch. */
    async gitRepo(fullName: string, files: Record<string, string>, extra: { defaultBranch?: string } = {}): Promise<FakeRepo> {
        const repo = this.repo(fullName, extra);
        const dir = path.join(this.root, "git", repo.owner, `${repo.name}.git`);
        mkdirSync(dir, { recursive: true });
        await git(["init", "--bare", "--quiet", "-b", repo.defaultBranch, dir]);
        repo.gitDir = dir;
        await this.commit(fullName, repo.defaultBranch, files, "Initial commit");
        return repo;
    }

    /** Commit `files` (null deletes one) to `branch`, starting it from `from` if it's new. Returns the commit. */
    async commit(
        fullName: string,
        branch: string,
        files: Record<string, string | null>,
        message = "Change",
        from?: string,
    ): Promise<string> {
        const repo = this.repo(fullName);
        if (!repo.gitDir) throw new Error(`${fullName} has no git repository (use gitRepo).`);
        const work = mkdtempSync(path.join(this.root, "work-"));
        try {
            await git(["init", "--quiet", "-b", branch, work]);
            const start = repo.branches.get(branch) ?? (from ? repo.branches.get(from) : undefined);
            if (start) {
                await git(["fetch", "--quiet", repo.gitDir, start], work);
                await git(["reset", "--quiet", "--hard", start], work);
            }
            for (const [file, content] of Object.entries(files)) {
                const full = path.join(work, file);
                if (content === null) rmSync(full, { force: true, recursive: true });
                else {
                    mkdirSync(path.dirname(full), { recursive: true });
                    writeFileSync(full, content);
                }
            }
            // Every file given is committed, even one a .gitignore in the same commit names.
            await git(["add", "-A", "--force"], work);
            await git(["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", message], work);
            const sha = await git(["rev-parse", "HEAD"], work);
            await git(["push", "--quiet", "--force", repo.gitDir, `HEAD:refs/heads/${branch}`], work);
            repo.branches.set(branch, sha);
            for (const pull of repo.pulls.values()) if (pull.headRef === branch && !pull.fork) await this.pointPull(repo, pull, sha);
            return sha;
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    }

    /** Open a pull request from `headRef` (a branch of a git repository): refs/pull/N/head points at its commit. */
    async openPull(fullName: string, p: Partial<FakePull> & { number: number; headRef: string }): Promise<FakePull> {
        const repo = this.repo(fullName);
        const pull = this.pull(fullName, p);
        await this.pointPull(repo, pull, pull.headSha);
        return pull;
    }

    private async pointPull(repo: FakeRepo, pull: FakePull, sha: string): Promise<void> {
        pull.headSha = sha;
        if (repo.gitDir) await git(["--git-dir", repo.gitDir, "update-ref", `refs/pull/${pull.number}/head`, sha]);
    }

    deleteBranch(fullName: string, branch: string): void {
        this.repo(fullName).branches.delete(branch);
    }

    /** Send a webhook delivery, signed with `secret` (or a given signature). */
    async deliver(url: string, event: string, payload: unknown, secret: string | null, signature?: string) {
        const body = JSON.stringify(payload);
        const sig = signature ?? (secret ? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` : undefined);
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-github-event": event,
                "x-github-delivery": randomBytes(8).toString("hex"),
                ...(sig ? { "x-hub-signature-256": sig } : {}),
            },
            body,
        });
        const text = await res.text();
        let parsed: unknown = text;
        try {
            parsed = JSON.parse(text);
        } catch {
            // not JSON
        }
        return { status: res.status, body: parsed as Record<string, unknown> };
    }

    // ---- views ----------------------------------------------------------------------------------------

    private repoView(r: FakeRepo) {
        return {
            id: r.id,
            name: r.name,
            full_name: r.fullName,
            owner: { login: r.owner },
            private: r.private,
            default_branch: r.defaultBranch,
            html_url: `https://github.com/${r.fullName}`,
        };
    }

    private pullView(r: FakeRepo, p: FakePull) {
        const fork = p.fork ? `${p.author}/${r.name}` : r.fullName;
        return {
            number: p.number,
            title: p.title,
            state: p.state,
            draft: p.draft,
            html_url: `https://github.com/${r.fullName}/pull/${p.number}`,
            user: { login: p.author },
            author_association: p.association ?? "MEMBER",
            head: { ref: p.headRef, sha: p.headSha, repo: { full_name: fork } },
            base: { ref: p.baseRef, sha: r.branches.get(p.baseRef) ?? "0".repeat(40), repo: { full_name: r.fullName } },
            updated_at: new Date().toISOString(),
        };
    }

    private commentView(r: FakeRepo, number: number, c: { id: number; body: string; user: string }) {
        return {
            id: c.id,
            body: c.body,
            user: { login: c.user, type: c.user.endsWith("[bot]") ? "Bot" : "User" },
            issue_url: `${this.apiUrl}/repos/${r.fullName}/issues/${number}`,
        };
    }

    /** Who GitHub says wrote something: a token's owner, or the app's bot for an installation token. */
    private login(auth: ReturnType<FakeGitHub["who"]>): string {
        if (auth.kind === "installation") return `${this.app?.slug ?? "app"}[bot]`;
        return auth.login ?? auth.kind;
    }

    private installationView(i: FakeInstallation) {
        return {
            id: i.id,
            account: i.account,
            repository_selection: i.selection,
            suspended_at: i.suspended ? new Date().toISOString() : null,
            app_id: this.app?.id ?? null,
        };
    }

    // ---- auth ---------------------------------------------------------------------------------------

    private checkJwt(token: string): boolean {
        const app = this.app;
        if (!app) return false;
        const [head, body, sig] = token.split(".");
        if (!head || !body || !sig) return false;
        const ok = verify("RSA-SHA256", Buffer.from(`${head}.${body}`), createPublicKey(app.publicKey), Buffer.from(sig, "base64url"));
        if (!ok) return false;
        const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as { iss: string; exp: number; iat: number };
        const t = Math.floor(Date.now() / 1000);
        return claims.iss === String(app.id) && claims.exp > t && claims.exp - claims.iat <= 660 && claims.iat <= t + 60;
    }

    /** Who a bearer token is, and whether it may use `repo` (with `write` access, if asked). */
    private who(token: string | null): {
        kind: "pat" | "installation" | "app" | "user" | "none";
        canRead(r: FakeRepo): boolean;
        canWrite(r: FakeRepo, what: string): boolean;
        login?: string;
        installationId?: number;
    } {
        if (!token) return { kind: "none", canRead: () => false, canWrite: () => false };
        const pat = this.pats.get(token);
        if (pat)
            return { kind: "pat", login: pat.login, canRead: (r) => pat.repos.has(r.fullName), canWrite: (r) => pat.repos.has(r.fullName) };
        const inst = this.installationTokens.get(token);
        if (inst && inst.expiresAt > Date.now()) {
            const installation = this.installations.get(inst.installationId);
            const reach = (r: FakeRepo) =>
                Boolean(
                    installation &&
                        !installation.suspended &&
                        installation.repoIds.includes(r.id) &&
                        (!inst.repoIds || inst.repoIds.includes(r.id)),
                );
            const perm = (what: string) => !inst.permissions || inst.permissions[what] === "write";
            return {
                kind: "installation",
                installationId: inst.installationId,
                canRead: (r) => reach(r) && (!inst.permissions || Boolean(inst.permissions.contents || inst.permissions.pull_requests)),
                canWrite: (r, what) => reach(r) && perm(what),
            };
        }
        const user = this.userTokens.get(token);
        if (user) return { kind: "user", login: user, canRead: () => false, canWrite: () => false };
        if (this.checkJwt(token)) return { kind: "app", canRead: () => false, canWrite: () => false };
        return { kind: "none", canRead: () => false, canWrite: () => false };
    }

    // ---- requests -------------------------------------------------------------------------------------

    private async body(req: IncomingMessage): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return Buffer.concat(chunks);
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
        const url = new URL(req.url ?? "/", this.url);
        if (/^\/[\w.-]+\/[\w.-]+\.git\//.test(url.pathname)) return this.gitHttp(req, res, url);
        const raw = await this.body(req);
        let body: Record<string, unknown> = {};
        try {
            body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
        } catch {
            body = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
        }
        if (this.admin && url.pathname.startsWith("/_fake/")) return this.adminApi(req, res, url, body);
        // GitHub's pages in the browser: creating an app from a manifest, and installing it.
        const appsNew = /^\/(?:organizations\/[\w-]+\/)?settings\/apps\/new$/.exec(url.pathname);
        if (appsNew && req.method === "POST") {
            const manifest = JSON.parse(String(body.manifest ?? "{}")) as Record<string, unknown>;
            const code = this.manifestCode(manifest);
            const back = new URL(String(manifest.redirect_url));
            back.searchParams.set("code", code);
            back.searchParams.set("state", url.searchParams.get("state") ?? "");
            // GitHub asks the person to confirm on a page of its own, then sends them back.
            const href = back.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(
                `<!doctype html><html lang="en"><title>Create GitHub App</title><h1>Create GitHub App</h1><a href="${href}">Create GitHub App</a></html>`,
            );
        }
        const installNew = /^\/apps\/([\w-]+)\/installations\/new$/.exec(url.pathname);
        if (installNew && req.method === "GET" && this.app && this.nextInstall) {
            const n = this.nextInstall;
            const inst = this.install(n.account, n.repos, [n.login]);
            // Only an organisation's admins can install an app on it.
            this.orgRole(n.account, n.login, "admin");
            const callback = new URL(String((this.app.manifest?.callback_urls as string[] | undefined)?.[0] ?? ""));
            callback.searchParams.set("code", this.oauthCode(n.login));
            callback.searchParams.set("installation_id", String(inst.id));
            callback.searchParams.set("setup_action", "install");
            callback.searchParams.set("state", url.searchParams.get("state") ?? "");
            res.writeHead(302, { location: callback.toString() });
            return res.end();
        }
        if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
            const app = this.app;
            const login = this.oauthCodes.get(String(body.code));
            if (!app || body.client_id !== app.clientId || body.client_secret !== app.clientSecret || !login)
                return json(res, 200, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
            this.oauthCodes.delete(String(body.code));
            const token = `ghu_${randomBytes(18).toString("hex")}`;
            this.userTokens.set(token, login);
            return json(res, 200, { access_token: token, token_type: "bearer" });
        }
        if (!url.pathname.startsWith("/api/")) return json(res, 404, { message: "Not Found" });
        const p = url.pathname.slice(4);
        const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? null;
        const auth = this.who(token);
        this.log.push({ method: req.method ?? "GET", path: `${p}${url.search}`, auth: auth.kind, body });
        const page = Number(url.searchParams.get("page") ?? 1);
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const paged = <T>(items: T[]) => items.slice((page - 1) * perPage, page * perPage);
        let m: RegExpExecArray | null;

        m = /^\/app-manifests\/([\w-]+)\/conversions$/.exec(p);
        if (m && req.method === "POST") {
            const manifest = this.manifestCodes.get(m[1] as string);
            if (!manifest) return json(res, 404, { message: "Not Found" });
            this.manifestCodes.delete(m[1] as string);
            const app = this.createApp({
                name: String(manifest.name),
                slug: String(manifest.name)
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-"),
                manifest,
            });
            return json(res, 201, {
                id: app.id,
                slug: app.slug,
                name: app.name,
                client_id: app.clientId,
                client_secret: app.clientSecret,
                webhook_secret: app.webhookSecret,
                pem: app.privateKey,
                html_url: `https://github.com/apps/${app.slug}`,
                owner: { login: app.owner },
            });
        }
        m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(p);

        if (m) {
            if (auth.kind !== "app") return json(res, 401, { message: "A JSON web token could not be decoded" });
            const inst = this.installations.get(Number(m[1]));
            if (!inst) return json(res, 404, { message: "Not Found" });
            if (!m[2]) return json(res, 200, this.installationView(inst));
            if (inst.suspended) return json(res, 403, { message: "This installation has been suspended" });
            const repoIds = Array.isArray(body.repository_ids) ? (body.repository_ids as number[]) : null;
            if (repoIds?.some((id) => !inst.repoIds.includes(id)))
                return json(res, 422, { message: "There is at least one repository that does not exist or is not accessible" });
            const t = `ghs_${randomBytes(18).toString("hex")}`;
            const expiresAt = Date.now() + 3600_000;
            this.installationTokens.set(t, {
                installationId: inst.id,
                repoIds,
                permissions: (body.permissions as Record<string, string> | undefined) ?? null,
                expiresAt,
            });
            return json(res, 201, { token: t, expires_at: new Date(expiresAt).toISOString(), permissions: body.permissions ?? {} });
        }
        if (p === "/installation/repositories") {
            if (auth.kind !== "installation") return json(res, 401, { message: "Bad credentials" });
            const inst = this.installations.get(auth.installationId as number);
            const items = [...this.repos.values()].filter((r) => inst?.repoIds.includes(r.id)).map((r) => this.repoView(r));
            return json(res, 200, { total_count: items.length, repositories: paged(items) });
        }
        if (p === "/user/installations") {
            if (auth.kind !== "user") return json(res, 401, { message: "Bad credentials" });
            const items = [...this.installations.values()]
                .filter((i) => i.users.has(auth.login as string))
                .map((i) => this.installationView(i));
            return json(res, 200, { total_count: items.length, installations: paged(items) });
        }
        if (p === "/user") {
            if (auth.kind !== "pat" && auth.kind !== "user") return json(res, 401, { message: "Bad credentials" });
            return json(res, 200, { login: auth.login });
        }
        m = /^\/user\/memberships\/orgs\/([\w-]+)$/.exec(p);
        if (m && req.method === "GET") {
            if (auth.kind !== "user") return json(res, 401, { message: "Bad credentials" });
            const membership = this.orgRoles.get(m[1] as string)?.get(auth.login as string);
            if (!membership) return json(res, 404, { message: "Not Found" });
            return json(res, 200, {
                state: membership.state,
                role: membership.role,
                organization: { login: m[1] },
                user: { login: auth.login },
            });
        }
        if (p === "/installation/token" && req.method === "DELETE") {
            if (auth.kind !== "installation" || !token) return json(res, 401, { message: "Bad credentials" });
            this.installationTokens.delete(token);
            this.revoked.add(token);
            res.writeHead(204);
            return res.end();
        }
        m = /^\/repos\/([\w.-]+)\/([\w.-]+)(\/.*)?$/.exec(p);

        if (m) {
            const repo = this.repos.get(`${m[1]}/${m[2]}`);
            if (auth.kind === "none") return json(res, 401, { message: "Bad credentials" });
            if (!repo || !auth.canRead(repo)) return json(res, 404, { message: "Not Found" });
            return this.repoApi(req, res, repo, m[3] ?? "", body, auth, paged, url);
        }
        return json(res, 404, { message: "Not Found" });
    }

    private repoApi(
        req: IncomingMessage,
        res: ServerResponse,
        repo: FakeRepo,
        rest: string,
        body: Record<string, unknown>,
        auth: ReturnType<FakeGitHub["who"]>,
        paged: <T>(items: T[]) => T[],
        url: URL,
    ): unknown {
        let m: RegExpExecArray | null;
        const method = req.method ?? "GET";
        if (rest === "" && method === "GET") return json(res, 200, this.repoView(repo));
        if (rest === "/pulls" && method === "GET") {
            const state = url.searchParams.get("state") ?? "open";
            const items = [...repo.pulls.values()].filter((x) => state === "all" || x.state === state).map((x) => this.pullView(repo, x));
            return json(res, 200, paged(items));
        }
        m = /^\/pulls\/(\d+)$/.exec(rest);
        if (m && method === "GET") {
            const pull = repo.pulls.get(Number(m[1]));
            return pull ? json(res, 200, this.pullView(repo, pull)) : json(res, 404, { message: "Not Found" });
        }
        if (rest === "/branches" && method === "GET") {
            const items = [...repo.branches].map(([name, sha]) => ({ name, commit: { sha } }));
            return json(res, 200, paged(items));
        }
        m = /^\/branches\/(.+)$/.exec(rest);
        if (m && method === "GET") {
            const name = decodeURIComponent(m[1] as string);
            const sha = repo.branches.get(name);
            return sha ? json(res, 200, { name, commit: { sha } }) : json(res, 404, { message: "Branch not found" });
        }
        m = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest);
        if (m && method === "GET") {
            const base = decodeURIComponent(m[1] as string);
            const head = decodeURIComponent(m[2] as string);
            void this.compare(repo, base, head).then(
                (c) =>
                    c
                        ? json(res, 200, {
                              ...c,
                              status: c.ahead_by && c.behind_by ? "diverged" : c.ahead_by ? "ahead" : c.behind_by ? "behind" : "identical",
                          })
                        : json(res, 404, { message: "Not Found" }),
                () => json(res, 404, { message: "Not Found" }),
            );
            return;
        }
        m = /^\/issues\/(\d+)\/comments$/.exec(rest);

        if (m) {
            const number = Number(m[1]);
            const list = repo.comments.get(number) ?? [];
            if (method === "GET") return json(res, 200, paged(list.map((c) => this.commentView(repo, number, c))));
            if (method === "POST") {
                if (!auth.canWrite(repo, "pull_requests")) return json(res, 403, { message: "Resource not accessible by integration" });
                const comment = { id: ++this.ids, body: String(body.body), user: this.login(auth) };
                repo.comments.set(number, [...list, comment]);
                return json(res, 201, this.commentView(repo, number, comment));
            }
        }
        m = /^\/issues\/comments\/(\d+)$/.exec(rest);
        if (m && (method === "PATCH" || method === "GET")) {
            if (method === "PATCH" && !auth.canWrite(repo, "pull_requests"))
                return json(res, 403, { message: "Resource not accessible by integration" });
            for (const [number, list] of repo.comments) {
                const c = list.find((x) => x.id === Number(m?.[1]));
                if (!c) continue;
                // Like GitHub, anyone who may write to the repository may edit anyone's comment.
                if (method === "PATCH") c.body = String(body.body);
                return json(res, 200, this.commentView(repo, number, c));
            }
            return json(res, 404, { message: "Not Found" });
        }
        m = /^\/statuses\/([0-9a-f]{40})$/.exec(rest);
        if (m && method === "POST") {
            if (!auth.canWrite(repo, "statuses")) return json(res, 403, { message: "Resource not accessible by integration" });
            const status = {
                sha: m[1] as string,
                state: String(body.state),
                description: String(body.description ?? ""),
                context: String(body.context ?? "default"),
                ...(body.target_url ? { target_url: String(body.target_url) } : {}),
                by: auth.kind,
            };
            repo.statuses.push(status);
            return json(res, 201, status);
        }
        return json(res, 404, { message: "Not Found" });
    }

    private async adminApi(req: IncomingMessage, res: ServerResponse, url: URL, b: Record<string, unknown>): Promise<unknown> {
        const str = (k: string) => String(b[k] ?? "");
        const files = (b.files ?? {}) as Record<string, string | null>;
        switch (url.pathname) {
            case "/_fake/health":
                return json(res, 200, { ok: true });
            case "/_fake/git-repo":
                return json(res, 200, { id: (await this.gitRepo(str("fullName"), files as Record<string, string>)).id });
            case "/_fake/commit":
                return json(res, 200, {
                    sha: await this.commit(
                        str("fullName"),
                        str("branch"),
                        files,
                        str("message") || "Change",
                        b.from ? str("from") : undefined,
                    ),
                });
            case "/_fake/pull":
                return json(res, 200, await this.openPull(str("fullName"), b as never));
            case "/_fake/pat":
                this.pat(str("token"), str("login"), b.repos as string[]);
                return json(res, 200, { ok: true });
            case "/_fake/next-install":
                this.nextInstall = b as never;
                return json(res, 200, { ok: true });
            case "/_fake/repo": {
                const repo = this.repos.get(url.searchParams.get("fullName") ?? "");
                if (!repo) return json(res, 404, { message: "Not Found" });
                return json(res, 200, { statuses: repo.statuses, comments: Object.fromEntries(repo.comments), id: repo.id });
            }
            default:
                return json(res, 404, { message: `No fake endpoint ${req.method} ${url.pathname}` });
        }
    }

    private async compare(repo: FakeRepo, base: string, head: string) {
        const given = repo.compares.get(`${base}...${head}`);
        if (given) return given;
        const ref = (x: string) => repo.branches.get(x) ?? x;
        if (repo.gitDir) {
            const count = (range: string) => git(["--git-dir", repo.gitDir as string, "rev-list", "--count", range]).then(Number);
            return { ahead_by: await count(`${ref(base)}..${ref(head)}`), behind_by: await count(`${ref(head)}..${ref(base)}`) };
        }
        return { ahead_by: 1, behind_by: 0 };
    }

    /** Git's smart HTTP protocol, through `git http-backend`, for tokens that may read the repository. */
    private async gitHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        const m = /^\/([\w.-]+)\/([\w.-]+)\.git(\/.*)$/.exec(url.pathname) as RegExpExecArray;
        const repo = this.repos.get(`${m[1]}/${m[2]}`);
        const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
        const [, token] = basic ? Buffer.from(basic, "base64").toString().split(":") : [];
        this.gitLog.push({ path: url.pathname, token: token ?? "none" });
        const auth = this.who(token ?? null);
        if (!repo?.gitDir || !auth.canRead(repo) || (auth.kind === "installation" && !this.canFetch(token as string))) {
            res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
            res.end("Authentication failed");
            return;
        }
        if (m[3] === "/git-receive-pack" || url.searchParams.get("service") === "git-receive-pack") {
            res.writeHead(403);
            res.end("read only");
            return;
        }
        const env: Record<string, string> = {
            ...GIT_ENV,
            GIT_PROJECT_ROOT: path.dirname(path.dirname(repo.gitDir)),
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: `/${repo.owner}/${repo.name}.git${m[3]}`,
            REQUEST_METHOD: req.method ?? "GET",
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: req.headers["content-type"] ?? "",
            ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
            ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
            REMOTE_USER: "x-access-token",
            REMOTE_ADDR: "127.0.0.1",
        };
        const child = spawn("git", ["http-backend"], { env });
        req.pipe(child.stdin);
        const chunks: Buffer[] = [];
        child.stdout.on("data", (d: Buffer) => chunks.push(d));
        await new Promise<void>((resolve) => child.on("close", () => resolve()));
        const out = Buffer.concat(chunks);
        const split = out.indexOf("\r\n\r\n");
        const head = out.subarray(0, split).toString();
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.split("\r\n")) {
            const i = line.indexOf(":");
            const k = line.slice(0, i).trim();
            const v = line.slice(i + 1).trim();
            if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]);
            else if (k) headers[k] = v;
        }
        res.writeHead(status, headers);
        res.end(out.subarray(split + 4));
    }

    /** Installation tokens need contents access to fetch. */
    private canFetch(token: string): boolean {
        const t = this.installationTokens.get(token);
        return !t?.permissions || t.permissions.contents === "read" || t.permissions.contents === "write";
    }
}
