// Automatic reviews: checking a project's pull requests (on webhook events, or every few minutes) and
// queueing a review of each new head commit; keeping track of the repository's branches; the nightly
// full scan. With Postgres, one server process at a time does the polling (an advisory lock).
//
// What each check decided, and why, is kept with the project, so the Pull requests page can say why a
// pull request was or wasn't reviewed.

import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidBranch } from "../../domain/names.ts";
import { ApiError, notFound } from "../../errors.ts";
import { now } from "../../security.ts";
import { ACTIVE_JOB_STATUSES, type Job, type Project, type Repos } from "../../store/types.ts";
import type { Actor, Core } from "../core.ts";
import type { Reports } from "../reports.ts";
import { type JobSpec, type Runs, specForBranch, specForPull } from "../runs.ts";
import type { Settings } from "../settings.ts";
import type { Pull } from "./client.ts";
import { type Github, NotConnected } from "./service.ts";

export const AUTOMATION: Actor = { name: "automation", userId: null, via: "system" };
const GITHUB_ACTOR: Actor = { name: "GitHub", userId: null, via: "github" };
const MAX_COMPARES = 25;
/** The most open pull requests a check looks at (the most recently updated); ten pages from GitHub. */
export const MAX_OPEN_PULLS = 1000;
const TICK_MS = 30_000;

export interface PullState {
    number: number;
    title: string;
    branch: string;
    headSha: string;
    draft: boolean;
    url: string | null;
    author: string | null;
    /** The last commit reviewed successfully. */
    reviewedSha: string | null;
    /** A commit whose review failed or was cancelled: not queued again automatically. */
    attemptedSha?: string | null;
    /** In words: "reviewed", "queued", "draft", "not reviewed (was already open)", "waiting for approval"… */
    status: string;
    /** Open when automatic reviews were switched on: listed, but not reviewed until someone asks. */
    baseline?: boolean;
}

export interface Decision {
    number: number;
    title: string;
    sha: string | null;
    action: "queued" | "skipped";
    why: string;
}

export interface GithubState {
    /** Whether the last check saw automatic reviews on (switching them on sets a baseline). */
    automationSeen: boolean;
    prs: Record<string, PullState>;
    lastCheck: { at: string; openPulls?: number; error?: string; note?: string; decisions: Decision[] } | null;
    lastPollAt: string | null;
    lastSyncAt: string | null;
    lastNightly: string | null;
    lastError: { at: string; message: string } | null;
    /** GitHub's branches (name → head commit), and every branch ever seen there. */
    branches: { items: Record<string, string>; seen: string[]; fetchedAt: string | null };
    /** For each Triagent branch with a report: how it compares with the branch on GitHub. */
    branchStatus: Record<string, { githubSha: string; reviewedSha: string | null; behind: number | null; diverged: boolean }>;
    /** The id of the comment Triagent wrote on each pull request (by number), so it's the one updated. Kept by services/github/service.ts. */
    comments?: Record<string, number>;
}

const EMPTY: GithubState = {
    automationSeen: false,
    prs: {},
    lastCheck: null,
    lastPollAt: null,
    lastSyncAt: null,
    lastNightly: null,
    lastError: null,
    branches: { items: {}, seen: [], fetchedAt: null },
    branchStatus: {},
};

export interface DeliveryResult {
    ok: true;
    ignored?: boolean;
    note: string;
}

const PR_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "edited"]);

/** Authors whose pull requests are reviewed automatically wherever their branch is. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Why a pull request waits for someone to approve its review, or null if it needn't: a review spends the
 * workspace's model budget, so pull requests from forks by people outside the repository wait, unless
 * the project reviews everyone's.
 */
export function needsApproval(pr: Pull, from: "collaborators" | "everyone", repo: string): string | null {
    if (from === "everyone") return null;
    const sameRepo = Boolean(pr.head.repo?.full_name && pr.head.repo.full_name === pr.base.repo?.full_name);
    const association = String(pr.author_association ?? "NONE").toUpperCase();
    if (sameRepo || TRUSTED.has(association)) return null;
    const who = pr.user?.login ?? "someone";
    return `it's from a fork, by ${who}, who isn't a collaborator on ${repo}: someone who can start reviews can use Review now, or the project's Automation settings can review everyone's`;
}

export function verifySignature(secret: string, body: Buffer, signature: string | undefined): boolean {
    const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
    const given = Buffer.from(String(signature ?? ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
}

export class Automation {
    private readonly core: Core;
    private readonly github: Github;
    private readonly runs: Runs;
    private readonly reports: Reports;
    private readonly settings: Settings;
    /** One check per project at a time in this process. */
    private readonly busy = new Map<string, Promise<unknown>>();
    private readonly compareCache = new Map<string, { ahead: number; behind: number }>();
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(core: Core, github: Github, runs: Runs, reports: Reports, settings: Settings) {
        this.core = core;
        this.github = github;
        this.runs = runs;
        this.reports = reports;
        this.settings = settings;
        runs.onFinished = (job, project) =>
            this.runs.background(`Updating GitHub state after ${job.title}`, () => this.runFinished(job, project));
    }

    private get store() {
        return this.core.store;
    }

    // ---- state -------------------------------------------------------------------------------------

    async state(project: Project, repos: Repos = this.store): Promise<GithubState> {
        const stored = (await repos.githubState.get(project.id)) as Partial<GithubState> | null;
        return { ...structuredClone(EMPTY), ...(stored ?? {}) };
    }

    /** Change the project's state in one transaction, from what's saved now. */
    private async update(project: Project, change: (s: GithubState) => void | Promise<void>): Promise<GithubState> {
        return this.store.transaction(async (tx) => {
            const s = structuredClone(await this.state(project, tx));
            await change(s);
            await tx.githubState.put(project.id, s);
            return s;
        });
    }

    private serial<T>(key: string, task: () => Promise<T>): Promise<T> {
        const before = this.busy.get(key) ?? Promise.resolve();
        const next = before.catch(() => {}).then(task);
        this.busy.set(key, next);
        // Cleaned up either way, without a branch of its own that could reject unhandled (the caller sees any failure).
        const done = () => {
            if (this.busy.get(key) === next) this.busy.delete(key);
        };
        next.then(done, done);
        return next;
    }

    // ---- pull requests -----------------------------------------------------------------------------

    /**
     * Look at the open pull requests and queue a review of each new head commit, when automatic reviews
     * are on. Switching them on sets a baseline: pull requests already open are listed, not reviewed.
     */
    checkPulls(project: Project): Promise<GithubState["lastCheck"]> {
        return this.serial(`pulls:${project.id}`, async () => {
            const automation = await this.settings.automation(this.store, project);
            let pulls: Pull[];
            let repoName = "";
            try {
                const gh = await this.github.githubFor(project);
                repoName = gh.repo.fullName;
                // One more than the most, to tell whether there are more.
                pulls = await gh.client.openPulls(gh.repo, MAX_OPEN_PULLS + 1);
            } catch (err) {
                const message = (err as Error).message;
                const s = await this.update(project, (s) => {
                    s.lastCheck = { at: now(), error: message, decisions: [] };
                    s.lastError = { at: now(), message };
                    s.lastPollAt = now();
                });
                return s.lastCheck;
            }
            const capped = pulls.length > MAX_OPEN_PULLS;
            pulls = pulls.slice(0, MAX_OPEN_PULLS);
            const before = await this.state(project);
            const enabled = automation.enabled;
            const baseline = enabled && !before.automationSeen;
            const active = (await this.store.jobs.list({ projectId: project.id, statuses: ACTIVE_JOB_STATUSES }, 200)).filter(
                (j) => j.kind === "pr",
            );
            const decisions: Decision[] = [];
            const prs: Record<string, PullState> = {};
            const toQueue: { pr: Pull; spec: JobSpec }[] = [];
            for (const pr of pulls) {
                const known = before.prs[pr.number];
                const sha = pr.head.sha;
                const info: PullState = {
                    number: pr.number,
                    title: pr.title.slice(0, 300),
                    branch: specForPull(pr).branch,
                    headSha: sha,
                    draft: Boolean(pr.draft),
                    url: pr.html_url ?? null,
                    author: pr.user?.login ?? null,
                    reviewedSha: known?.reviewedSha ?? null,
                    attemptedSha: known?.attemptedSha ?? null,
                    status: known?.status ?? "not reviewed",
                    ...(known?.baseline && known.headSha === sha ? { baseline: true } : {}),
                };
                prs[pr.number] = info;
                const decide = (action: Decision["action"], why: string) =>
                    decisions.push({ number: pr.number, title: info.title, sha: sha.slice(0, 7), action, why });
                if (pr.draft) {
                    info.status = "draft";
                    decide("skipped", "it's a draft");
                    continue;
                }
                if (baseline && info.reviewedSha !== sha) {
                    Object.assign(info, { status: "not reviewed (was already open)", baseline: true });
                    decide(
                        "skipped",
                        "it was already open when automatic reviews were switched on; its next push will be reviewed, or use Review now",
                    );
                    continue;
                }
                if (info.reviewedSha === sha) {
                    decide("skipped", "this commit was already reviewed");
                    continue;
                }
                if (info.attemptedSha === sha) {
                    decide("skipped", "its last review of this commit failed or was cancelled; use Review now to try again");
                    continue;
                }
                const busy = active.find((j) => j.pr?.number === pr.number && j.headSha === sha);
                if (busy) {
                    decide("skipped", `a review of this commit is already ${busy.status}`);
                    continue;
                }
                if (info.baseline) {
                    decide(
                        "skipped",
                        "it was already open when automatic reviews were switched on; its next push will be reviewed, or use Review now",
                    );
                    continue;
                }
                if (!enabled) {
                    info.status = "not reviewed (automatic reviews are off)";
                    decide(
                        "skipped",
                        "automatic reviews are off for this project; use Review now, or switch them on in Automation settings",
                    );
                    continue;
                }
                const approval = needsApproval(pr, automation.reviewPullRequestsFrom, repoName);
                if (approval) {
                    info.status = "waiting for approval";
                    decide("skipped", approval);
                    continue;
                }
                toQueue.push({ pr, spec: specForPull(pr) });
                info.status = "queued";
                decide("queued", info.reviewedSha ? "new commits since the last review" : "not reviewed yet");
            }
            // Beyond the most a check looks at, pull requests keep what's known of them (their baseline, say).
            if (capped) for (const [n, p] of Object.entries(before.prs)) if (!prs[n]) prs[n] = p;
            for (const { spec } of toQueue) await this.runs.enqueue(AUTOMATION, project, spec);
            const s = await this.update(project, (s) => {
                // Keep what a run finishing meanwhile recorded, and its outcome when it was of the head commit.
                for (const [n, p] of Object.entries(prs)) {
                    const latest = s.prs[n];
                    if (latest?.reviewedSha && latest.reviewedSha !== p.reviewedSha) {
                        p.reviewedSha = latest.reviewedSha;
                        if (latest.reviewedSha === p.headSha) Object.assign(p, { status: latest.status, baseline: false });
                    }
                    if (latest?.attemptedSha && latest.attemptedSha !== p.attemptedSha) {
                        p.attemptedSha = latest.attemptedSha;
                        if (latest.attemptedSha === p.headSha) p.status = latest.status;
                    }
                }
                s.prs = prs;
                s.automationSeen = enabled;
                s.lastPollAt = now();
                s.lastError = null;
                s.lastCheck = {
                    at: now(),
                    openPulls: pulls.length,
                    ...(capped
                        ? {
                              note: `There are more than ${MAX_OPEN_PULLS.toLocaleString("en-GB")} open pull requests: only the ${MAX_OPEN_PULLS.toLocaleString("en-GB")} most recently updated were checked.`,
                          }
                        : {}),
                    decisions,
                };
            });
            const queued = decisions.filter((d) => d.action === "queued").map((d) => `#${d.number}`);
            if (queued.length || decisions.length)
                console.log(
                    `[${project.slug}] Checked ${pulls.length} open pull request(s)${queued.length ? `; queued ${queued.join(", ")}` : ""}.`,
                );
            return s.lastCheck;
        });
    }

    /** The pull requests page: each open pull request with its state, plus what the last check decided. */
    async pullRequests(project: Project) {
        const s = await this.state(project);
        const automation = await this.settings.automation(this.store, project);
        const connected = await this.github.maybeFor(project).catch(() => null);
        const active = await this.store.jobs.list({ projectId: project.id, statuses: ACTIVE_JOB_STATUSES }, 200);
        const last = new Map((s.lastCheck?.decisions ?? []).map((d) => [d.number, d]));
        return {
            connected: Boolean(connected),
            mode: connected?.mode ?? null,
            repository: connected?.repo.fullName ?? null,
            automation: { enabled: automation.enabled, pollMinutes: automation.pollMinutes },
            lastCheck: s.lastCheck,
            lastError: s.lastError,
            items: Object.values(s.prs)
                .sort((a, b) => b.number - a.number)
                .map((p) => {
                    const run = active.find((j) => j.pr?.number === p.number);
                    return {
                        ...p,
                        reviewed: p.reviewedSha !== null && p.reviewedSha === p.headSha,
                        run: run ? { id: run.id, status: run.status } : null,
                        lastDecision: last.get(p.number) ?? null,
                    };
                }),
            deliveries: await this.store.githubDeliveries.list(project.id, 20),
            refused: this.github.refused.get(project.id),
        };
    }

    /** A delivery to the project's own webhook whose signature didn't check out. */
    refuse(project: Project, reason: string): void {
        this.github.refused.note(project.id, reason, `${project.slug}'s webhook`);
    }

    // ---- branches ---------------------------------------------------------------------------------

    /** Fetch the repository's branches, work out which reports are behind, and archive branches deleted there (if set to). */
    syncBranches(project: Project): Promise<boolean> {
        return this.serial(`branches:${project.id}`, async () => {
            let items: Record<string, string>;
            let gh: Awaited<ReturnType<Github["githubFor"]>>;
            try {
                gh = await this.github.githubFor(project);
                items = await gh.client.branches(gh.repo);
            } catch (err) {
                await this.update(project, (s) => {
                    s.lastError = { at: now(), message: (err as Error).message };
                    s.lastSyncAt = now();
                });
                return false;
            }
            const before = await this.state(project);
            const automation = await this.settings.automation(this.store, project);
            const seen = new Set([...before.branches.seen, ...Object.keys(items)]);
            if (automation.archiveDeletedBranches) {
                for (const stored of await this.store.reports.branches(project.id)) {
                    const name = stored.branch;
                    if (name === project.defaultBranch || Object.hasOwn(items, name) || !before.branches.seen.includes(name)) continue;
                    if (await this.archive(project, name)) seen.delete(name);
                }
            }
            const status = await this.staleness(project, gh, items);
            await this.update(project, (s) => {
                s.branches = { items, seen: [...seen].slice(-5000), fetchedAt: now() };
                s.branchStatus = status;
                s.lastSyncAt = now();
            });
            return true;
        });
    }

    /** For each branch's report: is it for the commit GitHub has now, and if not, how many commits behind? */
    private async staleness(
        project: Project,
        gh: Awaited<ReturnType<Github["githubFor"]>>,
        items: Record<string, string>,
        only?: string,
    ): Promise<GithubState["branchStatus"]> {
        let asked = 0;
        const out: GithubState["branchStatus"] = {};
        for (const stored of await this.store.reports.branches(project.id)) {
            if (only && stored.branch !== only) continue;
            const githubSha = Object.hasOwn(items, stored.branch) ? items[stored.branch] : undefined;
            if (!githubSha) continue;
            const reviewedSha = stored.upload.commit;
            const entry = { githubSha, reviewedSha, behind: null as number | null, diverged: false };
            if (reviewedSha && !githubSha.startsWith(reviewedSha)) {
                const key = `${reviewedSha}..${githubSha}`;
                let cmp = this.compareCache.get(key);
                if (!cmp && asked < MAX_COMPARES) {
                    asked++;
                    // Fails for a commit GitHub doesn't have (reviewed before it was pushed): then it's just "not current".
                    const c = await gh.client.compare(gh.repo, reviewedSha, githubSha).catch(() => null);
                    if (c) {
                        cmp = { ahead: c.ahead_by, behind: c.behind_by };
                        this.compareCache.set(key, cmp);
                        while (this.compareCache.size > 1000) this.compareCache.delete(this.compareCache.keys().next().value as string);
                    }
                }
                if (cmp) Object.assign(entry, { behind: cmp.ahead, diverged: cmp.behind > 0 });
            }
            out[stored.branch] = entry;
        }
        return out;
    }

    /** Archive a Triagent branch whose Git branch was deleted on GitHub (never the default branch). */
    private async archive(project: Project, branch: string): Promise<boolean> {
        if (branch === project.defaultBranch) return false;
        try {
            await this.reports.deleteBranch(GITHUB_ACTOR, project, { branch, confirm: true });
            console.log(`[${project.slug}] Archived branch "${branch}": it was deleted on GitHub.`);
            return true;
        } catch (err) {
            if (!(err instanceof ApiError && err.status === 404))
                console.error(`[${project.slug}] Couldn't archive "${branch}": ${(err as Error).message}`);
            return false;
        }
    }

    /** What's known about the project's branches on GitHub, for the branch list. Null when it isn't connected. */
    async branchInfo(project: Project) {
        const connected = await this.github.maybeFor(project).catch(() => null);
        if (!connected) return null;
        const s = await this.state(project);
        const stored = await this.store.reports.branches(project.id);
        const names = new Set(stored.map((r) => r.branch));
        const status: Record<
            string,
            { onGitHub: boolean; current: boolean; githubSha: string | null; behind: number | null; diverged: boolean }
        > = {};
        for (const r of stored) {
            const githubSha = Object.hasOwn(s.branches.items, r.branch) ? (s.branches.items[r.branch] ?? null) : null;
            const st = s.branchStatus[r.branch];
            const reviewed = r.upload.commit;
            const current = Boolean(githubSha && reviewed && githubSha.startsWith(reviewed));
            // The report may have been replaced since the last check: only trust "behind" for the commit it was worked out for.
            const sameReport = st && st.reviewedSha === reviewed && st.githubSha === githubSha;
            status[r.branch] = {
                onGitHub: Boolean(githubSha),
                current,
                githubSha,
                behind: !current && sameReport ? st.behind : null,
                diverged: !current && sameReport ? st.diverged : false,
            };
        }
        return {
            fetchedAt: s.branches.fetchedAt,
            githubOnly: Object.keys(s.branches.items)
                .filter((n) => !names.has(n) && isValidBranch(n))
                .sort((a, b) => a.localeCompare(b)),
            status,
        };
    }

    // ---- runs finishing ------------------------------------------------------------------------------

    private async runFinished(job: Job, project: Project): Promise<void> {
        if (job.kind === "pr" && job.pr) {
            const n = String(job.pr.number);
            await this.update(project, (s) => {
                const p = s.prs[n];
                if (!p) return;
                if (job.status === "done" || job.status === "partial")
                    Object.assign(p, {
                        reviewedSha: job.headSha,
                        status: job.status === "partial" ? "reviewed (partly)" : "reviewed",
                        baseline: false,
                    });
                else if (job.status === "failed") Object.assign(p, { status: "review failed", attemptedSha: job.headSha });
                // A review replaced by a newer commit's isn't news; one someone cancelled is.
                else if (job.status === "cancelled" && !/^Replaced/.test(job.error ?? ""))
                    Object.assign(p, { status: "review cancelled", attemptedSha: job.headSha });
            });
        }
        if (job.status === "done" || job.status === "partial") await this.refreshBranch(project, job.branch);
    }

    /** Recompute one branch's status (after a review, or a push). */
    private async refreshBranch(project: Project, branch: string, sha?: string | null): Promise<void> {
        const gh = await this.github.maybeFor(project).catch(() => null);
        if (!gh) return;
        const s = await this.state(project);
        const items = { ...s.branches.items };
        if (sha) items[branch] = sha;
        if (!items[branch]) {
            const b = await gh.client.branch(gh.repo, branch).catch(() => null);
            if (!b) return;
            items[branch] = b.commit.sha;
        }
        const status = await this.staleness(project, gh, items, branch);
        await this.update(project, (s) => {
            s.branches.items[branch] = items[branch] as string;
            if (!s.branches.seen.includes(branch)) s.branches.seen = [...s.branches.seen, branch].slice(-5000);
            if (status[branch]) s.branchStatus[branch] = status[branch];
        });
    }

    // ---- webhook events -----------------------------------------------------------------------------

    /** Act on a verified delivery for a project (from the app's webhook or the project's own). */
    async handleEvent(
        project: Project,
        event: string | undefined,
        payload: Record<string, unknown> | null,
        deliveryId: string | null,
    ): Promise<DeliveryResult> {
        const automation = await this.settings.automation(this.store, project);
        const base = { workspaceId: project.workspaceId, projectId: project.id, event: event ?? null, deliveryId };
        const done = async (outcome: "received" | "ignored", detail: string, what: string | null = null): Promise<DeliveryResult> => {
            await this.github.recordDelivery({ ...base, what, outcome, detail });
            return { ok: true, ...(outcome === "ignored" ? { ignored: true } : {}), note: detail };
        };
        if (event === "ping") {
            if (automation.enabled) this.runs.background(`Checking ${project.slug}'s pull requests`, () => this.checkPulls(project));
            return done(
                "received",
                automation.enabled
                    ? "Webhook works. Checking for pull requests now."
                    : "Webhook works, but automatic reviews are off for this project.",
            );
        }
        if (event === "pull_request") {
            const pr = (payload?.pull_request ?? {}) as { number?: number };
            const action = String(payload?.action ?? "");
            const what = `${action || "?"} #${pr.number ?? payload?.number ?? "?"}`;
            if (!automation.enabled)
                return done("ignored", "Automatic reviews are off for this project, so nothing will be reviewed.", what);
            if (!PR_ACTIONS.has(action)) return done("ignored", `Nothing to do when a pull request is ${action || "changed"}.`, what);
            this.runs.background(`Checking ${project.slug}'s pull requests`, () => this.checkPulls(project));
            return done("received", "Checking pull requests now; the Pull requests page says whether it was queued, and why not.", what);
        }
        if (event === "push" || event === "create" || event === "delete") {
            const ref = String(payload?.ref ?? "");
            const name =
                event === "push" ? (ref.startsWith("refs/heads/") ? ref.slice(11) : null) : payload?.ref_type === "branch" ? ref : null;
            if (!name || !isValidBranch(name)) return done("ignored", "Not a branch (a tag, say), so nothing to do.");
            const gone = event === "delete" || (event === "push" && payload?.deleted === true);
            if (gone) {
                this.runs.background(`Noting ${name} was deleted`, () => this.branchGone(project, name));
                return done(
                    "received",
                    `Branch ${name} was deleted on GitHub${automation.archiveDeletedBranches && name !== project.defaultBranch ? "; its report is archived here" : ""}.`,
                    name,
                );
            }
            const after = typeof payload?.after === "string" && /^[0-9a-f]{40}$/.test(payload.after) ? payload.after : null;
            this.runs.background(`Noting ${name} moved`, () => this.refreshBranch(project, name, after));
            return done("received", `Branch ${name} updated.`, name);
        }
        return done(
            "ignored",
            `Triagent doesn't use "${event ?? "unknown"}" events. Send pull request, push, and branch creation and deletion events.`,
        );
    }

    private async branchGone(project: Project, name: string): Promise<void> {
        const automation = await this.settings.automation(this.store, project);
        const archived = automation.archiveDeletedBranches && (await this.archive(project, name));
        await this.update(project, (s) => {
            delete s.branches.items[name];
            delete s.branchStatus[name];
            if (archived) s.branches.seen = s.branches.seen.filter((n) => n !== name);
        });
    }

    /** A delivery to a project's own webhook (token mode), once its signature checked out. */
    async projectDelivery(project: Project, body: Buffer, event: string | undefined, deliveryId: string | null): Promise<DeliveryResult> {
        let payload: Record<string, unknown> | null = null;
        try {
            payload = JSON.parse(body.toString("utf8"));
        } catch {
            // not JSON: nothing to act on
        }
        const repo = (payload?.repository as { full_name?: string } | undefined)?.full_name;
        const gh = await this.github.maybeFor(project).catch(() => null);
        const connected = gh?.repo.fullName;
        if (repo && connected && repo.toLowerCase() !== connected.toLowerCase()) {
            const note = `It's for ${repo}, but this project is connected to ${connected}.`;
            await this.github.recordDelivery({
                workspaceId: project.workspaceId,
                projectId: project.id,
                event: event ?? null,
                deliveryId,
                what: null,
                outcome: "ignored",
                detail: note,
            });
            return { ok: true, ignored: true, note };
        }
        return this.handleEvent(project, event, payload, deliveryId);
    }

    /**
     * A delivery to the GitHub App's webhook. Checked against the app's webhook secret, then routed by
     * installation and repository to the projects connected to that repository, in the workspace that
     * owns the installation. Installation events keep the installations table current.
     */
    async appDelivery(
        readBody: () => Promise<Buffer>,
        signature: string | undefined,
        event: string | undefined,
        deliveryId: string | null,
    ) {
        const app = await this.github.app.credentials();
        if (!app) throw notFound("No GitHub App is set up on this instance.");
        const body = await readBody();
        const instance = { workspaceId: null, projectId: null, event: event ?? null, deliveryId, what: null };
        if (!verifySignature(app.webhookSecret, body, signature)) {
            this.github.refused.note(
                null,
                signature
                    ? "Bad signature: the app's webhook secret on GitHub doesn't match, or something changed the body on the way."
                    : "No signature.",
                "the GitHub App's webhook",
            );
            throw new ApiError(401, "Bad webhook signature.");
        }
        let payload: Record<string, unknown> = {};
        try {
            payload = JSON.parse(body.toString("utf8"));
        } catch {
            // not JSON
        }
        const installationId = Number((payload.installation as { id?: unknown } | undefined)?.id);
        const action = String(payload.action ?? "");
        const linked = Number.isSafeInteger(installationId) ? await this.store.githubInstallations.get(installationId) : null;
        const note = async (outcome: "received" | "ignored", detail: string) => {
            await this.github.recordDelivery({
                ...instance,
                workspaceId: linked?.workspaceId ?? null,
                what: action || null,
                outcome,
                detail,
            });
            return { ok: true as const, ...(outcome === "ignored" ? { ignored: true } : {}), note: detail };
        };
        if (event === "ping") return note("received", "Webhook works.");
        if (event === "installation" || event === "installation_repositories") {
            if (!linked) return note("ignored", "That installation isn't linked to a workspace (yet).");
            if (event === "installation" && action === "deleted") {
                await this.store.githubInstallations.delete(linked.id);
                return note("received", `The installation on ${linked.accountLogin} was removed on GitHub, so it's unlinked here.`);
            }
            const inst = (payload.installation ?? {}) as { repository_selection?: string; suspended_at?: string | null };
            await this.store.transaction(async (tx) => {
                const current = await tx.githubInstallations.get(linked.id);
                if (!current) return;
                await tx.githubInstallations.put({
                    ...current,
                    suspended:
                        action === "suspend" ? true : action === "unsuspend" ? false : Boolean(inst.suspended_at ?? current.suspended),
                    repositorySelection: inst.repository_selection ?? current.repositorySelection,
                });
            });
            return note("received", `Installation ${action || "changed"} on ${linked.accountLogin}.`);
        }
        if (!linked) return note("ignored", "That installation isn't linked to a workspace, so there's nothing to do.");
        const repositoryId = Number((payload.repository as { id?: unknown } | undefined)?.id);
        const projects = await this.projectsFor(linked.workspaceId, linked.id, repositoryId);
        if (!projects.length) return note("ignored", "No project in the workspace uses that repository.");
        const results = [];
        for (const project of projects) results.push(await this.handleEvent(project, event, payload, deliveryId));
        return { ok: true as const, note: results.map((r) => r.note).join(" ") };
    }

    private async projectsFor(workspaceId: string, installationId: number, repositoryId: number): Promise<Project[]> {
        const out: Project[] = [];
        for (const p of await this.store.projects.forWorkspace(workspaceId)) {
            const conn = await this.github.connection(this.store, p);
            if (conn && conn.installationId === installationId && conn.repositoryId === repositoryId) out.push(p);
        }
        return out;
    }

    // ---- the timer ------------------------------------------------------------------------------------

    /** One pass over every connected project: due checks, branch syncs and nightly scans. */
    async tick(at = new Date()): Promise<void> {
        if (!(await this.store.holdLock("github-automation"))) return;
        for (const workspace of await this.store.workspaces.list()) {
            for (const project of await this.store.projects.forWorkspace(workspace.id)) {
                try {
                    await this.tickProject(project, at);
                } catch (err) {
                    if (!(err instanceof NotConnected)) console.error(`[${project.slug}] Automatic reviews: ${(err as Error).message}`);
                }
            }
        }
    }

    private async tickProject(project: Project, at: Date): Promise<void> {
        if (!(await this.github.maybeFor(project))) return;
        const automation = await this.settings.automation(this.store, project);
        const s = await this.state(project);
        const t = at.getTime();
        const since = (iso: string | null) => (iso ? t - Date.parse(iso) : Number.POSITIVE_INFINITY);
        if (automation.enabled && since(s.lastPollAt) >= automation.pollMinutes * 60_000) await this.checkPulls(project);
        else if (!automation.enabled && s.automationSeen)
            await this.update(project, (x) => {
                x.automationSeen = false;
            });
        if (since(s.lastSyncAt) >= Math.max(automation.pollMinutes, 5) * 60_000) await this.syncBranches(project);
        if (automation.enabled && automation.nightlyHourUtc !== null && at.getUTCHours() === automation.nightlyHourUtc) {
            const today = at.toISOString().slice(0, 10);
            if (s.lastNightly !== today) {
                // Queued first, so a failure is tried again next tick (a second request replaces the first: same dedupe key).
                await this.runs.enqueue(AUTOMATION, project, specForBranch("full", project.defaultBranch, null, "nightly"));
                await this.update(project, (x) => {
                    x.lastNightly = today;
                });
            }
        }
    }

    start(): void {
        if (this.timer) return;
        const run = () => void this.tick().catch((err: unknown) => console.error(`Automatic reviews: ${(err as Error).message}`));
        setTimeout(run, 5_000).unref();
        this.timer = setInterval(run, TICK_MS);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}
