// Automatic reviews: checking a project's pull requests (on webhook events, or every few minutes) and
// queueing each one's first review once it's ready and its checks have passed, or a review someone asked
// for (a `/review` comment, the `review` label); keeping track of the repository's branches; the nightly
// full scan. With Postgres, one server process at a time does the polling (an advisory lock).
//
// Whether to review is decided in one place, domain/review-triggers.ts: this gathers what it needs from
// GitHub (only for pull requests whose answer could have changed) and acts on the answer. What each check
// decided, and why, is kept with the project, so the Pull requests page can say why a pull request was or
// wasn't reviewed.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isValidBranch } from "../../domain/names.ts";
import { plain } from "../../domain/review-run.ts";
import {
    type Checks,
    type DecisionCode,
    type DecisionInput,
    decide,
    diffFingerprint,
    isBot,
    isReviewCommand,
    NO_CHECKS_WAIT_MS,
    REVIEW_LABEL,
    type ReviewRequest,
    SKIP_LABEL,
    summariseChecks,
    type Decision as Verdict,
} from "../../domain/review-triggers.ts";
import { ApiError, notFound } from "../../errors.ts";
import { now } from "../../security.ts";
import { ACTIVE_JOB_STATUSES, type Job, type Project, type Repos } from "../../store/types.ts";
import type { Actor, Core } from "../core.ts";
import type { Reports } from "../reports.ts";
import { type JobSpec, onTheSide, type Runs, specForBranch, specForPull } from "../runs.ts";
import type { Settings } from "../settings.ts";
import { GitHubError, type Pull } from "./client.ts";
import { type Github, type GithubAccess, NotConnected, STATUS_CONTEXT } from "./service.ts";

export const AUTOMATION: Actor = { name: "automation", userId: null, via: "system" };
const GITHUB_ACTOR: Actor = { name: "GitHub", userId: null, via: "github" };
const MAX_COMPARES = 25;
/** The most open pull requests a check looks at (the most recently updated); ten pages from GitHub. */
export const MAX_OPEN_PULLS = 1000;
const TICK_MS = 30_000;
/** How many projects one pass checks at once. */
const TICK_CONCURRENCY = 4;
/** The most pull requests one check asks GitHub more about (checks, files, a diff); the rest wait for the next. */
const MAX_LOOKUPS = 40;
/** A pull request whose checks failed is asked about again this often (a webhook event for its commit asks at once). */
const FAILED_RECHECK_MS = 10 * 60_000;
/** How many comment ids, and pull requests told who may ask, a project remembers. */
const KEEP_IDS = 300;

/** What the last check decided about a pull request, kept so it isn't worked out again while nothing has changed. */
interface StoredDecision {
    /** A hash of everything the decision rests on that comes with the list of pull requests, and the settings. */
    key: string;
    action: Decision["action"];
    code: DecisionCode;
    why: string;
    at: string;
    /** False while GitHub may yet change the answer (checks running or failed, a call that didn't work). */
    settled: boolean;
}

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
    /**
     * In words: "reviewed", "queued", "draft", "waiting for checks (2 of 4)", "checks failed",
     * "reviewed at abc1234, 3 commits since", "skipped: opened by a bot", "waiting for approval"…
     */
    status: string;
    /** Open when automatic reviews were switched on: listed, but not reviewed until someone asks. */
    baseline?: boolean;
    /** GitHub says its author is a bot. */
    bot?: boolean;
    /** The fingerprint of the reviewed commit's diff (domain/review-triggers.ts), when one could be taken. */
    reviewedFingerprint?: string | null;
    /** Commits pushed since the reviewed one; null when GitHub can't say (the branch was rebased). */
    commitsSince?: number | null;
    /** When this head commit was first seen: a repository with no checks is reviewed two minutes later. */
    firstSeenAt?: string;
    decision?: StoredDecision;
    /** The `review` label is on it and has been acted on (so it isn't again, should removing it fail). */
    labelAsked?: boolean;
    /** The commit Triagent's "Waiting for checks to pass" status is on. */
    waitingOn?: string | null;
}

export interface Decision {
    number: number;
    title: string;
    sha: string | null;
    action: "queued" | "skipped" | "waiting";
    code?: DecisionCode;
    why: string;
}

interface CheckOptions {
    at?: Date;
    recheck?: readonly string[];
    fresh?: boolean;
}

/** A `/review` comment: who wrote it, and how GitHub says they relate to the repository. */
interface Ask {
    number: number;
    commentId: number | null;
    by: string;
    association: string | null;
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
    /** Whether GitHub lets this connection read check runs: false once it has refused (the app lacks "Checks: read"). */
    checksReadable?: boolean;
    /** Comments are read from here on at each check, for `/review`; and the ids of those already acted on. */
    commentsSince?: string | null;
    commentsSeen?: number[];
    /** Pull requests where someone who may not ask for a review has been told so (once each). */
    refusals?: number[];
    /** What the last scheduled scan did: queued, or skipped because the branch hadn't changed. */
    lastScan?: { at: string; action: "queued" | "skipped"; why: string } | null;
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

const PR_ACTIONS = new Set([
    "opened",
    "reopened",
    "synchronize",
    "ready_for_review",
    "converted_to_draft",
    "edited",
    "labeled",
    "unlabeled",
]);

/** Decisions GitHub may yet change without the pull request itself changing: looked at again. */
const UNSETTLED = new Set<DecisionCode>([
    "checks-pending",
    "checks-none",
    "checks-unknown",
    "checks-failed",
    "files-unknown",
    "over-budget",
]);

const short = (sha: string) => sha.slice(0, 7);
/** A commit id for a comment: only ever hex. */
const commit = (sha: string) => `\`${short(sha).replace(/[^0-9a-f]/gi, "")}\``;
const HOW_TO_ASK = "comment `/review`, add the `review` label, or use Review now in Triagent";
const REFUSAL =
    "Only people with write access to this repository can ask Triagent for a review with `/review`. Someone who has it can comment `/review`, or add the `review` label.";

/** GitHub refusing this connection something (a missing permission), as opposed to being busy or away. */
const refused = (err: unknown) =>
    err instanceof GitHubError && [403, 404, 422].includes(err.status) && !/rate limit|abuse/i.test(err.message);

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
    /** Per project, a check that's waiting its turn, with the commits whose checks it should ask about again. */
    private readonly soon = new Map<string, Set<string>>();
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
     * Look at the open pull requests and decide about each (domain/review-triggers.ts): queue its first
     * review once it's ready and its checks have passed, or one someone asked for; later pushes wait to be
     * asked. Switching automatic reviews on sets a baseline: pull requests already open are listed, not reviewed.
     * `at` is the time it's taken to be (the poller's), `recheck` commits whose checks have just changed;
     * `fresh` (someone asked for the check) asks again about every pull request whose checks failed.
     */
    checkPulls(project: Project, opts: CheckOptions = {}): Promise<GithubState["lastCheck"]> {
        return this.serial(`pulls:${project.id}`, () => this.check(project, opts));
    }

    /**
     * Check soon, in the background: several webhook events arriving together share one check, which asks
     * again about the checks of the commits (`sha`) they named.
     */
    private checkSoon(project: Project, sha?: string): void {
        const waiting = this.soon.get(project.id);
        if (waiting) {
            if (sha) waiting.add(sha);
            return;
        }
        const recheck = new Set(sha ? [sha] : []);
        this.soon.set(project.id, recheck);
        this.runs.background(`Checking ${project.slug}'s pull requests`, () =>
            this.serial(`pulls:${project.id}`, () => {
                this.soon.delete(project.id);
                return this.check(project, { recheck: [...recheck] });
            }),
        );
    }

    private async check(project: Project, opts: CheckOptions): Promise<GithubState["lastCheck"]> {
        const at = (opts.at ?? new Date()).getTime();
        const automation = await this.settings.automation(this.store, project);
        let pulls: Pull[];
        let gh: GithubAccess;
        try {
            gh = await this.github.githubFor(project);
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
        const repoName = gh.repo.fullName;
        const capped = pulls.length > MAX_OPEN_PULLS;
        pulls = pulls.slice(0, MAX_OPEN_PULLS);
        const before = await this.state(project);
        const enabled = automation.enabled;
        const baseline = enabled && !before.automationSeen;
        // `/review` comments since the last check (a webhook, where there is one, has answered its own already).
        const comments = enabled ? await this.newComments(gh, before) : null;
        for (const ask of comments?.asks ?? [])
            if (pulls.some((p) => p.number === ask.number))
                await this.answer(project, gh, automation, ask).catch((err: unknown) =>
                    console.error(`[${project.slug}] Answering /review on #${ask.number} failed: ${(err as Error).message}`),
                );
        const active = (await this.store.jobs.list({ projectId: project.id, statuses: ACTIVE_JOB_STATUSES }, 200)).filter(
            (j) => j.kind === "pr" && !onTheSide(j),
        );
        const decisions: Decision[] = [];
        const prs: Record<string, PullState> = {};
        const toQueue: { pr: Pull; spec: JobSpec; label: boolean }[] = [];
        /** What to tell GitHub afterwards: statuses, and a line on Triagent's comment. */
        const after: { what: string; task: () => Promise<unknown> }[] = [];
        let lookups = 0;
        let checksReadable: boolean | undefined;
        for (const pr of pulls) {
            const known = before.prs[pr.number];
            const sha = pr.head.sha;
            const sameHead = known?.headSha === sha;
            const labels = (pr.labels ?? []).map((l) => String(l.name ?? "")).filter((l) => l === REVIEW_LABEL || l === SKIP_LABEL);
            const hasLabel = labels.includes(REVIEW_LABEL);
            // The label asks once: not again at every check, should taking it off fail.
            const request: ReviewRequest | null = enabled && hasLabel && !known?.labelAsked ? { via: "label" } : null;
            const info: PullState = {
                number: pr.number,
                title: pr.title.slice(0, 300),
                branch: specForPull(pr).branch,
                headSha: sha,
                draft: Boolean(pr.draft),
                url: pr.html_url ?? null,
                author: pr.user?.login ?? null,
                bot: isBot(pr.user),
                reviewedSha: known?.reviewedSha ?? null,
                reviewedFingerprint: known?.reviewedFingerprint ?? null,
                attemptedSha: known?.attemptedSha ?? null,
                commitsSince: sameHead ? (known.commitsSince ?? null) : null,
                status: known?.status ?? "not reviewed",
                firstSeenAt: sameHead && known.firstSeenAt ? known.firstSeenAt : new Date(at).toISOString(),
                labelAsked: hasLabel && (Boolean(known?.labelAsked) || request !== null),
                waitingOn: known?.waitingOn ?? null,
                ...(known?.baseline && sameHead ? { baseline: true } : {}),
            };
            prs[pr.number] = info;
            const mine = active.filter((j) => j.pr?.number === pr.number);
            const approval = needsApproval(pr, automation.reviewPullRequestsFrom, repoName);
            const key = createHash("sha256")
                .update(
                    JSON.stringify([
                        sha,
                        info.draft,
                        labels,
                        info.bot,
                        approval,
                        baseline,
                        enabled,
                        automation.firstReview,
                        automation.skipPaths,
                        automation.skipBots,
                        info.reviewedSha,
                        info.reviewedFingerprint,
                        info.attemptedSha,
                        Boolean(info.baseline),
                        mine.map((j) => [j.id, j.status]),
                    ]),
                )
                .digest("hex");
            const last = known?.decision;
            // Nothing it rests on has changed: the last answer stands, and GitHub isn't asked again. One that
            // waits on checks is asked about again; one whose checks failed, now and then, or when an event says so.
            const stands =
                !request &&
                last?.key === key &&
                (last.settled ||
                    (last.code === "checks-failed" &&
                        !opts.fresh &&
                        !opts.recheck?.includes(sha) &&
                        at - Date.parse(last.at) < FAILED_RECHECK_MS));
            if (stands) {
                info.decision = last;
                decisions.push({
                    number: pr.number,
                    title: info.title,
                    sha: short(sha),
                    action: last.action,
                    code: last.code,
                    why: last.why,
                });
                continue;
            }
            const input: DecisionInput = {
                pull: { headSha: sha, draft: info.draft, author: info.author, bot: Boolean(info.bot), labels },
                settings: automation,
                state: {
                    reviewedSha: info.reviewedSha,
                    reviewedFingerprint: info.reviewedFingerprint ?? null,
                    attemptedSha: info.attemptedSha ?? null,
                    baseline: Boolean(info.baseline),
                    active: mine.map((j) => ({ status: j.status, headSha: j.headSha })),
                },
                settingBaseline: baseline,
                approval,
                request,
                firstSeenAt: Date.parse(info.firstSeenAt as string),
                now: at,
            };
            // Ask GitHub for what the decision turns out to need, and no more.
            let verdict = decide(input);
            let unsure = false;
            let counted = false;
            for (let i = 0; verdict.action === "need" && i < 4; i++) {
                if (!counted && lookups >= MAX_LOOKUPS) break;
                if (!counted) lookups++;
                counted = true;
                if (verdict.need === "checks") {
                    const read = await this.readChecks(gh, sha);
                    input.checks = read.checks;
                    checksReadable = read.readable ?? checksReadable;
                } else if (verdict.need === "files")
                    input.files = await gh.client.pullFiles(gh.repo, pr.number).catch(() => "unknown" as const);
                else if (verdict.need === "fingerprint")
                    input.fingerprint = diffFingerprint(
                        await gh.client.compareDiff(gh.repo, pr.base.ref, sha).catch(() => {
                            unsure = true;
                            return null;
                        }),
                    );
                else {
                    // Behind as well as ahead: the branch was rebased, and "ahead" would count commits already reviewed.
                    // GitHub no longer having the reviewed commit is its answer; any other failure is asked about again.
                    const cmp = await gh.client.compare(gh.repo, info.reviewedSha as string, sha).catch((err: unknown) => {
                        if (!refused(err)) unsure = true;
                        return null;
                    });
                    input.commitsSince = cmp && cmp.behind_by === 0 ? cmp.ahead_by : null;
                }
                verdict = decide(input);
            }
            if (verdict.action === "need")
                verdict = {
                    action: "wait",
                    code: "checks-unknown",
                    why: "many pull requests changed at once; this one is looked at in the next check",
                    status: null,
                };
            const action: Decision["action"] = verdict.action === "review" ? "queued" : verdict.action === "wait" ? "waiting" : "skipped";
            info.decision = {
                key,
                action,
                code: verdict.code,
                why: verdict.why,
                at: new Date(at).toISOString(),
                settled: !unsure && !UNSETTLED.has(verdict.code),
            };
            decisions.push({ number: pr.number, title: info.title, sha: short(sha), action, code: verdict.code, why: verdict.why });
            if (verdict.status) info.status = verdict.status;
            if (verdict.code === "baseline") info.baseline = true;
            if (verdict.code === "commits-since") info.commitsSince = input.commitsSince ?? null;
            if (verdict.action === "review") toQueue.push({ pr, spec: specForPull(pr), label: request !== null });
            else if (request)
                after.push({
                    what: `Taking the ${REVIEW_LABEL} label off #${pr.number}`,
                    task: () => gh.client.removeLabel(gh.repo, pr.number, REVIEW_LABEL),
                });
            if (verdict.action === "carry") {
                const from = info.reviewedSha as string;
                info.reviewedSha = sha;
                info.commitsSince = null;
                after.push({
                    what: `Carrying #${pr.number}'s status over to ${short(sha)}`,
                    task: () => this.carryStatus(project, gh, from, sha),
                });
            }
            this.afterDecision(project, gh, info, verdict, after);
        }
        // Beyond the most a check looks at, pull requests keep what's known of them (their baseline, say).
        if (capped) for (const [n, p] of Object.entries(before.prs)) if (!prs[n]) prs[n] = p;
        for (const { pr, spec, label } of toQueue) {
            await this.runs.enqueue(
                label ? { name: `the ${REVIEW_LABEL} label (GitHub)`, userId: null, via: "github" } : AUTOMATION,
                project,
                spec,
            );
            // Queued, so the label has done its work.
            if (label)
                after.push({
                    what: `Taking the ${REVIEW_LABEL} label off #${pr.number}`,
                    task: () => gh.client.removeLabel(gh.repo, pr.number, REVIEW_LABEL),
                });
        }
        const s = await this.update(project, (s) => {
            // Keep what a run finishing meanwhile recorded, and its outcome when it was of the head commit.
            for (const [n, p] of Object.entries(prs)) {
                const latest = s.prs[n];
                if (latest?.reviewedSha && latest.reviewedSha !== p.reviewedSha && latest.reviewedSha !== before.prs[n]?.reviewedSha) {
                    p.reviewedSha = latest.reviewedSha;
                    p.reviewedFingerprint = latest.reviewedFingerprint ?? null;
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
            if (checksReadable !== undefined) s.checksReadable = checksReadable;
            if (comments) {
                s.commentsSince = comments.since;
                s.commentsSeen = [...(s.commentsSeen ?? []), ...comments.seen].slice(-KEEP_IDS);
            }
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
        for (const { what, task } of after) this.runs.background(`[${project.slug}] ${what}`, task);
        const queued = decisions.filter((d) => d.action === "queued").map((d) => `#${d.number}`);
        if (queued.length || decisions.length)
            console.log(
                `[${project.slug}] Checked ${pulls.length} open pull request(s)${queued.length ? `; queued ${queued.join(", ")}` : ""}.`,
            );
        return s.lastCheck;
    }

    /**
     * A commit's checks: its check runs and its commit statuses, each read on its own. GitHub refusing the
     * check runs (the app lacks "Checks: read") is its own answer, not a pass; any other failure is
     * "unknown", to be asked again.
     */
    private async readChecks(gh: GithubAccess, sha: string): Promise<{ checks: Checks; readable?: boolean }> {
        const orUnreadable = (err: unknown) => {
            if (refused(err)) return "unreadable" as const;
            throw err;
        };
        try {
            const runs = await gh.checks.checkRuns(gh.repo, sha).catch(orUnreadable);
            const statuses = await gh.client.statuses(gh.repo, sha).catch(orUnreadable);
            return { checks: summariseChecks(runs, statuses, STATUS_CONTEXT), readable: runs !== "unreadable" };
        } catch (err) {
            return { checks: { state: "unknown", error: (err as Error).message } };
        }
    }

    /**
     * What GitHub is told once a decision is made, kept to little: one status when waiting for checks
     * starts, one when that ends without a review, and a line on Triagent's comment when commits have
     * been pushed since its review.
     */
    private afterDecision(
        project: Project,
        gh: GithubAccess,
        info: PullState,
        verdict: Exclude<Verdict, { action: "need" }>,
        after: { what: string; task: () => Promise<unknown> }[],
    ): void {
        const sha = info.headSha;
        const status = (state: "pending" | "error", description: string) =>
            after.push({
                what: `Setting the status of ${short(sha)}`,
                task: async () => this.github.setStatus(project, sha, state, description, await this.pullsUrl(project), gh.repo),
            });
        if (verdict.code === "checks-pending") {
            // Its context is left out when checks are summed up, so it can't be waited on itself.
            if (info.waitingOn !== sha) status("pending", "Waiting for checks to pass");
            info.waitingOn = sha;
        } else if (info.waitingOn === sha && verdict.action !== "wait") {
            // A review being queued sets its own status.
            if (verdict.action !== "review")
                status("error", verdict.code === "checks-failed" ? "Not reviewed: checks failed" : "Not reviewed: see Triagent for why");
            info.waitingOn = null;
        }
        const ask = `They aren't reviewed until someone asks: ${HOW_TO_ASK}.`;
        if (verdict.code === "commits-since") {
            const n = info.commitsSince;
            const since = n === null || n === undefined ? "New commits" : `${n} commit${n === 1 ? "" : "s"}`;
            after.push({
                what: `Noting new commits on #${info.number}`,
                task: () =>
                    this.github.noteOnComment(
                        project,
                        info.number,
                        `**${since} since this review** (the pull request is now at ${commit(sha)}). ${ask}`,
                    ),
            });
        } else if (verdict.action === "carry")
            after.push({
                what: `Noting #${info.number} moved`,
                task: () =>
                    this.github.noteOnComment(
                        project,
                        info.number,
                        `The pull request is now at ${commit(sha)}, with the same changes as the reviewed commit (a rebase, or a merge from the base), so this review stands.`,
                    ),
            });
    }

    /** The project's Pull requests page, for a commit status to link to. */
    private async pullsUrl(project: Project): Promise<string | null> {
        const workspace = await this.store.workspaces.get(project.workspaceId);
        if (!workspace) return null;
        return `${this.core.config.publicOrigin}/w/${encodeURIComponent(workspace.slug)}/p/${encodeURIComponent(project.slug)}/pull-requests`;
    }

    /** Put the reviewed commit's Triagent status on a commit with the same changes, so the pull request's check isn't missing. */
    private async carryStatus(project: Project, gh: GithubAccess, from: string, to: string): Promise<void> {
        const was = (await gh.client.statuses(gh.repo, from)).find((x) => x.context === STATUS_CONTEXT);
        if (!was || !["success", "failure", "error", "pending"].includes(was.state)) return;
        await this.github.setStatus(
            project,
            to,
            was.state as "success" | "failure" | "error" | "pending",
            String(was.description ?? ""),
            was.target_url ?? null,
            gh.repo,
        );
    }

    /**
     * Comments made on the repository since the last check that ask for a review. Read whether or not
     * there's a webhook (one request per check): not every connection is sent comments, and those a
     * webhook has answered are remembered. The first check only notes where to start from.
     */
    private async newComments(gh: GithubAccess, before: GithubState): Promise<{ asks: Ask[]; since: string; seen: number[] }> {
        // A minute back, for clocks that disagree; what's been seen already isn't answered twice.
        const upTo = new Date(Date.now() - 60_000).toISOString();
        const from = before.commentsSince;
        if (!from) return { asks: [], since: upTo, seen: [] };
        const comments = await gh.client.commentsSince(gh.repo, from).catch(() => null);
        if (!Array.isArray(comments)) return { asks: [], since: from, seen: [] };
        const asks: Ask[] = [];
        const seen: number[] = [];
        for (const c of comments) {
            const number = Number(/\/issues\/(\d+)$/.exec(c.issue_url ?? "")?.[1]);
            // Only ones written since (an older one that was edited doesn't ask again), and not yet answered.
            if (!Number.isSafeInteger(number) || !c.created_at || c.created_at < from || before.commentsSeen?.includes(c.id)) continue;
            if (!isReviewCommand(c.body)) continue;
            seen.push(c.id);
            asks.push({
                number,
                commentId: c.id,
                by: String(c.user?.login ?? "someone").slice(0, 60),
                association: c.author_association ?? null,
            });
        }
        // A full page: there may be more, so carry on from its last one next time (never from further back:
        // a page of old comments that were edited ends before where this one started).
        const last = comments.at(-1)?.created_at;
        const since = comments.length >= 100 && last ? (last > from ? last : from) : upTo > from ? upTo : from;
        return { asks, since, seen };
    }

    /**
     * Act on a `/review` comment: queue a review of the pull request's head commit if its author can write
     * to the repository, and say so on Triagent's own comment; otherwise say who can, once per pull request.
     */
    private async answer(
        project: Project,
        gh: GithubAccess,
        automation: Awaited<ReturnType<Settings["automation"]>>,
        ask: Ask,
    ): Promise<void> {
        const pr = await gh.client.pull(gh.repo, ask.number).catch((err: unknown) => {
            if (err instanceof GitHubError && err.status === 404) return null;
            throw err;
        });
        if (pr?.state !== "open") return;
        const s = await this.state(project);
        const known = s.prs[pr.number];
        const active = (await this.store.jobs.list({ projectId: project.id, statuses: ACTIVE_JOB_STATUSES }, 200)).filter(
            (j) => j.kind === "pr" && j.pr?.number === pr.number && !onTheSide(j),
        );
        const verdict = decide({
            pull: { headSha: pr.head.sha, draft: Boolean(pr.draft), author: pr.user?.login ?? null, bot: isBot(pr.user), labels: [] },
            settings: automation,
            state: {
                reviewedSha: known?.reviewedSha ?? null,
                reviewedFingerprint: known?.reviewedFingerprint ?? null,
                attemptedSha: known?.attemptedSha ?? null,
                baseline: Boolean(known?.baseline),
                active: active.map((j) => ({ status: j.status, headSha: j.headSha })),
            },
            request: { via: "comment", by: ask.by, association: ask.association },
            firstSeenAt: Date.now(),
            now: Date.now(),
        });
        if (verdict.action === "need") return;
        console.log(`[${project.slug}] /review on #${pr.number}: ${verdict.why}.`);
        if (verdict.action === "refuse") {
            if (s.refusals?.includes(pr.number)) return;
            await gh.client.createComment(gh.repo, pr.number, REFUSAL);
            await this.update(project, (x) => {
                x.refusals = [...(x.refusals ?? []), pr.number].slice(-KEEP_IDS);
            });
            return;
        }
        if (verdict.action !== "review") return;
        await this.runs.enqueue({ name: `${ask.by} (GitHub)`, userId: null, via: "github" }, project, specForPull(pr));
        // On Triagent's own comment, if it has one: no new comment for each request.
        this.runs.background(`[${project.slug}] Noting the review asked for on #${pr.number}`, () =>
            this.github.noteOnComment(
                project,
                pr.number,
                `A review of ${commit(pr.head.sha)} was asked for by ${plain(ask.by, 60)} with \`/review\`, and is queued.`,
            ),
        );
    }

    /** The pull requests page: each open pull request with its state, plus what the last check decided. */
    async pullRequests(project: Project) {
        const s = await this.state(project);
        const automation = await this.settings.automation(this.store, project);
        const connected = await this.github.maybeFor(project).catch(() => null);
        const active = (await this.store.jobs.list({ projectId: project.id, statuses: ACTIVE_JOB_STATUSES }, 200)).filter(
            (j) => !onTheSide(j),
        );
        const last = new Map((s.lastCheck?.decisions ?? []).map((d) => [d.number, d]));
        return {
            connected: Boolean(connected),
            mode: connected?.mode ?? null,
            repository: connected?.repo.fullName ?? null,
            automation: { enabled: automation.enabled, pollMinutes: automation.pollMinutes, firstReview: automation.firstReview },
            // False once GitHub has refused to show this connection check runs: reviews then start when ready.
            checksReadable: s.checksReadable ?? null,
            scheduledScan: s.lastScan ?? null,
            lastCheck: s.lastCheck,
            lastError: s.lastError,
            items: Object.values(s.prs)
                .sort((a, b) => b.number - a.number)
                .map((p) => {
                    const run = active.find((j) => j.pr?.number === p.number);
                    const { decision: _d, firstSeenAt: _f, labelAsked: _l, waitingOn: _w, reviewedFingerprint: _r, ...shown } = p;
                    return {
                        ...shown,
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
            const reviewed = job.status === "done" || job.status === "partial";
            // What was reviewed, by its changes: a later push with the same ones (a rebase) needn't be reviewed again.
            const fingerprint = reviewed ? await this.fingerprint(project, job.baseRef, job.headSha) : null;
            await this.update(project, (s) => {
                const p = s.prs[n];
                if (!p) return;
                if (job.status === "done" || job.status === "partial")
                    Object.assign(p, {
                        reviewedSha: job.headSha,
                        reviewedFingerprint: fingerprint,
                        commitsSince: null,
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

    /** The fingerprint of what a pull request changes at `head`, or null when there's none to be had. */
    private async fingerprint(project: Project, base: string | null, head: string | null): Promise<string | null> {
        if (!base || !head) return null;
        const gh = await this.github.maybeFor(project).catch(() => null);
        if (!gh) return null;
        return diffFingerprint(await gh.client.compareDiff(gh.repo, base, head).catch(() => null));
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
            if (automation.enabled) this.checkSoon(project);
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
            const label = String((payload?.label as { name?: unknown } | undefined)?.name ?? "");
            const what = `${action || "?"} #${pr.number ?? payload?.number ?? "?"}`;
            if (!automation.enabled)
                return done("ignored", "Automatic reviews are off for this project, so nothing will be reviewed.", what);
            if (!PR_ACTIONS.has(action)) return done("ignored", `Nothing to do when a pull request is ${action || "changed"}.`, what);
            if ((action === "labeled" || action === "unlabeled") && label !== REVIEW_LABEL && label !== SKIP_LABEL)
                return done("ignored", `Only the labels ${REVIEW_LABEL} and ${SKIP_LABEL} mean anything to Triagent.`, what);
            this.checkSoon(project);
            return done("received", "Checking pull requests now; the Pull requests page says whether it was queued, and why not.", what);
        }
        if (event === "issue_comment") {
            const issue = (payload?.issue ?? {}) as { number?: unknown; pull_request?: unknown };
            const comment = (payload?.comment ?? {}) as {
                id?: unknown;
                body?: unknown;
                author_association?: unknown;
                user?: { login?: unknown };
            };
            const number = Number(issue.number);
            const what = `#${Number.isSafeInteger(number) ? number : "?"}`;
            if (payload?.action !== "created" || !issue.pull_request || !Number.isSafeInteger(number) || !isReviewCommand(comment.body))
                return done("ignored", "Not a new comment on a pull request starting with /review, so nothing to do.", what);
            if (!automation.enabled)
                return done("ignored", "Automatic reviews are off for this project, so /review does nothing. Use Review now.", what);
            const ask: Ask = {
                number,
                commentId: Number.isSafeInteger(comment.id) ? (comment.id as number) : null,
                by: String(comment.user?.login ?? "someone").slice(0, 60),
                association: typeof comment.author_association === "string" ? comment.author_association : null,
            };
            this.runs.background(`Answering /review on ${project.slug} #${number}`, () =>
                this.serial(`pulls:${project.id}`, async () => {
                    const gh = await this.github.githubFor(project);
                    if ((await this.state(project)).commentsSeen?.includes(ask.commentId ?? -1)) return;
                    await this.answer(project, gh, automation, ask);
                    await this.update(project, (s) => {
                        if (ask.commentId !== null) s.commentsSeen = [...(s.commentsSeen ?? []), ask.commentId].slice(-KEEP_IDS);
                    });
                }),
            );
            return done("received", "Someone asked for a review with /review; the Runs page shows it once it's queued.", what);
        }
        if (event === "check_run" || event === "check_suite" || event === "status") {
            const of = (event === "status" ? payload : payload?.[event]) as { head_sha?: unknown; sha?: unknown } | null | undefined;
            const sha = String((event === "status" ? of?.sha : of?.head_sha) ?? "");
            if (!/^[0-9a-f]{40}$/.test(sha)) return done("ignored", "It doesn't say which commit it's about.");
            // Triagent's own status comes back as an event too: nothing waits on that.
            if (event === "status" && payload?.context === STATUS_CONTEXT) return done("ignored", "Triagent's own status.", short(sha));
            if (!automation.enabled)
                return done("ignored", "Automatic reviews are off for this project, so nothing waits for checks.", short(sha));
            if (event === "status" ? payload?.state === "pending" : payload?.action !== "completed")
                return done("ignored", "Nothing to do until it has finished.", short(sha));
            const waiting = Object.values((await this.state(project)).prs).some((p) => p.headSha === sha && p.decision?.settled === false);
            if (!waiting) return done("ignored", "No open pull request here is waiting on that commit's checks.", short(sha));
            this.checkSoon(project, sha);
            return done("received", "Looking again at the checks of the pull request waiting on that commit.", short(sha));
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
            `Triagent doesn't use "${event ?? "unknown"}" events. Send pull request, push, branch creation and deletion, check run, check suite, status and issue comment events.`,
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

    /**
     * One pass over every connected project: due checks, branch syncs and nightly scans. A few projects are
     * checked at once, so one slow repository doesn't hold up the rest, but never two for the same
     * repository (projects sharing one, in any workspace, take turns).
     */
    async tick(at = new Date()): Promise<void> {
        if (!(await this.store.holdLock("github-automation"))) return;
        const waiting: Project[] = [];
        for (const workspace of await this.store.workspaces.list()) waiting.push(...(await this.store.projects.forWorkspace(workspace.id)));
        const repository = (p: Project) => p.repoUrl?.toLowerCase() ?? `project:${p.id}`;
        const inHand = new Set<string>();
        const work = async () => {
            for (;;) {
                // The next project whose repository nobody is on. If each one left is in hand, whoever has it takes the next.
                const next = waiting.findIndex((p) => !inHand.has(repository(p)));
                if (next === -1) return;
                const [project] = waiting.splice(next, 1) as [Project];
                inHand.add(repository(project));
                try {
                    await this.tickProject(project, at);
                } catch (err) {
                    if (!(err instanceof NotConnected)) console.error(`[${project.slug}] Automatic reviews: ${(err as Error).message}`);
                } finally {
                    inHand.delete(repository(project));
                }
            }
        };
        await Promise.all(Array.from({ length: TICK_CONCURRENCY }, work));
    }

    private async tickProject(project: Project, at: Date): Promise<void> {
        const gh = await this.github.maybeFor(project);
        if (!gh) return;
        const automation = await this.settings.automation(this.store, project);
        const s = await this.state(project);
        const t = at.getTime();
        const since = (iso: string | null) => (iso ? t - Date.parse(iso) : Number.POSITIVE_INFINITY);
        // Between polls too, for a pull request whose two minutes of waiting for checks to start are up.
        const noChecks = Object.values(s.prs).some(
            (p) =>
                p.decision?.code === "checks-none" && p.decision.action === "waiting" && since(p.firstSeenAt ?? null) >= NO_CHECKS_WAIT_MS,
        );
        if (automation.enabled && (noChecks || since(s.lastPollAt) >= automation.pollMinutes * 60_000))
            await this.checkPulls(project, { at });
        else if (!automation.enabled && s.automationSeen)
            await this.update(project, (x) => {
                x.automationSeen = false;
            });
        if (since(s.lastSyncAt) >= Math.max(automation.pollMinutes, 5) * 60_000) await this.syncBranches(project);
        if (automation.enabled && automation.nightlyHourUtc !== null && at.getUTCHours() === automation.nightlyHourUtc) {
            const today = at.toISOString().slice(0, 10);
            if (s.lastNightly !== today) {
                const unchanged = await this.scanUnchanged(project, gh);
                // Queued first, so a failure is tried again next tick (a second request replaces the first: same dedupe key).
                if (!unchanged) await this.runs.enqueue(AUTOMATION, project, specForBranch("full", project.defaultBranch, null, "nightly"));
                else console.log(`[${project.slug}] Scheduled scan skipped: ${unchanged}.`);
                await this.update(project, (x) => {
                    x.lastNightly = today;
                    x.lastScan = unchanged
                        ? { at: at.toISOString(), action: "skipped", why: unchanged }
                        : { at: at.toISOString(), action: "queued", why: `a full scan of ${project.defaultBranch} was queued` };
                });
            }
        }
    }

    /**
     * Why a scheduled scan of the default branch would find nothing new: the branch is still at the commit
     * of its last full scan that finished whole. Null when it has moved, or that can't be told (then it's scanned).
     */
    private async scanUnchanged(project: Project, gh: GithubAccess): Promise<string | null> {
        const branch = project.defaultBranch;
        const head = (await gh.client.branch(gh.repo, branch).catch(() => null))?.commit.sha;
        if (!head) return null;
        const last = (await this.store.jobs.list({ projectId: project.id, statuses: ["done"] }, 200)).find(
            (j) => j.kind === "full" && j.branch === branch && !onTheSide(j),
        );
        if (!last?.headSha || last.headSha !== head) return null;
        return `${branch} is still at ${short(head)}, the commit of its last full scan (${(last.finishedAt ?? "").slice(0, 10)})`;
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
