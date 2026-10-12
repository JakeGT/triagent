// Where findings came from. For a workspace that turns it on, each finding on a branch is traced to the
// commit that last changed its lines: Git blame, asked of GitHub at the report's commit, a few files at
// a time. That gives the code's age, the pull request it came in by, and its author; and from those, a
// suggestion of who to hand a finding to, and (only if the workspace's admins ask for it) a leaderboard.
//
// Three levels, chosen by an admin (Settings → Analysis), off to begin with:
//   off          nothing is asked of GitHub or kept;
//   on           findings are traced; pages show the commit, how old the code is, and suggest an assignee;
//   leaderboard  also counts findings by author, for everyone in the workspace to see.
//
// Blame credits whoever last changed a line. That's often not who wrote the problem, and the pages say so.
// Authors are kept as Git names and GitHub logins; an email address is only used, in passing, to match an
// author to a member of the workspace.

import { log } from "@triagent/shared/log";
import type { IssueFilters } from "../domain/filters.ts";
import {
    authorKey,
    BLAME_BATCH,
    type BlameRange,
    blameQuery,
    linesByAuthor,
    MAX_BLAME_FILES,
    originOf,
    readBlame,
    sameAuthor,
    summarise,
    type TracedFinding,
} from "../domain/origins.ts";
import { badRequest, conflict } from "../errors.ts";
import { logFailure } from "../failure.ts";
import { now } from "../security.ts";
import type { FindingOrigin, Job, OriginScan, Project, Repos, Workspace } from "../store/types.ts";
import type { Actor, Core } from "./core.ts";
import { GitHubError } from "./github/client.ts";
import { type Github, NotConnected } from "./github/service.ts";
import type { Reports } from "./reports.ts";

const KEY = "origins";
export const ORIGIN_LEVELS = ["off", "on", "leaderboard"] as const;
export type OriginLevel = (typeof ORIGIN_LEVELS)[number];

/** A scan still "running" after this long was left by a server that stopped. */
const STALE_MS = 15 * 60_000;

export class Origins {
    private readonly core: Core;
    private readonly github: Github;
    private readonly reports: Reports;
    private readonly clock: () => number;
    private readonly pending = new Set<Promise<unknown>>();

    constructor(core: Core, github: Github, reports: Reports, clock: () => number = Date.now) {
        this.core = core;
        this.github = github;
        this.reports = reports;
        this.clock = clock;
    }

    private get store() {
        return this.core.store;
    }

    /** Wait for tracing in hand to finish (tests, shutdown). */
    async settled(): Promise<void> {
        while (this.pending.size) await Promise.allSettled([...this.pending]);
    }

    // ---- the setting -------------------------------------------------------------------------------

    async level(repos: Repos, workspaceId: string): Promise<OriginLevel> {
        const value = (await repos.settings.get(workspaceId, null, KEY))?.value as { level?: unknown } | undefined;
        return (ORIGIN_LEVELS as readonly unknown[]).includes(value?.level) ? (value?.level as OriginLevel) : "off";
    }

    async save(actor: Actor, workspace: Workspace, level: OriginLevel) {
        if (!(ORIGIN_LEVELS as readonly unknown[]).includes(level)) throw badRequest(`Choose one of: ${ORIGIN_LEVELS.join(", ")}.`);
        await this.core.write(actor, async (w) => {
            const before = await this.level(w.tx, workspace.id);
            if (before === level) return;
            await w.tx.settings.put({ workspaceId: workspace.id, projectId: null, key: KEY, value: { level } });
            // Turned off: what was traced goes too. Nobody is left with a record they chose not to keep.
            if (level === "off") await w.tx.origins.clear(workspace.id);
            await w.audit({
                workspaceId: workspace.id,
                kind: "settings",
                target: "origins",
                changes: { level: { from: before, to: level } },
            });
        });
        return { level };
    }

    // ---- tracing -----------------------------------------------------------------------------------

    private async settle(scan: OriginScan | null): Promise<OriginScan | null> {
        if (scan?.status !== "running" || this.clock() - Date.parse(scan.startedAt) < STALE_MS) return scan;
        const failed: OriginScan = {
            ...scan,
            status: "failed",
            finishedAt: now(),
            error: "It was interrupted before it finished. Trace again.",
        };
        await this.store.origins.putScan(failed);
        return failed;
    }

    /**
     * Trace a branch's findings to commits, in the background; the scan it returns is running. One already
     * running is returned as it is. 409 when the workspace hasn't turned this on, or there's nothing to trace.
     */
    async trace(workspace: Workspace, project: Project, branch: string): Promise<OriginScan> {
        if ((await this.level(this.store, workspace.id)) === "off")
            throw conflict("This workspace doesn't trace findings to commits. An admin can turn it on in Settings → Analysis.");
        const running = await this.settle(await this.store.origins.scan(project.id, branch));
        if (running?.status === "running") return running;
        const stored = await this.store.reports.get(project.id, branch);
        if (!stored) throw conflict(`There's no report on ${branch} to trace.`);
        const commit = stored.upload.commit;
        if (!commit || !/^[0-9a-f]{40}$/i.test(commit))
            throw conflict(
                "This branch's report doesn't say which commit it's of, so its lines can't be traced. A review run here always does.",
            );
        // Before anything is saved as running: no connection to GitHub is said now, not found out later.
        let access: Awaited<ReturnType<Github["githubFor"]>>;
        try {
            access = await this.github.githubFor(project);
        } catch (err) {
            if (err instanceof NotConnected) throw conflict(`${err.message} Tracing findings to commits asks GitHub for them.`);
            throw err;
        }
        const scan: OriginScan = {
            workspaceId: workspace.id,
            projectId: project.id,
            branch,
            commit: commit.toLowerCase(),
            status: "running",
            startedAt: new Date(this.clock()).toISOString(),
            finishedAt: null,
            files: 0,
            traced: 0,
            skipped: 0,
            error: null,
            lines: {},
            authors: {},
        };
        await this.store.origins.putScan(scan);
        const task = this.run(workspace, project, scan, access, stored.version)
            .catch(async (err: unknown) => {
                // GitHub saying no (a token without access, a rate limit) happens; anything else is ours.
                if (err instanceof GitHubError)
                    log.warn("Couldn't trace findings to commits", { project: project.slug, reason: err.message });
                else logFailure("Tracing findings to commits failed", err, { project: project.slug });
                const why = err instanceof GitHubError ? err.message : "Something went wrong while asking GitHub.";
                await this.store.transaction(async (tx) => {
                    // Only if it's still this tracing that's on record: turned off meanwhile, there's nothing to say it failed.
                    const current = await tx.origins.scan(project.id, scan.branch);
                    if (current?.status !== "running" || current.startedAt !== scan.startedAt) return;
                    await tx.origins.putScan({ ...scan, status: "failed", finishedAt: now(), error: why.slice(0, 500) });
                });
            })
            .catch((err: unknown) => logFailure("Couldn't record a failed tracing", err, { project: project.slug }))
            .finally(() => this.pending.delete(task));
        this.pending.add(task);
        return scan;
    }

    private async run(
        workspace: Workspace,
        project: Project,
        scan: OriginScan,
        access: Awaited<ReturnType<Github["githubFor"]>>,
        version: number,
    ): Promise<void> {
        const view = await this.reports.view(this.store, project, scan.branch);
        const issues = view.review.issues.filter((x) => x.startLine !== null);
        const byPath = new Map<string, typeof issues>();
        for (const x of issues) byPath.set(x.path, [...(byPath.get(x.path) ?? []), x]);
        const paths = [...byPath.keys()].slice(0, MAX_BLAME_FILES);
        const members = await this.members(workspace.id);
        const lines = new Map<string, number>();
        const authors: OriginScan["authors"] = {};
        const rows: FindingOrigin[] = [];
        let files = 0;

        const ask = async (batch: readonly string[]): Promise<(BlameRange[] | null)[]> => {
            const { data } = await access.client.graphql<unknown>(blameQuery(batch.length), {
                owner: access.repo.owner,
                name: access.repo.name,
                oid: scan.commit,
                ...Object.fromEntries(batch.map((p, i) => [`p${i}`, p])),
            });
            return readBlame(data, batch.length);
        };
        for (let i = 0; i < paths.length; i += BLAME_BATCH) {
            const batch = paths.slice(i, i + BLAME_BATCH);
            let blamed: (BlameRange[] | null)[];
            try {
                blamed = await ask(batch);
            } catch (err) {
                // One file too slow to blame takes the request with it: ask for each by itself, and leave out what still fails.
                // Refused, or told to slow down: asking again, six times over, would only make it worse.
                if (!(err instanceof GitHubError) || [401, 403, 404, 429].includes(err.status)) throw err;
                blamed = [];
                for (const p of batch) blamed.push((await ask([p]).catch(() => [null]))[0] ?? null);
            }
            for (const [k, path] of batch.entries()) {
                const ranges = blamed[k];
                if (!ranges?.length) continue;
                files++;
                linesByAuthor(ranges, lines);
                for (const r of ranges) {
                    const key = authorKey(r.commit);
                    authors[key] ??= { name: r.commit.name, login: r.commit.login, memberId: members(r.commit) };
                }
                for (const x of byPath.get(path) ?? []) {
                    const c = originOf(ranges, x.startLine as number, x.endLine);
                    if (!c) continue;
                    rows.push({
                        workspaceId: workspace.id,
                        projectId: project.id,
                        branch: scan.branch,
                        findingId: x.id,
                        commit: c.oid,
                        headline: c.headline,
                        authoredAt: c.authoredAt,
                        authorName: c.name,
                        authorLogin: c.login,
                        memberId: members(c),
                        prNumber: c.pr?.number ?? null,
                        prTitle: c.pr?.title ?? null,
                    });
                }
            }
        }
        await this.store.transaction(async (tx) => {
            // Turned off, or the report replaced, while GitHub was being asked: what was found isn't kept.
            if ((await this.level(tx, workspace.id)) === "off") return;
            const current = await tx.reports.get(project.id, scan.branch);
            if (current?.version !== version) {
                await tx.origins.putScan({
                    ...scan,
                    status: "failed",
                    finishedAt: now(),
                    error: "The branch's report changed while its findings were being traced. Trace again.",
                });
                return;
            }
            await tx.origins.replace(project.id, scan.branch, rows);
            await tx.origins.putScan({
                ...scan,
                status: "done",
                finishedAt: now(),
                files,
                traced: rows.length,
                skipped: view.review.issues.length - rows.length,
                lines: Object.fromEntries(lines),
                authors,
            });
        });
    }

    /** Which member of the workspace a commit's author is, if any: by email address, or a username that is their GitHub login. */
    private async members(workspaceId: string): Promise<(author: { email: string | null; login: string | null }) => string | null> {
        const byEmail = new Map<string, string>();
        const byName = new Map<string, string>();
        const members = await this.store.memberships.forWorkspace(workspaceId);
        for (const user of await Promise.all(members.map((m) => this.store.users.get(m.userId)))) {
            if (!user) continue;
            if (user.email) byEmail.set(user.email.toLowerCase(), user.id);
            if (user.username) byName.set(user.username.toLowerCase(), user.id);
        }
        return (a) => (a.email ? byEmail.get(a.email) : undefined) ?? (a.login ? byName.get(a.login.toLowerCase()) : undefined) ?? null;
    }

    /** A review that changed a branch has finished: trace its findings, if the workspace asks for that. Never throws. */
    reviewFinished(job: Job, project: Project): void {
        if ((job.status !== "done" && job.status !== "partial") || job.rerunOf || job.options?.bakeOff || !job.result?.reportId) return;
        const task = (async () => {
            const workspace = await this.store.workspaces.get(job.workspaceId);
            if (!workspace || (await this.level(this.store, workspace.id)) === "off") return;
            await this.trace(workspace, project, job.branch);
        })()
            .catch((err: unknown) => {
                // Not connected, no commit: said on the page when someone asks. Anything else is ours.
                if ((err as { status?: number }).status === 409) log.info("A finished review's findings weren't traced", { run: job.id });
                else logFailure("Couldn't start tracing a finished review's findings", err, { run: job.id });
            })
            .finally(() => this.pending.delete(task));
        this.pending.add(task);
    }

    // ---- reading -----------------------------------------------------------------------------------

    private async names(workspaceId: string): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        const members = await this.store.memberships.forWorkspace(workspaceId);
        for (const user of await Promise.all(members.map((m) => this.store.users.get(m.userId))))
            if (user) out.set(user.id, user.displayName);
        return out;
    }

    /**
     * What's known of where a branch's findings came from: how the last tracing went, how old the code
     * behind the open ones is, the pull requests behind the most, and (only at the leaderboard level) the authors.
     */
    async summary(workspace: Workspace, project: Project, branch: string) {
        const level = await this.level(this.store, workspace.id);
        if (level === "off") return { level, branch, scan: null, stale: false, traced: 0, open: 0, age: null, pulls: [], authors: null };
        const scan = await this.settle(await this.store.origins.scan(project.id, branch));
        const view = await this.reports.view(this.store, project, branch);
        const traced: TracedFinding[] = [];
        for (const origin of await this.store.origins.forBranch(project.id, branch)) {
            const x = view.issue(origin.findingId);
            if (x) traced.push({ id: x.id, severity: x.severity, status: view.statusOf("issue", x.id), origin });
        }
        const s = summarise(traced, scan?.lines ?? {}, scan?.authors ?? {}, this.clock());
        const names = await this.names(workspace.id);
        return {
            level,
            branch,
            scan: scan && { ...scan, lines: undefined, authors: undefined },
            /** The report has moved on to another commit since its findings were traced. */
            stale: Boolean(scan?.commit && view.context.commit && scan.commit !== view.context.commit.toLowerCase()),
            traced: s.traced,
            open: s.open,
            age: s.age,
            pulls: s.pulls,
            authors:
                level === "leaderboard"
                    ? s.authors.map((a) => ({ ...a, member: a.memberId ? (names.get(a.memberId) ?? null) : null }))
                    : null,
        };
    }

    /** The commit behind one finding, and the member to suggest handing it to, when the workspace traces them. */
    async forIssue(project: Project, branch: string, findingId: string) {
        if ((await this.level(this.store, project.workspaceId)) === "off") return null;
        const o = await this.store.origins.get(project.id, branch, findingId);
        if (!o) return null;
        const member = o.memberId ? await this.store.users.get(o.memberId) : null;
        // Still a member: someone removed since isn't suggested.
        const still = member ? await this.store.memberships.get(project.workspaceId, member.id) : null;
        return {
            commit: o.commit,
            headline: o.headline,
            authoredAt: o.authoredAt,
            author: o.authorName,
            login: o.authorLogin,
            pr: o.prNumber === null ? null : { number: o.prNumber, title: o.prTitle ?? "" },
            /** The author as a member of the workspace: who the finding could be assigned to. */
            suggested: member && still ? member.displayName : null,
        };
    }

    /** Filters as the branch's view can apply them: one for an author becomes the ids of the findings in code they last changed. */
    async narrow(project: Project, branch: string, filters: IssueFilters): Promise<IssueFilters> {
        if (!filters.author) return filters;
        const mine =
            (await this.level(this.store, project.workspaceId)) === "leaderboard"
                ? (await this.store.origins.forBranch(project.id, branch))
                      .filter((o) => sameAuthor(authorKey({ login: o.authorLogin, name: o.authorName })) === sameAuthor(filters.author))
                      .map((o) => o.findingId)
                : [];
        const ids = filters.ids.length ? mine.filter((id) => filters.ids.includes(id)) : mine;
        return { ...filters, ids: ids.length ? ids : ["(none)"] };
    }
}
