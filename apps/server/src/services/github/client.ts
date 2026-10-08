// A small GitHub REST client on fetch: just the calls Triagent makes. It never logs a token, and its
// errors say what to check, in words for the person reading the settings page.

export class GitHubError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
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
    user: { login: string } | null;
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

interface Comment {
    id: number;
    body?: string;
    user?: { login?: string } | null;
    issue_url?: string;
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
        const url = path.startsWith("http") ? path : `${this.apiUrl}${path}`;
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
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        if (!res.ok) {
            const message = typeof data?.message === "string" ? data.message.slice(0, 300) : res.statusText;
            throw new GitHubError(res.status, `GitHub said ${res.status}: ${message}. ${this.hint(res.status)}`.trim());
        }
        return data as T;
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
     * Our comment on a pull request: the one we remember (`known`) if it's still ours, otherwise the first
     * that `author` wrote starting with the hidden marker (so not a reply quoting it); updated, or created
     * if there's none. Comments by anyone else are never touched: the pull request's author could have
     * planted one with the marker.
     */
    async upsertComment(
        t: RepoTarget,
        number: number,
        marker: string,
        body: string,
        opts: { author: string; known?: number | null },
    ): Promise<{ id: number; created: boolean }> {
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
            if (ours(known)) mine = known;
        }
        for (let page = 1; page <= 30 && !mine; page++) {
            const comments = await this.request<Comment[]>("GET", `${this.r(t)}/issues/${number}/comments?per_page=100&page=${page}`);
            mine = comments.find(ours) ?? null;
            if (comments.length < 100) break;
        }
        if (mine) {
            await this.request("PATCH", `${this.r(t)}/issues/comments/${mine.id}`, { body });
            return { id: mine.id, created: false };
        }
        const made = await this.request<{ id: number }>("POST", `${this.r(t)}/issues/${number}/comments`, { body });
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
