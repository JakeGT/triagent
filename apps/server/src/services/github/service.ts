// A project's connection to GitHub, in one of two modes behind one interface (`githubFor`):
//
//  - app: the instance's GitHub App, installed on an account and linked to a workspace; the project picks
//    one of the installation's repositories. Tokens are minted per use and narrowed to that repository.
//  - token: a personal access token (fine-grained or classic) stored (encrypted) on the project, or else
//    the workspace's, when the workspace is set to lend one (services/github/workspace.ts). Token
//    connections use the workspace's GitHub server: the instance's, or its own GitHub Enterprise Server.
//
// Also: linking installations to workspaces (only after proving the person can see the installation),
// creating the instance's app, commit statuses and the pull request comment.

import { ROLE_PERMISSIONS } from "@triagent/shared";
import { log } from "@triagent/shared/log";
import { z } from "zod";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../errors.ts";
import { logFailure } from "../../failure.ts";
import { now, sha256 } from "../../security.ts";
import type { GithubDelivery, GithubInstallation, Project, Repos, User, Workspace } from "../../store/types.ts";
import type { Actor, Core } from "../core.ts";
import type { Lookup } from "../model-urls.ts";
import type { Projects } from "../projects.ts";
import type { Settings } from "../settings.ts";
import { type AppCredentials, GithubApp } from "./app.ts";
import { type CommitState, GitHubClient, GitHubError, parseRepo, type RepoTarget } from "./client.ts";
import { WorkspaceGithub } from "./workspace.ts";

const CONNECTION = "github-connection";
const KEEP_DELIVERIES = 50;
export const STATUS_CONTEXT = "Triagent";
export const COMMENT_MARKER = "<!-- triagent-review -->";
/** In Triagent's comment, what follows this is a note about what's happened since the review, replaced each time. */
export const NOTE_MARKER = "<!-- triagent-since -->";

export const ConnectionSchema = z.object({ installationId: z.number().int().positive(), repositoryId: z.number().int().positive() });

interface AppConnection {
    mode: "app";
    installationId: number;
    repositoryId: number;
    fullName: string;
}

/** What a project uses to reach GitHub. */
export interface GithubAccess {
    mode: "app" | "token";
    /** Whose token a token connection uses: the project's own, or the workspace's. */
    tokenFrom?: "project" | "workspace";
    /** For reading pull requests and branches, and writing comments and statuses. */
    client: GitHubClient;
    /**
     * For reading a commit's check runs. The app's has a token of its own, asking for "Checks: read":
     * an installation that hasn't accepted that permission can't be given one, and then only this fails.
     */
    checks: GitHubClient;
    repo: RepoTarget;
    cloneUrl: string;
    /**
     * A credential for one review's `git fetch`: read-only and limited to the repository where possible.
     * `revoke`: it's the review's alone (an installation token), to be revoked when the review ends.
     */
    tokenForJob(): Promise<{ token: string; revoke: boolean }>;
    /** The login comments are posted as: the app's bot, or the token's owner. */
    identity(): Promise<string>;
}

/**
 * Webhook deliveries refused for a bad or missing signature, counted per project (or the app's webhook,
 * under null) since this process started. Not stored with the real deliveries: anyone can send them, so
 * they'd push those out, and each would be a write to the database.
 */
export class RefusedDeliveries {
    private readonly counts = new Map<string, { count: number; lastAt: string; lastReason: string }>();

    note(projectId: string | null, reason: string, what: string): void {
        const key = projectId ?? "";
        const c = this.counts.get(key) ?? { count: 0, lastAt: "", lastReason: "" };
        c.count++;
        c.lastAt = now();
        c.lastReason = reason;
        this.counts.set(key, c);
        if (this.counts.size > 10_000) this.counts.delete(this.counts.keys().next().value as string);
        // Not every one: the log mustn't fill up with them either.
        if (c.count === 1 || c.count % 100 === 0) log.warn("GitHub delivery refused", { to: what, count: c.count, reason });
    }

    get(projectId: string | null): { count: number; lastAt: string; lastReason: string } | null {
        const c = this.counts.get(projectId ?? "");
        return c ? { ...c } : null;
    }
}

/** How many pull requests' comment ids a project remembers. */
const KEEP_COMMENT_IDS = 1000;

/** A repository as a job records it: GitHub's id when known, and owner/name. */
export interface RepoRef {
    id: number | null;
    fullName: string;
}

/** Whether `repo` is the repository a job was queued for (by id when both know it, otherwise by name). */
export function sameRepository(queued: RepoRef | null, repo: RepoTarget): boolean {
    if (!queued) return true;
    if (queued.id !== null && repo.id !== null) return queued.id === repo.id;
    return queued.fullName.toLowerCase() === repo.fullName.toLowerCase();
}

/** The project now points at another repository than the one a review was of. */
export class RepositoryChanged extends Error {}

/**
 * For `maybeFor(project).catch(…)`: carry on as if the project weren't connected, but say why, since the
 * failure isn't that (a project that isn't connected is no failure at all).
 */
export const noConnection = (project: Pick<Project, "slug">) => (err: unknown) => {
    logFailure("Couldn't read a project's GitHub connection", err, { project: project.slug });
    return null;
};

export class NotConnected extends ApiError {
    constructor(message: string) {
        super(400, message, { code: "github_not_connected" });
    }
}

function connectionMode(app: boolean, token: boolean): "app" | "token" | "none" {
    if (app) return "app";
    return token ? "token" : "none";
}

function tokenSource(own: boolean, lent: boolean): "project" | "workspace" | null {
    if (own) return "project";
    return lent ? "workspace" : null;
}

interface InstallState extends Record<string, unknown> {
    userId: string;
    workspaceId: string;
    ws: string;
    project: string;
    setup?: boolean;
    /** Linking an installation they already have, rather than installing. */
    link?: boolean;
}

/** Of the installations someone can see, how many are checked for one they may link, and how many at once. */
const MAX_LINK_CANDIDATES = 20;
const LINK_CHECKS_AT_ONCE = 5;
/** How long a list of installations to choose from stands: they were checked with GitHub when it was made. */
const LINK_CHOICE_MS = 10 * 60_000;

/** Back to the project's GitHub settings: in the workspace as it's called now (`ws`), if it's been renamed. */
const backTo =
    (state: InstallState, ws = state.ws) =>
    (outcome: string) =>
        `/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(state.project)}/settings/github?github=${outcome}${state.setup === true ? "&setup=project" : ""}`;

/** A reason linking failed, worth showing over the others: GitHub's answer rather than "not yours". */
const WORTH_SAYING = ["members-permission", "failed"];

export class Github {
    readonly app: GithubApp;
    readonly workspace: WorkspaceGithub;
    private readonly core: Core;
    private readonly settings: Settings;
    private readonly projects: Projects;
    readonly refused = new RefusedDeliveries();
    /** Token owners' logins, by a hash of the token, so `GET /user` isn't asked on every comment. */
    private readonly owners = new Map<string, string>();

    constructor(core: Core, settings: Settings, projects: Projects, lookup?: Lookup) {
        this.core = core;
        this.settings = settings;
        this.projects = projects;
        this.app = new GithubApp(core);
        this.workspace = new WorkspaceGithub(core, lookup);
    }

    private get store() {
        return this.core.store;
    }

    // ---- one interface for both modes ------------------------------------------------------------

    async connection(repos: Repos, project: Project): Promise<AppConnection | null> {
        return ((await repos.settings.get(project.workspaceId, project.id, CONNECTION))?.value as AppConnection | undefined) ?? null;
    }

    cloneUrl(repo: RepoTarget, server: string = this.core.config.githubUrl): string {
        return `${server}/${repo.owner}/${repo.name}.git`;
    }

    /** How to reach the project's repository, or a NotConnected error saying what's missing. */
    async githubFor(project: Project, repos: Repos = this.store): Promise<GithubAccess> {
        const conn = await this.connection(repos, project);
        if (conn) {
            const installation = await repos.githubInstallations.get(conn.installationId, project.workspaceId);
            if (!installation)
                throw new NotConnected(
                    "The GitHub App installation this project used is no longer linked. Choose a repository again in its GitHub settings.",
                );
            if (installation.suspended)
                throw new NotConnected(`The GitHub App installation on ${installation.accountLogin} is suspended. Unsuspend it on GitHub.`);
            if (!(await this.app.credentials()))
                throw new NotConnected("The instance's GitHub App has been removed. An instance admin can set it up again.");
            const parsed = parseRepo(`https://x/${conn.fullName}`);
            if (!parsed)
                throw new NotConnected("This project's repository isn't recorded properly. Choose it again in its GitHub settings.");
            const repo = { ...parsed, id: conn.repositoryId };
            return {
                mode: "app",
                client: this.app.clientFor(conn.installationId, conn.repositoryId, {
                    contents: "read",
                    metadata: "read",
                    pull_requests: "write",
                    statuses: "write",
                }),
                checks: this.app.clientFor(conn.installationId, conn.repositoryId, { checks: "read" }),
                repo,
                cloneUrl: this.cloneUrl(repo),
                // Reviews only need to read the code. Never the server's own (cached) token: this one is
                // minted for the review, and revoked when it ends.
                tokenForJob: async () => ({
                    token: (
                        await this.app.mintToken(conn.installationId, {
                            repositoryIds: [conn.repositoryId],
                            permissions: { contents: "read" },
                        })
                    ).token,
                    revoke: true,
                }),
                identity: async () => {
                    const info = await this.app.info();
                    if (!info) throw new NotConnected("The instance's GitHub App has been removed. An instance admin can set it up again.");
                    return `${info.slug}[bot]`;
                },
            };
        }
        const own = await this.settings.githubToken(repos, project);
        const token = own ?? (await this.workspace.token(repos, project.workspaceId));
        if (!token)
            throw new NotConnected(
                "This project isn't connected to GitHub: pick a repository from the GitHub App, or add a token, in its GitHub settings (or give the workspace a token in its GitHub settings).",
            );
        const repo = parseRepo(project.repoUrl);
        if (!repo) throw new NotConnected("Set the project's repository address in its General settings first.");
        let server: Awaited<ReturnType<WorkspaceGithub["server"]>>;
        try {
            server = await this.workspace.server(repos, project.workspaceId);
        } catch (err) {
            if (err instanceof ApiError) throw new NotConnected(`The workspace's GitHub server can't be used: ${err.message}`);
            throw err;
        }
        // On the workspace's own server, the repository must be there too: owner/name alone could name
        // another repository on it.
        // (Stored repository addresses have no port, so host names are compared.)
        const repoHost = project.repoUrl ? new URL(project.repoUrl).hostname.toLowerCase() : null;
        if (server.own && repoHost && repoHost !== new URL(server.url).hostname.toLowerCase())
            throw new NotConnected(
                `This project's repository is on ${repoHost}, but the workspace's GitHub is ${server.url}. Change one of them.`,
            );
        const client = new GitHubClient(server.apiUrl, async () => token, "token");
        return {
            mode: "token",
            tokenFrom: own ? "project" : "workspace",
            client,
            checks: client,
            repo,
            cloneUrl: this.cloneUrl(repo, server.url),
            tokenForJob: async () => ({ token, revoke: false }),
            identity: async () => {
                // The same token can belong to different accounts on different servers.
                const key = sha256(`${server.apiUrl}\n${token}`);
                const known = this.owners.get(key);
                if (known) return known;
                const { login } = await client.viewer();
                if (typeof login !== "string" || !login) throw new GitHubError(502, "GitHub didn't say who the token belongs to.");
                this.owners.set(key, login);
                if (this.owners.size > 1000) this.owners.delete(this.owners.keys().next().value as string);
                return login;
            },
        };
    }

    /** githubFor, or null when the project isn't connected (other errors still throw). */
    async maybeFor(project: Project, repos: Repos = this.store): Promise<GithubAccess | null> {
        try {
            return await this.githubFor(project, repos);
        } catch (err) {
            if (err instanceof NotConnected) return null;
            throw err;
        }
    }

    // ---- statuses and the pull request comment ---------------------------------------------------

    /** The project's connection, refusing if it now points at another repository than `expect`. */
    private async reporting(project: Project, expect: RepoRef | null): Promise<GithubAccess> {
        const gh = await this.githubFor(project);
        if (!sameRepository(expect, gh.repo))
            throw new RepositoryChanged(`this project now uses ${gh.repo.fullName}, and this review was of ${expect?.fullName}`);
        return gh;
    }

    async setStatus(
        project: Project,
        sha: string,
        state: CommitState,
        description: string,
        targetUrl: string | null,
        expect: RepoRef | null = null,
    ): Promise<void> {
        const gh = await this.reporting(project, expect);
        await gh.client.setStatus(gh.repo, sha, { state, description, context: STATUS_CONTEXT, targetUrl });
    }

    /** Write Triagent's comment on a pull request: the one it wrote before, if it's still there, or a new one. */
    upsertComment(project: Project, number: number, body: string, expect: RepoRef | null = null) {
        return this.writeComment(project, number, body, expect, false);
    }

    /**
     * Add a line to the end of Triagent's comment on a pull request, in place of the last such line (what's
     * happened since the review: commits pushed, a review asked for). Does nothing when it hasn't commented.
     * `note` is Markdown: escape anything from GitHub in it.
     */
    noteOnComment(project: Project, number: number, note: string) {
        return this.writeComment(
            project,
            number,
            (body) => `${body.split(NOTE_MARKER)[0]?.trimEnd()}\n\n${NOTE_MARKER}\n${note}`,
            null,
            true,
        );
    }

    private async writeComment(
        project: Project,
        number: number,
        body: string | ((current: string) => string),
        expect: RepoRef | null,
        onlyIfThere: boolean,
    ) {
        const gh = await this.reporting(project, expect);
        const author = await gh.identity();
        const state = (await this.store.githubState.get(project.id)) as { comments?: Record<string, number> } | null;
        const known = state?.comments?.[String(number)] ?? null;
        const out = await gh.client.upsertComment(gh.repo, number, COMMENT_MARKER, body, { author, known, onlyIfThere });
        if (out && out.id !== known)
            await this.store.transaction(async (tx) => {
                const current = ((await tx.githubState.get(project.id)) ?? {}) as { comments?: Record<string, number> };
                const comments = { ...current.comments, [String(number)]: out.id };
                for (const k of Object.keys(comments).slice(0, Math.max(0, Object.keys(comments).length - KEEP_COMMENT_IDS)))
                    delete comments[k];
                await tx.githubState.put(project.id, { ...current, comments });
            });
        return out;
    }

    // ---- project settings ---------------------------------------------------------------------------

    async settingsView(project: Project) {
        const base = await this.settings.github(project);
        const conn = await this.connection(this.store, project);
        const app = await this.app.info();
        const installations = await this.store.githubInstallations.forWorkspace(project.workspaceId);
        const state = (await this.store.githubState.get(project.id)) as { checksReadable?: boolean } | null;
        const ws = await this.workspace.view(project.workspaceId, Boolean(app));
        const own = base.connection.method === "token";
        const lent = !own && ws.method === "token" && ws.token.set;
        return {
            ...base,
            // False once GitHub has refused to show this connection a commit's check runs (services/github/automation.ts).
            checksReadable: state?.checksReadable ?? null,
            mode: connectionMode(Boolean(conn), own || lent),
            tokenFrom: conn ? null : tokenSource(own, lent),
            // What the workspace's GitHub settings lend projects, and the server tokens go to.
            workspace: {
                method: ws.method,
                server: ws.server ?? ws.defaultServer,
                ownServer: ws.server !== null,
                token: ws.token.set ? { owner: ws.token.owner, kind: ws.token.kind } : null,
            },
            app: app ? { available: true, name: app.name, slug: app.slug, htmlUrl: app.htmlUrl } : { available: false },
            installations: installations.map(publicInstallation),
            repository: conn ? { installationId: conn.installationId, repositoryId: conn.repositoryId, fullName: conn.fullName } : null,
        };
    }

    async setConnection(actor: Actor, project: Project, input: { installationId: number; repositoryId: number }) {
        const installation = await this.store.githubInstallations.get(input.installationId, project.workspaceId);
        if (!installation) throw notFound("No such installation in this workspace.");
        const repos = await this.app.repositories(installation.id);
        const repo = repos.find((r) => r.id === input.repositoryId);
        if (!repo) throw badRequest(`The installation on ${installation.accountLogin} doesn't include that repository.`);
        const value: AppConnection = { mode: "app", installationId: installation.id, repositoryId: repo.id, fullName: repo.full_name };
        return this.core.write(actor, async (w) => {
            const current = await w.tx.projects.get(project.id);
            if (!current) throw notFound("The project no longer exists.");
            await w.tx.settings.put({ workspaceId: project.workspaceId, projectId: project.id, key: CONNECTION, value });
            await w.audit({
                workspaceId: project.workspaceId,
                kind: "settings",
                target: `project:${project.slug}:github`,
                changes: { repository: repo.full_name, installation: installation.accountLogin },
            });
            const repoUrl = this.projects.repoUrlOrNull(repo.html_url) ?? `https://github.com/${repo.full_name}`;
            if (current.repoUrl !== repoUrl) await this.projects.update(actor, current, { repoUrl });
            return { repository: { installationId: installation.id, repositoryId: repo.id, fullName: repo.full_name } };
        });
    }

    async clearConnection(actor: Actor, project: Project) {
        return this.core.write(actor, async (w) => {
            await w.tx.settings.put({ workspaceId: project.workspaceId, projectId: project.id, key: CONNECTION, value: null });
            await w.audit({
                workspaceId: project.workspaceId,
                kind: "settings",
                target: `project:${project.slug}:github`,
                changes: { repository: null },
            });
            return { repository: null };
        });
    }

    /** Read the repository and its open pull requests, to show the connection works. */
    async test(project: Project) {
        const gh = await this.githubFor(project);
        const repo = await gh.client.repo(gh.repo);
        const pulls = await gh.client.openPulls(gh.repo);
        const account = gh.mode === "token" ? await gh.client.viewer().catch(() => null) : null;
        return {
            ok: true,
            mode: gh.mode,
            repository: { fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private },
            openPulls: pulls.length,
            account: account?.login ?? null,
            note:
                gh.mode === "app"
                    ? "Reading works. Comments and checks are posted as the GitHub App."
                    : `Reading works.${account?.login ? ` Comments and checks are posted as ${account.login}.` : ""}`,
        };
    }

    // ---- installations ---------------------------------------------------------------------------

    async installations(workspace: Workspace) {
        const items = await this.store.githubInstallations.forWorkspace(workspace.id);
        // Asked of GitHub side by side: one slow installation doesn't hold up the others.
        const out = await Promise.all(
            items.map(async (i) => {
                let repositories: { id: number; fullName: string; private: boolean; defaultBranch: string }[] = [];
                let error: string | null = null;
                if (!i.suspended) {
                    try {
                        repositories = (await this.app.repositories(i.id)).map((r) => ({
                            id: r.id,
                            fullName: r.full_name,
                            private: r.private,
                            defaultBranch: r.default_branch,
                        }));
                    } catch (err) {
                        error = (err as Error).message;
                    }
                }
                return { ...publicInstallation(i), repositories, error };
            }),
        );
        return { items: out };
    }

    /**
     * Where to send a workspace admin to install the app (on GitHub), with a signed state for the way back:
     * to the project's GitHub settings, or (`setup`) into its guided setup. With `link`, they go to GitHub
     * only to say who they are, to link an installation they already have (an account can only install the
     * app once, and one installation can serve several workspaces).
     */
    async startInstall(actor: Actor, workspace: Workspace, project: string, setup = false, link = false) {
        const app = await this.app.info();
        if (!app) throw badRequest("No GitHub App is set up on this instance yet. Ask an instance admin to create one.");
        if (!actor.userId) throw forbidden("Sign in through the browser to install the GitHub App.");
        const state = this.app.signState({
            purpose: "install",
            userId: actor.userId,
            workspaceId: workspace.id,
            ws: workspace.slug,
            project,
            ...(setup ? { setup: true } : {}),
            ...(link ? { link: true } : {}),
        });
        return { url: link ? await this.app.authorizeUrl(state) : this.app.installUrl(app.slug, state) };
    }

    /**
     * The way back from GitHub: after installing the app, or (`link` in the state) after authorizing it to
     * link an installation the person already has. The installation id in the address isn't trusted: the
     * person must have started this from Triagent (the signed state), still be allowed to manage secrets in
     * that workspace, and GitHub must confirm, with their own authorization, that they can see the
     * installation and administer the organisation it's on (or are the account, for a personal one).
     * Returns where to send them next.
     */
    async completeInstall(user: User, query: { code?: string; installation_id?: string; state?: string; setup_action?: string }) {
        const state = this.app.readState<InstallState>(query.state, "install");
        if (!state) {
            // Changed on GitHub without starting from Triagent (e.g. repositories added): nothing to link.
            return { redirect: "/", outcome: "ignored" as const };
        }
        if (state.userId !== user.id) return { redirect: backTo(state)("not-you"), outcome: "refused" as const };
        // Still allowed to manage the workspace's secrets (the installation grants access to code).
        const workspace = await this.store.workspaces.get(state.workspaceId);
        if (!workspace || !(await this.maySecrets(this.store, workspace.id, user.id)))
            return { redirect: backTo(state)("not-allowed"), outcome: "refused" as const };
        const back = backTo(state, workspace.slug);
        const id = Number(query.installation_id);
        const linking = state.link === true && query.installation_id === undefined;
        if ((!linking && (!Number.isSafeInteger(id) || id <= 0)) || typeof query.code !== "string" || !query.code)
            return { redirect: back("no-authorization"), outcome: "refused" as const };
        let visible: number[];
        let userToken: string;
        try {
            userToken = await this.app.userToken(query.code);
            visible = await this.app.userInstallations(userToken);
        } catch (err) {
            logFailure("Linking a GitHub App installation failed", err);
            return { redirect: back("failed"), outcome: "refused" as const };
        }
        if (linking) {
            // Of the installations they can see, those they may link: an organisation's they own, or their own.
            // Checked a few at a time (each takes two or three calls to GitHub).
            const candidates = visible.slice(0, MAX_LINK_CANDIDATES);
            const verdicts: Awaited<ReturnType<Github["mayLink"]>>[] = [];
            for (let i = 0; i < candidates.length; i += LINK_CHECKS_AT_ONCE)
                verdicts.push(...(await Promise.all(candidates.slice(i, i + LINK_CHECKS_AT_ONCE).map((c) => this.mayLink(userToken, c)))));
            const options = candidates.flatMap((id, i) => {
                const v = verdicts[i];
                return v?.ok ? [{ id, account: v.account }] : [];
            });
            if (options.length === 0) {
                const failed = WORTH_SAYING.find((r) => verdicts.some((v) => !v.ok && v.reason === r));
                return { redirect: back(failed ?? "none-to-link"), outcome: "refused" as const };
            }
            if (options.length === 1) return this.link(user, workspace, (options[0] as { id: number }).id, back);
            const choice = this.app.signState(
                { purpose: "link-choice", userId: user.id, workspaceId: workspace.id, options },
                LINK_CHOICE_MS,
            );
            return { redirect: `${back("choose")}&choice=${encodeURIComponent(choice)}`, outcome: "choose" as const };
        }
        if (!visible.includes(id)) return { redirect: back("not-yours"), outcome: "refused" as const };
        const verdict = await this.mayLink(userToken, id);
        if (!verdict.ok) return { redirect: back(verdict.reason), outcome: "refused" as const };
        return this.link(user, workspace, id, back);
    }

    /**
     * Link one of the installations offered after authorizing (several were eligible): `choice` is the
     * signed list they were offered, for them and this workspace, within ten minutes. GitHub isn't asked
     * again whether they own its account (their authorization isn't kept): the list is that answer, as of
     * when it was made. The installation must still be on the same account, and they must still manage the
     * workspace's secrets.
     */
    async chooseLink(actor: Actor, workspace: Workspace, input: { choice: string; installationId: number }) {
        const choice = this.app.readState<{ userId: string; workspaceId: string; options: { id: number; account: string }[] }>(
            input.choice,
            "link-choice",
        );
        if (!choice || choice.userId !== actor.userId || choice.workspaceId !== workspace.id)
            throw badRequest("That choice has expired or isn't yours. Start linking again.");
        if (!choice.options.some((o) => o.id === input.installationId)) throw badRequest("That installation wasn't one of those offered.");
        const user = actor.userId ? await this.store.users.get(actor.userId) : null;
        if (!user) throw forbidden("Sign in through the browser to link an installation.");
        const offered = choice.options.find((o) => o.id === input.installationId)?.account;
        const out = await this.link(user, workspace, input.installationId, (outcome) => outcome, offered);
        if (out.redirect === "not-allowed")
            throw forbidden("You're no longer allowed to manage this workspace's secrets, so nothing was linked.");
        if (out.outcome !== "linked") throw badRequest("GitHub couldn't confirm that installation now. Start linking again.");
        return { linked: input.installationId };
    }

    private async maySecrets(repos: Repos, workspaceId: string, userId: string) {
        const membership = await repos.memberships.get(workspaceId, userId);
        return Boolean(membership && ROLE_PERMISSIONS[membership.role].includes("secrets"));
    }

    /**
     * Whether this person may link an installation. Seeing one isn't enough: any member of an organisation
     * can. Linking it hands a workspace every repository in it, so it takes an owner of the organisation,
     * or for a personal account's installation, that person.
     */
    private async mayLink(userToken: string, id: number): Promise<{ ok: true; account: string } | { ok: false; reason: string }> {
        try {
            const account = (await this.app.installation(id)).account;
            if (!account) return { ok: false, reason: "failed" };
            if (account.type === "Organization") {
                const membership = await this.app.orgMembership(userToken, account.login);
                if (membership?.state !== "active" || membership.role !== "admin") return { ok: false, reason: "not-admin" };
            } else if ((await this.app.userLogin(userToken)).toLowerCase() !== account.login.toLowerCase())
                return { ok: false, reason: "not-account" };
            return { ok: true, account: account.login };
        } catch (err) {
            logFailure("Checking who may link a GitHub App installation failed", err);
            const forbidden = err instanceof GitHubError && err.status === 403;
            return { ok: false, reason: forbidden ? "members-permission" : "failed" };
        }
    }

    /**
     * Link an installation to a workspace (it may be linked to others too), once the person may. With
     * `account`, only if the installation is still on that account.
     */
    private async link(user: User, workspace: Workspace, id: number, back: (outcome: string) => string, account?: string) {
        let details: Awaited<ReturnType<GithubApp["installation"]>>;
        try {
            details = await this.app.installation(id);
        } catch (err) {
            logFailure("Reading a GitHub App installation to link it failed", err);
            return { redirect: back("failed"), outcome: "refused" as const };
        }
        const owner = details.account;
        if (!owner?.login || (account !== undefined && owner.login.toLowerCase() !== account.toLowerCase()))
            return { redirect: back("failed"), outcome: "refused" as const };
        const actor: Actor = { name: user.displayName, userId: user.id, via: "web" };
        return this.core.write(actor, async (w) => {
            // Again, as part of the link: their role may have changed while GitHub was being asked.
            if (!(await w.tx.workspaces.get(workspace.id)) || !(await this.maySecrets(w.tx, workspace.id, user.id)))
                return { redirect: back("not-allowed"), outcome: "refused" as const };
            // Already linked to other workspaces is fine: whoever links it here administers the account it's on.
            const existing = await w.tx.githubInstallations.get(id, workspace.id);
            const record: GithubInstallation = {
                id,
                workspaceId: workspace.id,
                accountLogin: owner.login,
                accountType: owner.type ?? "User",
                repositorySelection: details.repository_selection,
                suspended: Boolean(details.suspended_at),
                linkedBy: existing?.linkedBy ?? user.displayName,
                linkedAt: existing?.linkedAt ?? now(),
            };
            await w.tx.githubInstallations.put(record);
            await w.audit({
                workspaceId: workspace.id,
                kind: "settings",
                target: `github-installation:${id}`,
                changes: { linked: { account: record.accountLogin } },
            });
            return { redirect: back("linked"), outcome: "linked" as const };
        });
    }

    async unlink(actor: Actor, workspace: Workspace, id: number) {
        return this.core.write(actor, async (w) => {
            const existing = await w.tx.githubInstallations.get(id, workspace.id);
            if (!existing) throw notFound("No such installation in this workspace.");
            await w.tx.githubInstallations.delete(id, workspace.id);
            await w.audit({
                workspaceId: workspace.id,
                kind: "settings",
                target: `github-installation:${id}`,
                changes: { unlinked: { account: existing.accountLogin } },
            });
            return { unlinked: true };
        });
    }

    // ---- the instance's app ------------------------------------------------------------------------

    async appStatus() {
        const info = await this.app.info();
        return {
            configured: Boolean(info),
            app: info,
            githubUrl: this.core.config.githubUrl,
            webhookUrl: `${this.core.config.publicOrigin}/api/v1/github/app/webhook`,
            deliveries: await this.store.githubDeliveries.list(null, 20),
            refused: this.refused.get(null),
        };
    }

    startManifest(user: User, input: { name: string; public: boolean; org: string | null; ws: string }) {
        if (input.org !== null && !/^[A-Za-z0-9-]{1,39}$/.test(input.org)) throw badRequest("That isn't a GitHub organisation name.");
        if (!/^[\w .()-]{3,34}$/.test(input.name))
            throw badRequest("Name the app with 3 to 34 letters, digits, spaces, dots, dashes or brackets (GitHub's limit).");
        const state = this.app.signState({ purpose: "manifest", userId: user.id, ...input });
        return { formUrl: `/api/v1/instance/github-app/form?state=${encodeURIComponent(state)}` };
    }

    /** A page with a form that posts the app's manifest to GitHub (GitHub's manifest flow needs a POST). */
    manifestForm(user: User, stateValue: string): { html: string; formAction: string } {
        const state = this.app.readState<{ userId: string; name: string; public: boolean; org: string | null; ws: string }>(
            stateValue,
            "manifest",
        );
        if (!state || state.userId !== user.id) throw badRequest("This link has expired. Start again from Settings → GitHub App.");
        const manifest = JSON.stringify(this.app.manifest({ name: state.name, public: state.public }));
        const action = this.app.manifestUrl(state.org, stateValue);
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const where = state.org ? `the ${esc(state.org)} organisation` : "your own GitHub account";
        const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Create the GitHub App · Triagent</title></head>
<body><main>
<h1>Create the GitHub App</h1>
<p>GitHub will ask you to confirm creating <strong>${esc(state.name)}</strong> on ${where}. It can read code and write pull request comments and commit statuses on the repositories it's installed on.</p>
<form method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(manifest)}"><button type="submit">Continue to GitHub</button></form>
<p><a href="/w/${esc(encodeURIComponent(state.ws))}/settings/github-app">Cancel</a></p>
</main></body></html>`;
        return { html, formAction: new URL(this.core.config.githubUrl).origin };
    }

    /** GitHub's redirect after the app is created: exchange the code for its credentials and keep them. */
    async manifestCreated(user: User, query: { code?: string; state?: string }) {
        const state = this.app.readState<{ userId: string; ws: string }>(query.state, "manifest");
        if (!state || state.userId !== user.id)
            throw badRequest("This link has expired or isn't yours. Start again from Settings → GitHub App.");
        if (!query.code) throw badRequest("GitHub didn't send a code.");
        const made = await this.app.convert(query.code);
        const actor: Actor = { name: user.displayName, userId: user.id, via: "web" };
        const app: AppCredentials = {
            appId: made.id,
            slug: made.slug,
            name: made.name,
            clientId: made.client_id,
            htmlUrl: made.html_url,
            owner: made.owner?.login ?? null,
            createdAt: now(),
            createdBy: user.displayName,
            clientSecret: made.client_secret,
            privateKey: made.pem,
            webhookSecret: made.webhook_secret,
        };
        await this.core.write(actor, async (w) => {
            if (await this.app.credentials(w.tx)) throw conflict("A GitHub App is already set up. Remove it first to create another.");
            await this.app.save(w.tx, app);
            await w.audit({
                workspaceId: null,
                kind: "secret",
                target: "github-app",
                changes: { created: { slug: app.slug, id: app.appId } },
            });
        });
        return { redirect: `/w/${encodeURIComponent(state.ws)}/settings/github-app?created=1` };
    }

    async removeApp(actor: Actor) {
        return this.core.write(actor, async (w) => {
            const app = await this.app.credentials(w.tx);
            if (!app) throw notFound("No GitHub App is set up.");
            await this.app.remove(w.tx);
            // Its installations mean nothing without it.
            await w.tx.githubInstallations.deleteAll();
            await w.audit({ workspaceId: null, kind: "secret", target: "github-app", changes: { removed: { slug: app.slug } } });
            return { removed: true };
        });
    }

    // ---- webhook deliveries --------------------------------------------------------------------------

    async recordDelivery(d: Omit<GithubDelivery, "at">): Promise<void> {
        const full: GithubDelivery = { ...d, at: now(), detail: d.detail.slice(0, 500) };
        await this.store.githubDeliveries.add(full, KEEP_DELIVERIES);
        log.info("GitHub delivery", { event: d.event, what: d.what, delivery: d.deliveryId, outcome: d.outcome, detail: full.detail });
    }
}

export function publicInstallation(i: GithubInstallation) {
    return {
        id: i.id,
        account: i.accountLogin,
        accountType: i.accountType,
        repositorySelection: i.repositorySelection,
        suspended: i.suspended,
        linkedBy: i.linkedBy,
        linkedAt: i.linkedAt,
    };
}

export { GitHubError };
