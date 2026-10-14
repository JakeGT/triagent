// A workspace's GitHub settings: how its projects reach GitHub when they don't say otherwise (the instance's
// GitHub App, or a token the workspace keeps), and which GitHub server that is (github.com, as the instance
// is set up, or the workspace's own GitHub Enterprise Server).
//
// A project's own choice wins: a repository picked from the app, or a token of its own. Without either, a
// workspace set to "token" lends its token to the project's repository address.
//
// A GitHub Enterprise address is fetched by the server and cloned from by runners, so like model URLs it
// must be https and resolve to public addresses (services/model-urls.ts), checked when saved and again
// before use; ALLOW_PRIVATE_GITHUB_URLS=true allows private ones (a server on the company network). Every
// token in the workspace goes to that server, so changing it takes permission to manage secrets, and the
// workspace's token is forgotten (never sent to the new server to check it).

import { ApiError, badRequest, forbidden } from "../../errors.ts";
import type { Repos, Workspace } from "../../store/types.ts";
import type { Actor, Core } from "../core.ts";
import { checkModelUrl, defaultLookup, type Lookup, UnsafeUrl } from "../model-urls.ts";
import type { SecretScope, SecretView } from "../secrets.ts";
import { GitHubClient, GitHubError } from "./client.ts";

const KEY = "github";
const TOKEN = "github-token";
const RECHECK_MS = 10 * 60_000;

export type GithubMethod = "app" | "token";
export type TokenKind = "fine-grained" | "classic" | "oauth";

interface Stored {
    method: GithubMethod;
    /** A GitHub Enterprise Server's address (https://github.example.com), or null for the instance's GitHub. */
    server: string | null;
    /** Who the workspace's token belongs to, and what kind it is, as found when it was saved. */
    owner: string | null;
    kind: TokenKind | null;
}

/** Where a workspace's GitHub is: its web address (for links and cloning) and its REST API's. */
export interface GithubServer {
    url: string;
    apiUrl: string;
    /** A workspace's own GitHub Enterprise Server, not the instance's. */
    own: boolean;
}

/** The kind of token, or a message saying why it can't be used. */
export function tokenKind(token: string): TokenKind | string {
    if (/^github_pat_[A-Za-z0-9_]{20,255}$/.test(token)) return "fine-grained";
    if (/^ghp_[A-Za-z0-9_]{20,255}$/.test(token) || /^[0-9a-f]{40}$/.test(token)) return "classic";
    if (/^gh[ou]_[A-Za-z0-9_]{20,255}$/.test(token)) return "oauth";
    if (/^gh[sr]_/.test(token))
        return "That's a GitHub App's own token, which expires within hours. Use a fine-grained or classic personal access token.";
    return "That doesn't look like a GitHub token (fine-grained tokens start with github_pat_, classic ones with ghp_).";
}

/** An address's origin as given (no lookups), or the input itself when it isn't one: for comparing. */
function originOf(raw: string): string {
    try {
        return new URL(raw.trim()).origin;
    } catch {
        return raw.trim();
    }
}

export class WorkspaceGithub {
    private readonly core: Core;
    private readonly lookup: Lookup;
    /** Enterprise addresses checked lately, so each use doesn't wait for DNS. */
    private readonly checked = new Map<string, number>();

    constructor(core: Core, lookup: Lookup = defaultLookup) {
        this.core = core;
        this.lookup = lookup;
    }

    private scope(workspaceId: string): SecretScope {
        return { workspaceId, projectId: null };
    }

    async stored(repos: Repos, workspaceId: string): Promise<Stored> {
        const v = (await repos.settings.get(workspaceId, null, KEY))?.value as Partial<Stored> | undefined;
        return {
            method: v?.method === "token" ? "token" : "app",
            server: typeof v?.server === "string" ? v.server : null,
            owner: typeof v?.owner === "string" ? v.owner : null,
            kind: v?.kind === "fine-grained" || v?.kind === "classic" || v?.kind === "oauth" ? v.kind : null,
        };
    }

    /** The address, tidied, if it's one tokens may be sent to; otherwise a 400 saying why. */
    async checkServer(raw: string): Promise<string> {
        let url: string;
        try {
            url = await checkModelUrl(
                raw,
                {
                    allowPrivate: this.core.config.allowPrivateGithubUrls,
                    lookup: this.lookup,
                    sends: "GitHub tokens",
                    flag: "ALLOW_PRIVATE_GITHUB_URLS",
                    secretField: "token field",
                },
                "The GitHub Enterprise address",
            );
        } catch (err) {
            if (err instanceof UnsafeUrl) throw badRequest(err.message);
            throw err;
        }
        const parsed = new URL(url);
        if (parsed.pathname !== "/")
            throw badRequest("Give the GitHub Enterprise server's own address, like https://github.example.com, with no path.");
        this.checked.set(parsed.origin, Date.now());
        return parsed.origin;
    }

    /** The workspace's GitHub server, checked again now and then (an address can come to resolve elsewhere). */
    async server(repos: Repos, workspaceId: string): Promise<GithubServer> {
        const { server } = await this.stored(repos, workspaceId);
        return this.serverAt(server);
    }

    async serverAt(server: string | null): Promise<GithubServer> {
        if (!server) return { url: this.core.config.githubUrl, apiUrl: this.core.config.githubApiUrl, own: false };
        const at = this.checked.get(server);
        if (at === undefined || Date.now() - at > RECHECK_MS) {
            await this.checkServer(server);
            if (this.checked.size > 1000) this.checked.delete(this.checked.keys().next().value as string);
        }
        return { url: server, apiUrl: `${server}/api/v3`, own: true };
    }

    /** The token the workspace lends its projects, when it's set to use one. Never put it in a response or a log. */
    async token(repos: Repos, workspaceId: string): Promise<string | null> {
        const { method } = await this.stored(repos, workspaceId);
        if (method !== "token") return null;
        return this.core.secrets.reveal(repos, this.scope(workspaceId), TOKEN);
    }

    async view(workspaceId: string, appAvailable: boolean) {
        const repos = this.core.store;
        const s = await this.stored(repos, workspaceId);
        const token: SecretView = await this.core.secrets.view(repos, this.scope(workspaceId), TOKEN);
        return {
            method: s.method,
            server: s.server,
            defaultServer: this.core.config.githubUrl,
            token: { ...token, owner: token.set ? s.owner : null, kind: token.set ? s.kind : null },
            // The instance's app lives on the instance's GitHub, so a workspace on its own server can't use it.
            appAvailable: appAvailable && !s.server,
            instanceApp: appAvailable,
        };
    }

    /** Who a token belongs to on a server; a 400 when GitHub turns it down. */
    private async owner(token: string, server: GithubServer): Promise<string> {
        const client = new GitHubClient(server.apiUrl, async () => token, "token");
        try {
            const { login } = await client.viewer();
            if (typeof login !== "string" || !login) throw new GitHubError(502, "GitHub didn't say who the token belongs to.");
            return login;
        } catch (err) {
            if (err instanceof GitHubError && (err.status === 401 || err.status === 403))
                throw badRequest(`${server.own ? server.url : "GitHub"} turned the token down: check it hasn't expired or been revoked.`);
            // GitHub away, slow or rate limiting: not the token's fault, and worth trying again.
            if (err instanceof GitHubError && (err.status === 0 || err.status === 429 || err.status >= 500))
                throw new ApiError(502, `Couldn't check the token with ${server.url} just now: ${err.message} Try again in a moment.`);
            if (err instanceof GitHubError) throw badRequest(`Couldn't check the token with ${server.url}: ${err.message}`);
            throw err;
        }
    }

    /**
     * `maySecrets`: whether the actor may set secrets. Every token in the workspace (its own and its
     * projects') is sent to its server, so moving it is as sensitive as setting one: it takes that
     * permission, and the workspace's token is forgotten rather than sent to the new server.
     */
    async save(
        actor: Actor,
        workspace: Workspace,
        input: { method: GithubMethod; server: string | null },
        appAvailable: boolean,
        maySecrets: boolean,
    ) {
        const before = await this.stored(this.core.store, workspace.id);
        // Who may move it is checked first: nothing is looked up for someone who can't.
        const asked = input.server?.trim() ? originOf(input.server) : null;
        if (asked !== before.server && !maySecrets)
            throw forbidden("Changing the GitHub server sends the workspace's tokens there, so it takes permission to manage secrets.");
        const server = input.server?.trim() ? await this.checkServer(input.server) : null;
        if (server && new URL(server).origin === new URL(this.core.config.githubUrl).origin)
            throw badRequest(`${server} is this instance's own GitHub: leave the address empty to use it.`);
        if (input.method === "app" && server)
            throw badRequest("The instance's GitHub App is on its own GitHub, not on a GitHub Enterprise server. Use a token there.");
        if (input.method === "app" && !appAvailable)
            throw badRequest("This instance has no GitHub App. An instance admin can set one up, or use a token.");
        const moving = server !== before.server;
        if (moving && !maySecrets) throw forbidden("Changing the GitHub server takes permission to manage secrets.");
        return this.core.write(actor, async (w) => {
            // One server's token is no use on another, and isn't sent there to find out.
            if (moving) await this.core.secrets.clear(w.tx, this.scope(workspace.id), TOKEN);
            const value: Stored = {
                method: input.method,
                server,
                owner: moving ? null : before.owner,
                kind: moving ? null : before.kind,
            };
            await w.tx.settings.put({ workspaceId: workspace.id, projectId: null, key: KEY, value });
            await w.audit({
                workspaceId: workspace.id,
                kind: "settings",
                target: KEY,
                changes: {
                    ...(before.method !== value.method ? { method: { from: before.method, to: value.method } } : {}),
                    ...(moving ? { server: { from: before.server, to: value.server }, [TOKEN]: "cleared" } : {}),
                },
            });
            return value;
        });
    }

    async setToken(actor: Actor, workspace: Workspace, raw: string | null) {
        const repos = this.core.store;
        const token = raw === null ? null : raw.trim();
        let owner: string | null = null;
        let kind: TokenKind | null = null;
        if (token !== null) {
            const k = tokenKind(token);
            if (k !== "fine-grained" && k !== "classic" && k !== "oauth") throw badRequest(k);
            kind = k;
            owner = await this.owner(token, await this.server(repos, workspace.id));
        }
        return this.core.write(actor, async (w) => {
            const scope = this.scope(workspace.id);
            if (token === null) await this.core.secrets.clear(w.tx, scope, TOKEN);
            else await this.core.secrets.set(w.tx, scope, TOKEN, token, actor.name);
            const current = await this.stored(w.tx, workspace.id);
            await w.tx.settings.put({ workspaceId: workspace.id, projectId: null, key: KEY, value: { ...current, owner, kind } });
            await w.audit({
                workspaceId: workspace.id,
                kind: "secret",
                target: `workspace:${TOKEN}`,
                changes: { [TOKEN]: token === null ? "cleared" : `set (${kind}, ${owner})` },
            });
            const view = await this.core.secrets.view(w.tx, scope, TOKEN);
            return { ...view, owner, kind };
        });
    }
}
