// A project's connection to GitHub, in one of two modes behind one interface (`githubFor`):
//
//  - app: the instance's GitHub App, installed on an account and linked to a workspace; the project picks
//    one of the installation's repositories. Tokens are minted per use and narrowed to that repository.
//  - token: a fine-grained personal access token stored (encrypted) on the project, the fallback.
//
// Also: linking installations to workspaces (only after proving the person can see the installation),
// creating the instance's app, commit statuses and the pull request comment.

import { ROLE_PERMISSIONS } from "@triagent/shared";
import { z } from "zod";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../errors.ts";
import { now, sha256 } from "../../security.ts";
import type { GithubDelivery, GithubInstallation, Project, Repos, User, Workspace } from "../../store/types.ts";
import type { Actor, Core } from "../core.ts";
import type { Projects } from "../projects.ts";
import type { Settings } from "../settings.ts";
import { type AppCredentials, GithubApp } from "./app.ts";
import { type CommitState, GitHubClient, GitHubError, parseRepo, type RepoTarget } from "./client.ts";

const CONNECTION = "github-connection";
const KEEP_DELIVERIES = 50;
export const STATUS_CONTEXT = "Triagent";
export const COMMENT_MARKER = "<!-- triagent-review -->";

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
    /** For reading pull requests and branches, and writing comments and statuses. */
    client: GitHubClient;
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
        if (c.count === 1 || c.count % 100 === 0) console.warn(`GitHub delivery to ${what} refused (${c.count} so far): ${reason}`);
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

export class NotConnected extends ApiError {
    constructor(message: string) {
        super(400, message, { code: "github_not_connected" });
    }
}

export class Github {
    readonly app: GithubApp;
    private readonly core: Core;
    private readonly settings: Settings;
    private readonly projects: Projects;
    readonly refused = new RefusedDeliveries();
    /** Token owners' logins, by a hash of the token, so `GET /user` isn't asked on every comment. */
    private readonly owners = new Map<string, string>();

    constructor(core: Core, settings: Settings, projects: Projects) {
        this.core = core;
        this.settings = settings;
        this.projects = projects;
        this.app = new GithubApp(core);
    }

    private get store() {
        return this.core.store;
    }

    // ---- one interface for both modes ------------------------------------------------------------

    async connection(repos: Repos, project: Project): Promise<AppConnection | null> {
        return ((await repos.settings.get(project.workspaceId, project.id, CONNECTION))?.value as AppConnection | undefined) ?? null;
    }

    cloneUrl(repo: RepoTarget): string {
        return `${this.core.config.githubUrl}/${repo.owner}/${repo.name}.git`;
    }

    /** How to reach the project's repository, or a NotConnected error saying what's missing. */
    async githubFor(project: Project, repos: Repos = this.store): Promise<GithubAccess> {
        const conn = await this.connection(repos, project);
        if (conn) {
            const installation = await repos.githubInstallations.get(conn.installationId);
            if (!installation || installation.workspaceId !== project.workspaceId)
                throw new NotConnected(
                    "The GitHub App installation this project used is no longer linked. Choose a repository again in its GitHub settings.",
                );
            if (installation.suspended)
                throw new NotConnected(`The GitHub App installation on ${installation.accountLogin} is suspended. Unsuspend it on GitHub.`);
            if (!(await this.app.credentials()))
                throw new NotConnected("The instance's GitHub App has been removed. An instance admin can set it up again.");
            const repo = { ...(parseRepo(`https://x/${conn.fullName}`) as RepoTarget), id: conn.repositoryId };
            return {
                mode: "app",
                client: this.app.clientFor(conn.installationId, conn.repositoryId, {
                    contents: "read",
                    metadata: "read",
                    pull_requests: "write",
                    statuses: "write",
                }),
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
        const token = await this.settings.githubToken(repos, project);
        if (!token)
            throw new NotConnected(
                "This project isn't connected to GitHub: pick a repository from the GitHub App, or add a token, in its GitHub settings.",
            );
        const repo = parseRepo(project.repoUrl);
        if (!repo) throw new NotConnected("Set the project's repository address in its General settings first.");
        const client = new GitHubClient(this.core.config.githubApiUrl, async () => token, "token");
        return {
            mode: "token",
            client,
            repo,
            cloneUrl: this.cloneUrl(repo),
            tokenForJob: async () => ({ token, revoke: false }),
            identity: async () => {
                const key = sha256(token);
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
    async upsertComment(project: Project, number: number, body: string, expect: RepoRef | null = null) {
        const gh = await this.reporting(project, expect);
        const author = await gh.identity();
        const state = (await this.store.githubState.get(project.id)) as { comments?: Record<string, number> } | null;
        const known = state?.comments?.[String(number)] ?? null;
        const out = await gh.client.upsertComment(gh.repo, number, COMMENT_MARKER, body, { author, known });
        if (out.id !== known)
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
        return {
            ...base,
            mode: conn ? "app" : base.connection.method === "token" ? "token" : "none",
            app: app ? { available: true, name: app.name, slug: app.slug, htmlUrl: app.htmlUrl } : { available: false },
            installations: installations.map(publicInstallation),
            repository: conn ? { installationId: conn.installationId, repositoryId: conn.repositoryId, fullName: conn.fullName } : null,
        };
    }

    async setConnection(actor: Actor, project: Project, input: { installationId: number; repositoryId: number }) {
        const installation = await this.store.githubInstallations.get(input.installationId);
        if (!installation || installation.workspaceId !== project.workspaceId) throw notFound("No such installation in this workspace.");
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
        const out = [];
        for (const i of items) {
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
            out.push({ ...publicInstallation(i), repositories, error });
        }
        return { items: out };
    }

    /**
     * Where to send a workspace admin to install the app (on GitHub), with a signed state for the way back:
     * to the project's GitHub settings, or (`setup`) into its guided setup.
     */
    async startInstall(actor: Actor, workspace: Workspace, project: string, setup = false) {
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
        });
        return { url: this.app.installUrl(app.slug, state) };
    }

    /**
     * The way back from installing the app. The installation id in the address isn't trusted: the person
     * must have started this from Triagent (the signed state), still be allowed to manage secrets in that
     * workspace, and GitHub must confirm, with their own authorization, that they can see the installation
     * and administer the organisation it's on (or are the account, for a personal one). Returns where to
     * send them next.
     */
    async completeInstall(user: User, query: { code?: string; installation_id?: string; state?: string; setup_action?: string }) {
        const state = this.app.readState<{ userId: string; workspaceId: string; ws: string; project: string; setup?: boolean }>(
            query.state,
            "install",
        );
        if (!state) {
            // Changed on GitHub without starting from Triagent (e.g. repositories added): nothing to link.
            return { redirect: "/", outcome: "ignored" as const };
        }
        const back = (outcome: string) =>
            `/w/${encodeURIComponent(state.ws)}/p/${encodeURIComponent(state.project)}/settings/github?github=${outcome}${state.setup === true ? "&setup=project" : ""}`;
        if (state.userId !== user.id) return { redirect: back("not-you"), outcome: "refused" as const };
        // Still allowed to manage the workspace's secrets (the installation grants access to code).
        const workspace = await this.store.workspaces.get(state.workspaceId);
        const membership = workspace ? await this.store.memberships.get(workspace.id, user.id) : null;
        if (!workspace || !membership || !ROLE_PERMISSIONS[membership.role].includes("secrets"))
            return { redirect: back("not-allowed"), outcome: "refused" as const };
        const id = Number(query.installation_id);
        if (!Number.isSafeInteger(id) || id <= 0 || typeof query.code !== "string" || !query.code)
            return { redirect: back("no-authorization"), outcome: "refused" as const };
        let visible: number[];
        let userToken: string;
        try {
            userToken = await this.app.userToken(query.code);
            visible = await this.app.userInstallations(userToken);
        } catch (err) {
            console.error(`Linking a GitHub App installation failed: ${(err as Error).message}`);
            return { redirect: back("failed"), outcome: "refused" as const };
        }
        if (!visible.includes(id)) return { redirect: back("not-yours"), outcome: "refused" as const };
        const details = await this.app.installation(id);
        // Seeing an installation isn't enough: any member of an organisation can. Linking one hands this
        // workspace every repository in it, so it takes an admin of the organisation, or for a personal
        // account's installation, that person.
        const account = details.account;
        try {
            if (!account) return { redirect: back("failed"), outcome: "refused" as const };
            if (account.type === "Organization") {
                const membership = await this.app.orgMembership(userToken, account.login);
                if (membership?.state !== "active" || membership.role !== "admin")
                    return { redirect: back("not-admin"), outcome: "refused" as const };
            } else if ((await this.app.userLogin(userToken)).toLowerCase() !== account.login.toLowerCase())
                return { redirect: back("not-account"), outcome: "refused" as const };
        } catch (err) {
            console.error(`Checking who may link a GitHub App installation failed: ${(err as Error).message}`);
            const forbidden = err instanceof GitHubError && err.status === 403;
            return { redirect: back(forbidden ? "members-permission" : "failed"), outcome: "refused" as const };
        }
        const actor: Actor = { name: user.displayName, userId: user.id, via: "web" };
        return this.core.write(actor, async (w) => {
            const existing = await w.tx.githubInstallations.get(id);
            if (existing && existing.workspaceId !== workspace.id) return { redirect: back("taken"), outcome: "refused" as const };
            const record: GithubInstallation = {
                id,
                workspaceId: workspace.id,
                accountLogin: details.account?.login ?? "unknown",
                accountType: details.account?.type ?? "User",
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
            const existing = await w.tx.githubInstallations.get(id);
            if (!existing || existing.workspaceId !== workspace.id) throw notFound("No such installation in this workspace.");
            await w.tx.githubInstallations.delete(id);
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
        console.log(
            `GitHub ${d.event ?? "?"}${d.what ? ` (${d.what})` : ""}${d.deliveryId ? ` delivery ${d.deliveryId}` : ""}: ${d.outcome}. ${d.detail}`,
        );
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
