// Getting the code to review: a bare mirror per repository in the cache directory (so fetches are
// quick), and a throwaway worktree per review.
//
// The token is sent as an HTTP header scoped to the repository's host, through GIT_CONFIG_* variables:
// never on a command line (where other processes could read it) or in a remote URL (which git would
// store). Hooks are off, submodules aren't fetched, LFS doesn't run, redirects aren't followed, and only
// the clone URL's own protocol is allowed.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { run, start } from "./process.ts";

/** Reviews read .gitattributes from the base commit (GIT_ATTR_SOURCE), which needs git 2.42 or later. */
export const MIN_GIT = { major: 2, minor: 42 };

/** Why this git can't run reviews, from `git --version`, or null if it can. */
export function gitVersionProblem(versionOutput: string): string | null {
    const m = /git version (\d+)\.(\d+)/.exec(versionOutput);
    const need = `${MIN_GIT.major}.${MIN_GIT.minor}`;
    if (!m)
        return `Couldn't tell which version of git this is ("${versionOutput.trim().slice(0, 80)}"). Reviews need git ${need} or later.`;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major > MIN_GIT.major || (major === MIN_GIT.major && minor >= MIN_GIT.minor)) return null;
    return `git ${major}.${minor} is too old: reviews need git ${need} or later, so that a pull request's own .gitattributes can't hide its changes (GIT_ATTR_SOURCE). Install a newer git.`;
}

/** Run `git --version`; throws with the reason if this git can't run reviews. */
export async function requireGit(gitBin: string, pathEnv: string): Promise<string> {
    const exit = await start(gitBin, ["--version"], { env: { PATH: pathEnv }, timeoutMs: 15_000 }).done;
    if (exit.code !== 0) throw new Error(`Couldn't run ${gitBin} --version: ${exit.stderr.trim() || `exit ${exit.code}`}.`);
    const problem = gitVersionProblem(exit.stdout);
    if (problem) throw new Error(problem);
    return exit.stdout.trim();
}

/** OCR treats single-line values ending in these as paths to rule files (relative to the repository). */
const RULE_FILE = /^[^\s]+\.(?:md|txt|markdown)$/i;

/** A repository-relative path we're willing to touch: no absolute paths, no `..`, nothing in `.git`. */
function safeRelative(p: string): string | null {
    if (!p || p.includes("\0") || p.startsWith("/") || p.includes("\\")) return null;
    const norm = path.posix.normalize(p);
    const parts = norm.split("/");
    if (parts.some((x) => x === "" || x === "." || x === ".." || x.toLowerCase() === ".git")) return null;
    return norm;
}

export interface GitContext {
    gitBin: string;
    /** PATH for git (nothing else from the runner's environment is passed on). */
    path: string;
    /** An empty home directory for this job. */
    home: string;
}

/** Settings every git command gets, as GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n. */
function hardened(extra: [string, string][] = []): Record<string, string> {
    const pairs: [string, string][] = [
        ["core.hooksPath", "/dev/null"],
        ["core.fsmonitor", "false"],
        ["submodule.recurse", "false"],
        ["fetch.recurseSubmodules", "false"],
        ["filter.lfs.smudge", ""],
        ["filter.lfs.process", ""],
        ["filter.lfs.required", "false"],
        ["http.followRedirects", "false"],
        ["advice.detachedHead", "false"],
        ...extra,
    ];
    const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
    pairs.forEach(([k, v], i) => {
        env[`GIT_CONFIG_KEY_${i}`] = k;
        env[`GIT_CONFIG_VALUE_${i}`] = v;
    });
    return env;
}

/** The whole environment for a git command. */
export function gitEnv(ctx: GitContext, extra: [string, string][] = []): Record<string, string> {
    return {
        PATH: ctx.path,
        HOME: ctx.home,
        LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        GIT_LFS_SKIP_SMUDGE: "1",
        ...hardened(extra),
    };
}

/** Environment for fetching from `cloneUrl` with `token`: the header applies to that host only. */
export function fetchEnv(ctx: GitContext, cloneUrl: string, username: string, token: string): Record<string, string> {
    const url = new URL(cloneUrl);
    // Only over HTTP(S): the protocol allowed below must never be one that runs commands (ext::) or the like.
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The server sent a clone URL that isn't http(s).");
    const basic = Buffer.from(`${username}:${token}`).toString("base64");
    return {
        ...gitEnv(ctx, [
            [`http.${url.origin}/.extraHeader`, `Authorization: Basic ${basic}`],
            ["protocol.allow", "never"],
            [`protocol.${url.protocol.replace(/:$/, "")}.allow`, "always"],
        ]),
        GIT_ALLOW_PROTOCOL: url.protocol.replace(/:$/, ""),
    };
}

/** Why a review's worktree is locked in the mirror: how a runner's own are told from anyone else's. */
const WORKTREE_LOCK = "triagent review";
/** How often a running review shows its worktree is in use, and how long without that before it counts as abandoned. */
export const WORKTREE_KEEP_MS = 10 * 60_000;
export const WORKTREE_ABANDONED_MS = 24 * 60 * 60_000;

const SHA = /^[0-9a-f]{40}$/;
/** What git says when the other end doesn't have (or won't give) a commit asked for by itself. */
const GONE = /not our ref|unadvertised object|couldn't find remote ref|no such remote ref|not a valid object|bad object/i;

/**
 * Whether `name` is a branch name git accepts (`git check-ref-format --branch`): no control characters,
 * spaces or any of ~ ^ : ? * [ \, no "..", "@{" or "//", no part starting with "." or ending in
 * ".lock", not ending in "/" or ".", not "@" or "HEAD", and not starting with "-" (it would read as an
 * option). Anything else, like "fix#12", is fine.
 */
export function isGitBranch(name: string): boolean {
    if (!name || Buffer.byteLength(name) > 255 || name === "@" || name === "HEAD" || name.startsWith("-")) return false;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
    if (/[\u0000-\u0020\u007f~^:?*[\\]|\.\.|@\{/.test(name)) return false;
    if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
    return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function checkBranch(name: string | null, what: string): string {
    if (!name || !isGitBranch(name)) throw new Error(`The server sent an unusable ${what} ("${String(name).slice(0, 60)}").`);
    return name;
}

/** The mirror for a repository: one per clone URL, so different repositories never share objects. */
export function mirrorPath(cacheDir: string, cloneUrl: string): string {
    return path.join(cacheDir, `${createHash("sha256").update(cloneUrl).digest("hex").slice(0, 24)}.git`);
}

export interface Fetched {
    head: string;
    /** Where the changes start (the merge base with the base branch), for pull requests and branch changes. */
    base: string | null;
}

export class Git {
    private readonly ctx: GitContext;

    constructor(ctx: GitContext) {
        this.ctx = ctx;
    }

    private git(args: string[], env = gitEnv(this.ctx), timeoutMs = 60_000, signal?: AbortSignal) {
        return run(this.ctx.gitBin, args, { env, timeoutMs, ...(signal ? { signal } : {}) }).then((out) => out.trim());
    }

    async ensureMirror(mirror: string, signal?: AbortSignal): Promise<void> {
        if (existsSync(path.join(mirror, "HEAD"))) return;
        mkdirSync(mirror, { recursive: true, mode: 0o700 });
        await this.git(["init", "--bare", "--quiet", mirror], gitEnv(this.ctx), 60_000, signal);
    }

    /**
     * Fetch what a job reviews into the mirror and work out the commits: the pull request's head (or the
     * branch), and where its changes start.
     */
    async fetch(
        mirror: string,
        job: {
            kind: "pr" | "changes" | "full";
            cloneUrl: string;
            username: string;
            token: string;
            pr: number | null;
            gitRef: string | null;
            baseRef: string | null;
        },
        signal?: AbortSignal,
    ): Promise<Fetched> {
        await this.ensureMirror(mirror, signal);
        const refspecs: string[] = [];
        let headRef: string;
        if (job.kind === "pr") {
            if (!job.pr || !Number.isInteger(job.pr) || job.pr < 1) throw new Error("The server sent no pull request number.");
            headRef = `refs/triagent/pr/${job.pr}`;
            refspecs.push(`+refs/pull/${job.pr}/head:${headRef}`);
        } else {
            const gitRef = checkBranch(job.gitRef, "branch");
            headRef = `refs/triagent/head/${gitRef}`;
            refspecs.push(`+refs/heads/${gitRef}:${headRef}`);
        }
        const baseRef = job.kind === "full" ? null : `refs/triagent/base/${checkBranch(job.baseRef, "base branch")}`;
        if (baseRef) refspecs.push(`+refs/heads/${job.baseRef}:${baseRef}`);
        const env = fetchEnv(this.ctx, job.cloneUrl, job.username, job.token);
        // The URL is given each time rather than stored as a remote: nothing about the repository lingers in config.
        await this.git(
            ["--git-dir", mirror, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", job.cloneUrl, ...refspecs],
            env,
            15 * 60_000,
            signal,
        );
        const head = await this.git(
            ["--git-dir", mirror, "rev-parse", "--verify", `${headRef}^{commit}`],
            gitEnv(this.ctx),
            60_000,
            signal,
        );
        if (!SHA.test(head)) throw new Error("Couldn't tell which commit to review.");
        let base: string | null = null;
        if (baseRef) {
            const exit = await start(this.ctx.gitBin, ["--git-dir", mirror, "merge-base", `${baseRef}^{commit}`, head], {
                env: gitEnv(this.ctx),
                timeoutMs: 60_000,
                ...(signal ? { signal } : {}),
            }).done;
            // Exit 1 with nothing said is git's "no merge base"; anything else (a timeout, a cancel, a broken mirror) is its own error.
            if (exit.code === 1 && !exit.killed && !exit.stderr.trim())
                throw new Error(`${job.kind === "pr" ? "The pull request" : job.gitRef} has no history in common with ${job.baseRef}.`);
            if (exit.code !== 0)
                throw new Error(
                    `git merge-base ${exit.timedOut ? "took too long and was stopped" : exit.killed ? "was stopped" : `failed (exit ${exit.code ?? exit.signal})`}: ${exit.stderr.trim().split("\n").slice(-3).join(" ")}`,
                );
            base = exit.stdout.trim();
        }
        return { head, base };
    }

    /**
     * The commits a job was told to review (`head`, and `base` where its changes start), once what it
     * reviews has been fetched: they're usually there already, as the pull request's or branch's history.
     * One that isn't (the branch was rewritten since) is asked for by itself; if GitHub no longer has it,
     * this fails saying so. It's fetched without a ref to keep it by: the job's worktree holds it while
     * it's reviewed, and afterwards git is free to clear it out of the mirror with whatever else nothing
     * points at, so the mirror doesn't grow by a ref for every such commit.
     */
    async pin(
        mirror: string,
        job: { cloneUrl: string; username: string; token: string },
        commit: { head: string; base: string | null },
        signal?: AbortSignal,
    ): Promise<Fetched> {
        for (const sha of [commit.head, commit.base]) {
            if (sha === null) continue;
            if (!SHA.test(sha)) throw new Error("The server named something that isn't a commit to review.");
            const has = () =>
                this.git(["--git-dir", mirror, "cat-file", "-e", `${sha}^{commit}`], gitEnv(this.ctx), 60_000, signal).then(
                    () => true,
                    () => false,
                );
            if (await has()) continue;
            try {
                await this.git(
                    ["--git-dir", mirror, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", job.cloneUrl, sha],
                    fetchEnv(this.ctx, job.cloneUrl, job.username, job.token),
                    15 * 60_000,
                    signal,
                );
            } catch (err) {
                // Only GitHub saying it hasn't got the commit means it's gone: a cancel, a refused token or a
                // network that's down is its own error, as it is for the fetch before this.
                if (signal?.aborted || !GONE.test((err as Error).message)) throw err;
            }
            if (signal?.aborted) throw new Error("git fetch was stopped");
            if (!(await has()))
                throw new Error(`Commit ${sha.slice(0, 7)}, which this review was of, can't be fetched from GitHub any more.`);
        }
        return { head: commit.head, base: commit.base };
    }

    /**
     * A detached worktree of `commit` at `dir`. With `attrSource`, checking out uses that commit's
     * .gitattributes rather than the ones being checked out.
     */
    async addWorktree(mirror: string, dir: string, commit: string, attrSource: string | null = null, signal?: AbortSignal): Promise<void> {
        if (!SHA.test(commit) || (attrSource !== null && !SHA.test(attrSource))) throw new Error("Not a commit.");
        // Locked, so no `git worktree prune` takes its record out of the mirror while it's in use: not git's own
        // (after a fetch), and not another runner's sharing the cache, to which this directory may not exist.
        await this.git(
            ["--git-dir", mirror, "worktree", "add", "--lock", "--reason", WORKTREE_LOCK, "--detach", "--force", "--quiet", dir, commit],
            { ...gitEnv(this.ctx), ...(attrSource ? { GIT_ATTR_SOURCE: attrSource } : {}) },
            10 * 60_000,
            signal,
        );
    }

    /**
     * Remove a job's worktree and the mirror's record of it. Only its own: other jobs (and other runners
     * sharing the cache) have worktrees in the same mirror, so nothing here prunes them all.
     */
    async removeWorktree(mirror: string, dir: string): Promise<void> {
        // Twice: once for a worktree with changes (the base's review rules are put into it), once for a locked one.
        const names = sameDirectory(dir);
        await this.git(["--git-dir", mirror, "worktree", "remove", "--force", "--force", dir]).catch(() => {});
        rmSync(dir, { recursive: true, force: true });
        // If git couldn't (the worktree was half made, say), its record goes by hand.
        for (const record of worktreeRecords(mirror))
            if (record.dir && names.has(record.dir)) rmSync(record.at, { recursive: true, force: true });
    }

    /**
     * Show that the worktree at `dir` is still in use (a running review does, every so often), so
     * `sweepWorktrees` leaves its record alone.
     */
    keepWorktree(mirror: string, dir: string): void {
        const t = new Date();
        const names = sameDirectory(dir);
        for (const record of worktreeRecords(mirror)) {
            if (!record.dir || !names.has(record.dir)) continue;
            try {
                utimesSync(path.join(record.at, "locked"), t, t);
            } catch {
                // gone: nothing to keep
            }
        }
    }

    /**
     * Remove the records of worktrees a runner left behind when it died: locked by a runner, and not kept
     * (`keepWorktree`) for `olderThanMs`. Their directories went with the runner's work directory, or will.
     * Call it while holding the mirror, so two runners don't tidy at once. Returns how many went.
     */
    sweepWorktrees(mirror: string, olderThanMs = WORKTREE_ABANDONED_MS): number {
        let n = 0;
        for (const record of worktreeRecords(mirror)) {
            try {
                const locked = path.join(record.at, "locked");
                if (!readFileSync(locked, "utf8").startsWith(WORKTREE_LOCK)) continue;
                if (Date.now() - statSync(locked).mtimeMs < olderThanMs) continue;
                rmSync(record.at, { recursive: true, force: true });
                n++;
            } catch {
                // not locked, or gone meanwhile
            }
        }
        return n;
    }

    /**
     * OCR reads `.opencodereview/rule.json` from the code it reviews, which decides what it includes,
     * excludes and focuses on. A pull request could add or change it to keep its own changes out of the
     * review, so for changes under review the worktree gets the base commit's `.opencodereview/` (or none,
     * if the base has none) in place of the one the change brings.
     */
    async useBaseReviewRules(mirror: string, dir: string, base: string): Promise<"replaced" | "removed" | "unchanged"> {
        if (!SHA.test(base)) throw new Error("Not a commit.");
        const target = path.join(dir, ".opencodereview");
        const had = (() => {
            try {
                lstatSync(target);
                return true;
            } catch {
                return false;
            }
        })();
        // A symbolic link is removed as a link (not followed).
        rmSync(target, { recursive: true, force: true });
        const inBase = await this.git(["--git-dir", mirror, "ls-tree", "--name-only", base, "--", ".opencodereview"]);
        if (!inBase) return had ? "removed" : "unchanged";
        await this.git(["-C", dir, "checkout", base, "--", ".opencodereview"]);
        return "replaced";
    }

    /**
     * Put `paths` back as they are in `base`: the base's file (or symbolic link, and what it points to
     * inside the repository), or nothing if the base has none. Whatever the change has at each path, or
     * in the way of it (a file or link where the base has a directory), is removed first, so nothing is
     * written through a link the change added. Returns the paths that changed, and how.
     */
    async restoreFromBase(mirror: string, dir: string, base: string, paths: string[]): Promise<{ path: string; now: "base" | "none" }[]> {
        if (!SHA.test(base)) throw new Error("Not a commit.");
        const out: { path: string; now: "base" | "none" }[] = [];
        const queue = paths.map(safeRelative).filter((p): p is string => p !== null);
        const seen = new Set<string>();
        // Every path asked for, and up to 200 more reached through links; past that, fail rather than leave any behind.
        const limit = queue.length + 200;
        while (queue.length) {
            const rel = queue.shift() as string;
            if (seen.has(rel)) continue;
            if (seen.size >= limit) throw new Error("Too many files to put back as they are in the base commit.");
            seen.add(rel);
            const parts = rel.split("/");
            for (let i = 1; i < parts.length; i++) {
                const parent = path.join(dir, ...parts.slice(0, i));
                const st = lstatOrNull(parent);
                if (st && !st.isDirectory()) rmSync(parent, { recursive: true, force: true });
            }
            const target = path.join(dir, ...parts);
            const had = lstatOrNull(target) !== null;
            rmSync(target, { recursive: true, force: true });
            const entry = await this.git(["--literal-pathspecs", "--git-dir", mirror, "ls-tree", base, "--", rel]);
            const m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(entry);
            if (m?.[2] !== "blob") {
                if (had) out.push({ path: rel, now: "none" });
                continue;
            }
            await this.git(["--literal-pathspecs", "-C", dir, "checkout", base, "--", rel]);
            out.push({ path: rel, now: "base" });
            if (m[1] === "120000") {
                // A link in the base: what it points to must be the base's too.
                // Not trimmed: a link's target is exactly its blob's content.
                const to = await run(this.ctx.gitBin, ["--git-dir", mirror, "cat-file", "blob", m[3] as string], {
                    env: gitEnv(this.ctx),
                    timeoutMs: 60_000,
                });
                const next = safeRelative(path.posix.join(path.posix.dirname(rel), to));
                if (next) queue.push(next);
            }
        }
        return out;
    }

    /**
     * OCR leaves out of a review the files the repository's root .gitignore matches, read from the
     * worktree. A change could add or edit it to hide its own files, so every .gitignore the change
     * touches (the root's and nested ones alike) is put back as it is in the base.
     */
    async useBaseIgnoreFiles(mirror: string, dir: string, base: string, head: string) {
        if (!SHA.test(base) || !SHA.test(head)) throw new Error("Not a commit.");
        const changed = await this.git([
            "--git-dir",
            mirror,
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            base,
            head,
            "--",
            ":(glob)**/.gitignore",
        ]);
        return this.restoreFromBase(mirror, dir, base, changed.split("\0").filter(Boolean));
    }

    /**
     * Rule entries in the base's .opencodereview/rule.json can name a file of instructions (a single
     * word ending in .md, .txt or .markdown, relative to the repository), which OCR reads from the
     * worktree. Those files are put back as they are in the base, so a change can't rewrite them.
     */
    async useBaseRuleFiles(mirror: string, dir: string, base: string) {
        if (!SHA.test(base)) throw new Error("Not a commit.");
        const listed = await this.git(["--git-dir", mirror, "ls-tree", base, "--", ".opencodereview/rule.json"]);
        if (!/^\d+ blob /.test(listed)) return [];
        let rules: unknown;
        try {
            rules = JSON.parse(await this.git(["--git-dir", mirror, "cat-file", "-p", `${base}:.opencodereview/rule.json`]));
        } catch {
            return [];
        }
        const entries = (rules as { rules?: unknown })?.rules;
        const named = (Array.isArray(entries) ? entries : [])
            .map((e) => (e && typeof e === "object" ? (e as { rule?: unknown }).rule : null))
            .filter((r): r is string => typeof r === "string" && RULE_FILE.test(r.trim()))
            .map((r) => r.trim());
        // The rule file itself, in case the base's is a link to somewhere the change edits.
        return this.restoreFromBase(mirror, dir, base, [".opencodereview/rule.json", ...named]);
    }
}

/** `dir` as given and as git records it (with links in its path followed). */
function sameDirectory(dir: string): Set<string> {
    try {
        return new Set([dir, realpathSync(dir)]);
    } catch {
        return new Set([dir]);
    }
}

/** The mirror's records of its worktrees (`<mirror>/worktrees/<name>`), each with the directory it's for. */
function worktreeRecords(mirror: string): { at: string; dir: string | null }[] {
    const root = path.join(mirror, "worktrees");
    let names: string[];
    try {
        names = readdirSync(root);
    } catch {
        return [];
    }
    return names.map((name) => {
        const at = path.join(root, name);
        try {
            // Its `gitdir` file names the worktree's own `.git` file.
            return { at, dir: path.dirname(readFileSync(path.join(at, "gitdir"), "utf8").trim()) };
        } catch {
            return { at, dir: null };
        }
    });
}

function lstatOrNull(p: string) {
    try {
        return lstatSync(p);
    } catch {
        return null;
    }
}
