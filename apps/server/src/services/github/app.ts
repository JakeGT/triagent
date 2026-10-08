// The instance's GitHub App: created by an instance admin through GitHub's manifest flow, and stored as
// encrypted instance secrets. It signs JWTs to mint installation tokens, each narrowed to the one
// repository (and the permissions) a call needs. The server's own are cached until shortly before they
// expire; each review gets a fresh one of its own, revoked when the review ends.

import { createHmac, createPrivateKey, hkdfSync, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { ApiError } from "../../errors.ts";
import type { Repos } from "../../store/types.ts";
import type { Core } from "../core.ts";
import type { SecretScope } from "../secrets.ts";
import { GitHubClient, GitHubError } from "./client.ts";

const INSTANCE: SecretScope = { workspaceId: null, projectId: null };
const NAMES = {
    config: "github-app:config",
    clientSecret: "github-app:client-secret",
    privateKey: "github-app:private-key",
    webhookSecret: "github-app:webhook-secret",
} as const;

export interface AppInfo {
    appId: number;
    slug: string;
    name: string;
    clientId: string;
    htmlUrl: string;
    owner: string | null;
    createdAt: string;
    createdBy: string;
}

export interface AppCredentials extends AppInfo {
    clientSecret: string;
    privateKey: string;
    webhookSecret: string;
}

export interface InstallationToken {
    token: string;
    expiresAt: string;
}

/** Permissions an installation token may be narrowed to. */
export type TokenPermissions = Partial<Record<"contents" | "pull_requests" | "statuses" | "metadata", "read" | "write">>;

const base64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class GithubApp {
    private readonly core: Core;
    private cached: { at: number; value: AppCredentials | null } | null = null;
    private readonly tokens = new Map<string, InstallationToken>();
    private readonly stateKey: Buffer;

    constructor(core: Core) {
        this.core = core;
        // Signs the `state` of GitHub redirects. Derived from the secrets key, so every server process agrees.
        this.stateKey = core.config.secretsKey
            ? Buffer.from(hkdfSync("sha256", core.config.secretsKey, Buffer.alloc(0), "triagent:github-state", 32))
            : randomBytes(32);
    }

    get apiUrl(): string {
        return this.core.config.githubApiUrl;
    }

    get webUrl(): string {
        return this.core.config.githubUrl;
    }

    // ---- stored credentials ----------------------------------------------------------------

    /** The app's id, keys and secrets, or null if none is set up. Cached briefly. */
    async credentials(repos: Repos = this.core.store): Promise<AppCredentials | null> {
        if (this.cached && Date.now() - this.cached.at < 30_000 && repos === this.core.store) return this.cached.value;
        const reveal = (name: string) => this.core.secrets.reveal(repos, INSTANCE, name);
        const config = await reveal(NAMES.config);
        let value: AppCredentials | null = null;
        if (config) {
            const [clientSecret, privateKey, webhookSecret] = await Promise.all([
                reveal(NAMES.clientSecret),
                reveal(NAMES.privateKey),
                reveal(NAMES.webhookSecret),
            ]);
            if (clientSecret && privateKey && webhookSecret)
                value = { ...(JSON.parse(config) as AppInfo), clientSecret, privateKey, webhookSecret };
        }
        if (repos === this.core.store) this.cached = { at: Date.now(), value };
        return value;
    }

    async info(): Promise<AppInfo | null> {
        const c = await this.credentials();
        if (!c) return null;
        const { clientSecret: _c, privateKey: _p, webhookSecret: _w, ...info } = c;
        return info;
    }

    async save(tx: Repos, app: AppCredentials): Promise<void> {
        const { clientSecret, privateKey, webhookSecret, ...info } = app;
        await this.core.secrets.set(tx, INSTANCE, NAMES.config, JSON.stringify(info), app.createdBy);
        await this.core.secrets.set(tx, INSTANCE, NAMES.clientSecret, clientSecret, app.createdBy);
        await this.core.secrets.set(tx, INSTANCE, NAMES.privateKey, privateKey, app.createdBy);
        await this.core.secrets.set(tx, INSTANCE, NAMES.webhookSecret, webhookSecret, app.createdBy);
        this.core.store.afterCommit(() => this.forget());
    }

    async remove(tx: Repos): Promise<void> {
        for (const name of Object.values(NAMES)) await this.core.secrets.clear(tx, INSTANCE, name);
        this.core.store.afterCommit(() => this.forget());
    }

    /** Drop cached credentials and tokens (after the app changes). */
    forget(): void {
        this.cached = null;
        this.tokens.clear();
    }

    // ---- JWTs and installation tokens ----------------------------------------------------------

    /** A JWT for the app itself (RS256, valid for nine minutes, issued a minute in the past for clock skew). */
    static jwt(appId: number, privateKeyPem: string, now = Date.now()): string {
        const iat = Math.floor(now / 1000) - 60;
        const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
        const body = base64url(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) }));
        const signature = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), createPrivateKey(privateKeyPem));
        return `${head}.${body}.${base64url(signature)}`;
    }

    private async appClient(): Promise<GitHubClient> {
        const app = await this.credentials();
        if (!app)
            throw new ApiError(400, "No GitHub App is set up on this instance. An instance admin can create one in Settings → GitHub App.");
        return new GitHubClient(this.apiUrl, async () => GithubApp.jwt(app.appId, app.privateKey), "app");
    }

    /** An installation's account, repository selection and whether it's suspended. */
    async installation(id: number) {
        return (await this.appClient()).request<{
            id: number;
            account: { login: string; type: string } | null;
            repository_selection: string;
            suspended_at: string | null;
        }>("GET", `/app/installations/${id}`);
    }

    /**
     * An installation token, narrowed to `repositoryIds` and `permissions` when given. Reused until five
     * minutes before it expires.
     */
    async installationToken(installationId: number, narrow: { repositoryIds?: number[]; permissions?: TokenPermissions } = {}) {
        const key = JSON.stringify([installationId, narrow.repositoryIds ?? null, narrow.permissions ?? null]);
        const hit = this.tokens.get(key);
        if (hit && Date.parse(hit.expiresAt) - Date.now() > 5 * 60_000) return hit;
        const token = await this.mintToken(installationId, narrow);
        this.tokens.set(key, token);
        if (this.tokens.size > 500) this.tokens.delete(this.tokens.keys().next().value as string);
        return token;
    }

    /** A new installation token, never cached or reused: for one review, which revokes it when it ends. */
    async mintToken(
        installationId: number,
        narrow: { repositoryIds?: number[]; permissions?: TokenPermissions } = {},
    ): Promise<InstallationToken> {
        const made = await (await this.appClient()).request<{ token: string; expires_at: string }>(
            "POST",
            `/app/installations/${installationId}/access_tokens`,
            {
                ...(narrow.repositoryIds ? { repository_ids: narrow.repositoryIds } : {}),
                ...(narrow.permissions ? { permissions: narrow.permissions } : {}),
            },
        );
        return { token: made.token, expiresAt: made.expires_at };
    }

    /** Revoke an installation token before it expires (the token authenticates its own revocation). */
    async revokeToken(token: string): Promise<void> {
        await new GitHubClient(this.apiUrl, async () => token, "app").request("DELETE", "/installation/token");
    }

    /** A client acting as an installation, for one repository. */
    clientFor(installationId: number, repositoryId: number | null, permissions?: TokenPermissions): GitHubClient {
        return new GitHubClient(
            this.apiUrl,
            async () =>
                (
                    await this.installationToken(installationId, {
                        ...(repositoryId ? { repositoryIds: [repositoryId] } : {}),
                        ...(permissions ? { permissions } : {}),
                    })
                ).token,
            "app",
        );
    }

    /** The repositories an installation can reach. */
    async repositories(installationId: number) {
        const client = this.clientFor(installationId, null);
        return client.all<{ id: number; full_name: string; private: boolean; default_branch: string; html_url: string }>(
            "/installation/repositories",
            1000,
            (page) => (page as { repositories: never[] }).repositories,
        );
    }

    // ---- the manifest flow -------------------------------------------------------------------

    manifest(input: { name: string; public: boolean }) {
        const origin = this.core.config.publicOrigin;
        return {
            name: input.name,
            url: origin,
            description: "Runs Open Code Review on pull requests and posts what it finds to Triagent.",
            public: input.public,
            hook_attributes: { url: `${origin}/api/v1/github/app/webhook`, active: true },
            redirect_url: `${origin}/api/v1/instance/github-app/created`,
            callback_urls: [`${origin}/api/v1/github/app/installed`],
            setup_url: `${origin}/api/v1/github/app/installed`,
            setup_on_update: true,
            // People linking an installation to a workspace prove they can see it with this authorization.
            request_oauth_on_install: true,
            // members: read, so linking an organisation's installation can check the person administers it.
            default_permissions: { contents: "read", metadata: "read", members: "read", pull_requests: "write", statuses: "write" },
            default_events: ["pull_request", "push", "create", "delete"],
        };
    }

    /** Where the manifest is posted: the person's own account, or an organisation they administer. */
    manifestUrl(org: string | null, state: string): string {
        const path = org ? `/organizations/${encodeURIComponent(org)}/settings/apps/new` : "/settings/apps/new";
        return `${this.webUrl}${path}?state=${encodeURIComponent(state)}`;
    }

    /** Turn the code GitHub hands back after the manifest flow into the new app's credentials. */
    async convert(code: string) {
        if (!/^[\w-]{1,100}$/.test(code)) throw new ApiError(400, "That isn't a code GitHub sends.");
        const res = await fetch(`${this.apiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
            method: "POST",
            headers: { Accept: "application/vnd.github+json", "User-Agent": "triagent", "X-GitHub-Api-Version": "2022-11-28" },
            signal: AbortSignal.timeout(20_000),
        }).catch((err: Error) => {
            throw new GitHubError(0, `Couldn't reach GitHub (${err.message}).`);
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) throw new GitHubError(res.status, `GitHub didn't create the app (${res.status}: ${String(data.message ?? "")}).`);
        return data as {
            id: number;
            slug: string;
            name: string;
            client_id: string;
            client_secret: string;
            webhook_secret: string;
            pem: string;
            html_url: string;
            owner?: { login?: string } | null;
        };
    }

    installUrl(slug: string, state: string): string {
        return `${this.webUrl}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
    }

    /** Exchange the user authorization code from an installation's redirect for that person's token. */
    async userToken(code: string): Promise<string> {
        const app = await this.credentials();
        if (!app) throw new ApiError(400, "No GitHub App is set up on this instance.");
        const res = await fetch(`${this.webUrl}/login/oauth/access_token`, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "triagent" },
            body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }),
            signal: AbortSignal.timeout(20_000),
        }).catch((err: Error) => {
            throw new GitHubError(0, `Couldn't reach GitHub (${err.message}).`);
        });
        const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
        if (!res.ok || typeof data.access_token !== "string")
            throw new GitHubError(res.status, `GitHub didn't confirm who you are (${data.error_description ?? res.status}).`);
        return data.access_token;
    }

    /** The login of the person a user token belongs to. */
    async userLogin(userToken: string): Promise<string> {
        const me = await new GitHubClient(this.apiUrl, async () => userToken, "user").viewer();
        if (typeof me?.login !== "string" || !me.login) throw new GitHubError(502, "GitHub didn't say who you are.");
        return me.login;
    }

    /**
     * A person's membership of an organisation, from their own token (null if they aren't a member).
     * The app needs the "Organization members: read" permission for GitHub to answer.
     */
    async orgMembership(userToken: string, org: string): Promise<{ state: string; role: string } | null> {
        const client = new GitHubClient(this.apiUrl, async () => userToken, "user");
        try {
            return await client.request<{ state: string; role: string }>("GET", `/user/memberships/orgs/${encodeURIComponent(org)}`);
        } catch (err) {
            if (err instanceof GitHubError && err.status === 404) return null;
            throw err;
        }
    }

    /** Ids of the installations a person's token can see. */
    async userInstallations(userToken: string): Promise<number[]> {
        const client = new GitHubClient(this.apiUrl, async () => userToken, "user");
        const items = await client.all<{ id: number }>(
            "/user/installations",
            1000,
            (page) => (page as { installations: never[] }).installations,
        );
        return items.map((i) => i.id);
    }

    // ---- signed state ------------------------------------------------------------------------

    /** A signed, expiring value for a GitHub redirect, so its callback can trust what it carries. */
    signState(payload: Record<string, unknown>, ttlMs = 15 * 60_000): string {
        const body = base64url(JSON.stringify({ ...payload, exp: Date.now() + ttlMs, nonce: randomBytes(9).toString("base64url") }));
        const mac = createHmac("sha256", this.stateKey).update(body).digest("base64url");
        return `${body}.${mac}`;
    }

    /** The payload of a state this server signed, if it's genuine, unexpired and for `purpose`. */
    readState<T extends Record<string, unknown>>(state: unknown, purpose: string): T | null {
        if (typeof state !== "string" || state.length > 2000) return null;
        const [body, mac] = state.split(".");
        if (!body || !mac) return null;
        const expected = Buffer.from(createHmac("sha256", this.stateKey).update(body).digest("base64url"));
        const given = Buffer.from(mac);
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
        try {
            const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number; purpose: string };
            if (payload.purpose !== purpose || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
            return payload;
        } catch {
            return null;
        }
    }
}
