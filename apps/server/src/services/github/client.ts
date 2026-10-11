// A small GitHub REST client on fetch: just the calls Triagent makes. It never logs a token, and its
// errors say what to check, in words for the person reading the settings page.

import { MAX_DIFF_BYTES } from "../../domain/review-triggers.ts";

export class GitHubError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "GitHubError";
        this.status = status;
    }
}

/** A repository, as owner/name (and GitHub's numeric id when known). */
export interface RepoTarget {
    owner: string;
    name: string;
    fullName: string;
    id: number | null;
}

/** owner/name from a repository address (https or SSH form), whatever its host. */
export function parseRepo(url: string | null | undefined): RepoTarget | null {
    const m =
        /^https?:\/\/[^/\s]+\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url ?? "") ??
        /^(?:ssh:\/\/)?[\w.-]+@[\w.-]+[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url ?? "");
    if (!m) return null;
    const [, owner, name] = m as unknown as [string, string, string];
    if (owner.startsWith(".") || name.startsWith(".")) return null;
    return { owner, name, fullName: `${owner}/${name}`, id: null };
}

export interface Pull {
    number: number;
    title: string;
    state: string;
    draft?: boolean;
    html_url: string;
    user: { login: string; type?: string } | null;
    labels?: { name?: string }[];
    /** How the author relates to the repository: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE… */
    author_association?: string;
    head: { ref: string; sha: string; repo: { full_name: string } | null };
    base: { ref: string; sha: string; repo: { full_name: string } | null };
    updated_at?: string;
}

export interface Repo {
    id: number;
    full_name: string;
    default_branch: string;
    private: boolean;
    html_url: string;
}

export type CommitState = "pending" | "success" | "failure" | "error";

export interface Comment {
    id: number;
    body?: string;
    user?: { login?: string } | null;
    /** How the comment's author relates to the repository (as for a pull request's author). */
    author_association?: string;
    issue_url?: string;
    created_at?: string;
}

/** How the client authenticates: a personal access token, an installation token, an app JWT or a user's token. */
export type Credential = "token" | "app" | "user";

const seg = (s: string) => s.split("/").map(encodeURIComponent).join("/");

export class GitHubClient {
    private readonly apiUrl: string;
    private readonly auth: () => Promise<string>;
    private readonly credential: Credential;

    constructor(apiUrl: string, auth: () => Promise<string>, credential: Credential = "token") {
        this.apiUrl = apiUrl;
        this.auth = auth;
        this.credential = credential;
    }

    private hint(status: number): string {
        if (status === 401)
            return this.credential === "token"
                ? "The token was refused: check it hasn't expired or been revoked."
                : "GitHub refused the app's credentials: check the GitHub App on the instance settings.";
        if (status === 403 || status === 404)
            return this.credential === "token"
                ? "The token can't see this, or lacks a permission it needs (Contents: read; Pull requests and Commit statuses: read and write)."
                : "The GitHub App can't see this: check the repository is included in its installation, and that the installation isn't suspended.";
        return "";
    }

    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        // Only ever the API's own paths: the credential must never go anywhere else.
        if (!path.startsWith("/")) throw new GitHubError(0, "GitHub API paths start with /.");
        const url = `${this.apiUrl}${path}`;
        let res: Response;
        try {
            res = await fetch(url, {
                method,
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${await this.auth()}`,
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "triagent",
                    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(20_000),
            });
        } catch (err) {
            if (err instanceof GitHubError) throw err;
            throw new GitHubError(0, `Couldn't reach GitHub (${(err as Error).message}).`);
        }
        if (res.status === 204) return null as T;
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        if (res.ok && (data === null || typeof data !== "object")) throw new GitHubError(502, "GitHub sent something other than JSON.");
        if (!res.ok) {
            const message = typeof data?.message === "string" ? data.message.slice(0, 300) : res.statusText;
            throw new GitHubError(res.status, `GitHub said ${res.status}: ${message}. ${this.hint(res.status)}`.trim());
        }
        return data as T;
    }

    /**
     * A diff, as text (GitHub's diff media type), or null when it's too large: GitHub refuses one over its
     * own limits (406), and nothing over `MAX_DIFF_BYTES` is read.
     */
    private async diff(path: string): Promise<string | null> {
        let res: Response;
        try {
            res = await fetch(`${this.apiUrl}${path}`, {
                headers: {
                    Accept: "application/vnd.github.diff",
                    Authorization: `Bearer ${await this.auth()}`,
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "triagent",
                },
                signal: AbortSignal.timeout(20_000),
            });
        } catch (err) {
            if (err instanceof GitHubError) throw err;
            throw new GitHubError(0, `Couldn't reach GitHub (${(err as Error).message}).`);
        }
        if (res.status === 406 || res.status === 422) {
            await res.body?.cancel().catch(() => {});
            return null;
        }
        if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            throw new GitHubError(res.status, `GitHub said ${res.status} for a diff. ${this.hint(res.status)}`.trim());
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = res.body?.getReader();
        try {
            for (;;) {
                const part = await reader?.read();
                if (!part || part.done) break;
                size += part.value.byteLength;
                if (size > MAX_DIFF_BYTES) {
                    await reader?.cancel().catch(() => {});
                    return null;
                }
                chunks.push(part.value);
            }
        } catch (err) {
            throw new GitHubError(0, `Couldn't read a diff from GitHub (${(err as Error).message}).`);
        }
        return Buffer.concat(chunks).toString("utf8");
    }

    /** Every page of a list (100 at a time), up to `max` items. */
    async all<T>(path: string, max = 5000, pick?: (page: unknown) => T[]): Promise<T[]> {
        const out: T[] = [];
        for (let page = 1; out.length < max; page++) {
            const raw = await this.request<unknown>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
            const items = pick ? pick(raw) : (raw as T[]);
            if (!Array.isArray(items)) throw new GitHubError(502, "GitHub sent something other than a list.");
            out.push(...items);
            if (items.length < 100) break;
        }
        return out.slice(0, max);
    }

    private r(t: RepoTarget): string {
        return `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.name)}`;
    }

    repo(t: RepoTarget): Promise<Repo> {
        return this.request("GET", this.r(t));
    }

    /** Open pull requests, most recently updated first, a page of 100 at a time, up to `max`. */
    openPulls(t: RepoTarget, max = 1000): Promise<Pull[]> {
        return this.all(`${this.r(t)}/pulls?state=open&sort=updated&direction=desc`, max);
    }

    pull(t: RepoTarget, number: number): Promise<Pull> {
        return this.request("GET", `${this.r(t)}/pulls/${number}`);
    }

    /** Every branch, as name → head commit. */
    async branches(t: RepoTarget): Promise<Record<string, string>> {
        const items = await this.all<{ name: string; commit?: { sha?: string } }>(`${this.r(t)}/branches`);
        return Object.fromEntries(items.map((b) => [b.name, b.commit?.sha ?? ""]));
    }

    branch(t: RepoTarget, name: string): Promise<{ name: string; commit: { sha: string } }> {
        return this.request("GET", `${this.r(t)}/branches/${seg(name)}`);
    }

    /** How `head` relates to `base`: ahead_by is how many commits head has that base doesn't. */
    compare(t: RepoTarget, base: string, head: string): Promise<{ ahead_by: number; behind_by: number; status: string }> {
        return this.request("GET", `${this.r(t)}/compare/${seg(base)}...${seg(head)}`);
    }

    /**
     * What a pull request changes at `head`: the diff from where it left `base` (as GitHub shows a pull
     * request's), for that commit whatever the pull request's head is by now. Null when it's too large.
     */
    compareDiff(t: RepoTarget, base: string, head: string): Promise<string | null> {
        return this.diff(`${this.r(t)}/compare/${seg(base)}...${seg(head)}`);
    }

    /**
     * The files a pull request changes (a renamed file under both names), or null when there are more
     * than `max`.
     */
    async pullFiles(t: RepoTarget, number: number, max = 300): Promise<string[] | null> {
        const files = await this.all<{ filename: string; previous_filename?: string }>(`${this.r(t)}/pulls/${number}/files`, max + 1);
        if (files.length > max) return null;
        return files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
    }

    /** The check runs on a commit (the latest of each name), up to 300. */
    checkRuns(t: RepoTarget, sha: string): Promise<{ name: string; status: string; conclusion: string | null }[]> {
        return this.all(
            `${this.r(t)}/commits/${encodeURIComponent(sha)}/check-runs?filter=latest`,
            300,
            (page) => (page as { check_runs: never[] }).check_runs,
        );
    }

    /** The commit statuses on a commit: the latest of each context (the first 100). */
    async statuses(
        t: RepoTarget,
        sha: string,
    ): Promise<{ context: string; state: string; description?: string | null; target_url?: string | null }[]> {
        const combined = await this.request<{ statuses?: never[] }>(
            "GET",
            `${this.r(t)}/commits/${encodeURIComponent(sha)}/status?per_page=100`,
        );
        return Array.isArray(combined.statuses) ? combined.statuses : [];
    }

    /** Comments on the repository's issues and pull requests changed since `since`, oldest first: one page of up to 100. */
    commentsSince(t: RepoTarget, since: string): Promise<Comment[]> {
        return this.request(
            "GET",
            `${this.r(t)}/issues/comments?sort=created&direction=asc&since=${encodeURIComponent(since)}&per_page=100`,
        );
    }

    createComment(t: RepoTarget, number: number, body: string): Promise<{ id: number }> {
        return this.request("POST", `${this.r(t)}/issues/${number}/comments`, { body });
    }

    /** Take a label off a pull request (fine if it's already gone). */
    async removeLabel(t: RepoTarget, number: number, label: string): Promise<void> {
        await this.request("DELETE", `${this.r(t)}/issues/${number}/labels/${encodeURIComponent(label)}`).catch((err: unknown) => {
            if (!(err instanceof GitHubError && err.status === 404)) throw err;
        });
    }

    /**
     * Our comment on a pull request: the one we remember (`known`) if it's still ours, otherwise the first
     * that `author` wrote starting with the hidden marker (so not a reply quoting it); updated, or created
     * if there's none. Comments by anyone else are never touched: the pull request's author could have
     * planted one with the marker. `body` can be worked out from the comment as it is (to add a line to
     * it); with `onlyIfThere`, nothing is created when there's none, and the answer is null.
     */
    async upsertComment(
        t: RepoTarget,
        number: number,
        marker: string,
        body: string | ((current: string) => string),
        opts: { author: string; known?: number | null; onlyIfThere?: boolean },
    ): Promise<{ id: number; created: boolean } | null> {
        const ours = (c: Comment | null): c is Comment =>
            Boolean(
                c &&
                    typeof c.body === "string" &&
                    c.body.startsWith(marker) &&
                    c.user?.login?.toLowerCase() === opts.author.toLowerCase() &&
                    (c.issue_url === undefined || c.issue_url.endsWith(`/issues/${number}`)),
            );
        let mine: Comment | null = null;
        if (opts.known) {
            const known = await this.request<Comment>("GET", `${this.r(t)}/issues/comments/${opts.known}`).catch((err: unknown) => {
                if (err instanceof GitHubError && err.status === 404) return null;
                throw err;
            });
            // Fetched by id, so it must say which pull request it's on: never another's.
            if (ours(known) && known.issue_url?.endsWith(`/issues/${number}`)) mine = known;
        }
        for (let page = 1; page <= 30 && !mine; page++) {
            const comments = await this.request<Comment[]>("GET", `${this.r(t)}/issues/${number}/comments?per_page=100&page=${page}`);
            mine = comments.find(ours) ?? null;
            if (comments.length < 100) break;
        }
        const text = typeof body === "function" ? body(mine?.body ?? "") : body;
        if (mine) {
            if (text !== mine.body) await this.request("PATCH", `${this.r(t)}/issues/comments/${mine.id}`, { body: text });
            return { id: mine.id, created: false };
        }
        if (opts.onlyIfThere) return null;
        const made = await this.createComment(t, number, text);
        return { id: made.id, created: true };
    }

    setStatus(t: RepoTarget, sha: string, s: { state: CommitState; description: string; context: string; targetUrl?: string | null }) {
        return this.request("POST", `${this.r(t)}/statuses/${encodeURIComponent(sha)}`, {
            state: s.state,
            description: s.description.slice(0, 140),
            context: s.context,
            ...(s.targetUrl ? { target_url: s.targetUrl } : {}),
        });
    }

    /** The account the credential belongs to (personal access tokens and user tokens only). */
    viewer(): Promise<{ login: string }> {
        return this.request("GET", "/user");
    }
}
