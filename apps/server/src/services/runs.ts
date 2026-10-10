// Review runs. A run is a job in the store: queued, claimed by a runner (a separate process with no
// database, over /internal/runner), kept alive by its lease, and finished by uploading the report.
//
// Scheduling is fair between workspaces: the workspace whose last run started longest ago goes first,
// oldest job first within it, under an instance-wide cap and a per-workspace cap. A job only starts
// when its models are ready (`models.forProject`). A runner that stops renewing its lease
// loses the job, which is marked failed, saying so.

import { setTimeout as sleep } from "node:timers/promises";
import { anyOption, JUDGE_FIRST, NO_OPTIONS, type RunOptions, type Severity } from "@triagent/shared";
import { candidatePairs, type FindingPair, groupFindings, joinGroups, MAX_JUDGE_PAIRS, samePair } from "@triagent/shared/merge";
import { modelSecrets, type RunnerModel } from "@triagent/shared/model";
import { redactDeep, redactor } from "@triagent/shared/redact";
import { type BakeOff, compareModels } from "../domain/bake-off.ts";
import { parseFilters } from "../domain/filters.ts";
import { findingsOf, MAX_MODELS, type ModelReport, mergeReports } from "../domain/merge.ts";
import { isValidBranch } from "../domain/names.ts";
import type { RawReport } from "../domain/report.ts";
import { reportMetrics } from "../domain/review-metrics.ts";
import { commentBody, finishedStatus, reviewGaps } from "../domain/review-run.ts";
import { ApiError, badRequest, conflict, notFound } from "../errors.ts";
import { now, randomId } from "../security.ts";
import {
    ACTIVE_JOB_STATUSES,
    type Job,
    type JobKind,
    type JobStatus,
    type Project,
    type Repos,
    type ReviewRecord,
    type RunnerRecord,
    type Workspace,
} from "../store/types.ts";
import type { Actor, Core } from "./core.ts";
import type { CommitState, Pull } from "./github/client.ts";
import { COMMENT_MARKER, type Github, NotConnected, RepositoryChanged, sameRepository } from "./github/service.ts";
import type { History } from "./history.ts";
import type { Models, RunModel } from "./models.ts";
import type { Reports } from "./reports.ts";
import { ReviewLimitSettings } from "./review-limits.ts";
import { type RunOptionsInput, runOptions, type Settings } from "./settings.ts";

export const LOG_CAP_BYTES = 2 * 1024 * 1024;
export const LEASE_SECONDS = 60;
const MAX_LINE = 4000;
const MAX_LINES_PER_BATCH = 2000;
/** As for uploads: the ids of findings a review reported first, for analytics, at most this many. */
const MAX_ADDED_IDS = 5000;
const PROGRESS_EVERY_MS = 1000;
/** A runner not heard from for this long is no longer counted as connected. */
const RUNNER_GONE_MS = 90_000;

/** Who uploads a run's report. `via: "github"` keeps runs from being counted again as uploads. */
const REVIEWER: Actor = { name: "Open Code Review", userId: null, via: "github" };

export interface StartInput {
    kind: JobKind;
    number?: number;
    branch?: string;
    base?: string;
    /** The models for this run only: favourite models' ids, or "instance". Without any, the project's rule decides. */
    models?: string[] | undefined;
    /** Options for several models, for this run only. Without any, the project's own apply. */
    options?: RunOptionsInput | undefined;
}

export interface JobSpec {
    kind: JobKind;
    title: string;
    branch: string;
    gitRef: string | null;
    baseRef: string | null;
    headSha: string | null;
    baseSha: string | null;
    pr: Job["pr"];
    dedupeKey: string;
}

export interface RunnerHello {
    id: string;
    name: string;
    version: string | null;
    /** How many more jobs it can take now. */
    slots: number;
    /** How many it works on at once in all. A runner older than this doesn't say: it's worked out from the jobs it holds. */
    capacity?: number | null;
}

/** How one model's review went, in a run with several (in the order the job gave them). */
export interface FinishPart {
    status: "done" | "failed" | "cancelled";
    report?: unknown;
    error?: string | null;
    /** The most tokens OCR said it used while running. */
    tokens?: number | null;
    seconds?: number | null;
    /** Why it was stopped, when it was (a runner older than this doesn't say: its message is read instead). */
    reason?: StopReason | null;
}

/** Why a model's review was stopped before it finished: it went quiet, or passed the time limit or its token budget. */
export type StopReason = "stalled" | "timeLimit" | "overBudget";

/**
 * A model of a running job that its runner should stop, while the job's other models carry on. The runner
 * gives it a while to finish by itself first, and only one it had to stop comes back failed, as `overBudget`.
 */
export interface ModelStop {
    /** Its place in the job's models. */
    index: number;
    label: string;
    reason: "overBudget";
    /** The token budget it passed. */
    budget: number;
}

/**
 * What a runner is told when it reports in: stop the whole job (`cancel`), or only some of its models
 * (`stop`). A runner older than models reviewing at once reads `cancel` and nothing else.
 */
export interface Orders {
    cancel: boolean;
    stop: ModelStop[];
}

export interface FinishInput {
    status: "done" | "failed" | "cancelled";
    report?: unknown;
    /** A run with several models: how each went. `report` is unused then; the server merges these. */
    parts?: FinishPart[];
    /** What the model the review asked said about pairs of its findings, as the runner sent it: checked by `readJudged`. */
    judged?: unknown;
    error?: string | null;
    headSha?: string | null;
    baseSha?: string | null;
}

/** What's sealed with a running job: the secrets to redact from its log, and its own GitHub token to revoke at the end. */
interface JobCredentials {
    secrets: string[];
    revoke: string | null;
}

/** Everything a runner needs for one job, including credentials for that job only. */
export interface ClaimedJob {
    id: string;
    kind: JobKind;
    title: string;
    leaseSeconds: number;
    repository: { fullName: string; cloneUrl: string };
    git: { username: string; token: string };
    pr: { number: number } | null;
    gitRef: string | null;
    baseRef: string | null;
    headSha: string | null;
    /** The project's time limit for this kind of review, or null for none. */
    timeoutMinutes: number | null;
    /** Stop a model's review that has printed nothing for this long, or null to never. */
    stallMinutes: number | null;
    maxTokensBudget: number | null;
    /** The protocol OCR speaks to the model and this job's credentials for it: the first of `models`. */
    model: RunnerModel;
    /**
     * Every model to review with, in order, each with how people know it. A model with a token budget of
     * its own (the instance's, out of the workspace's allowance) says so; the others use `maxTokensBudget`.
     */
    models: (RunnerModel & { label: string; maxTokensBudget?: number | null })[];
    /**
     * Review exactly these commits, whatever the pull request or branch is at by now: a model of a
     * finished review being run again. A runner that doesn't know this reviews what it fetched, and
     * its findings aren't added to the review's report unless that's the same commit.
     */
    commit?: { head: string; base: string | null };
    /**
     * The model to ask which findings are the same problem once the reviews are in, with this job's
     * credentials for it, when the review chose to have one asked. A runner that doesn't know this sends
     * no answers, and the findings are merged by place only.
     */
    judge?: RunnerModel & { label: string };
}

/** How asking a model about a review's findings went, kept with the run. */
export interface JudgeResult {
    label: string | null;
    provider: string | null;
    model: string | null;
    /** Pairs there were to ask about, how many were asked (at most MAX_JUDGE_PAIRS), and how many it said are the same problem. */
    candidates: number;
    asked: number;
    same: number;
    /** Findings fewer because of it. */
    merged: number;
    tokens: Tokens | null;
    seconds: number | null;
    /** Why nothing was asked or its answers weren't used: the findings are then merged by place only. */
    error: string | null;
}

const whole = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/**
 * What the runner says a model answered about pairs of findings, checked against the reviews themselves:
 * at most MAX_JUDGE_PAIRS pairs, each of two findings that exist, from different models, in the same
 * file, and one of the pairs worth asking about (as the server works them out from the same reports).
 * Anything else, and none of it is used: `error` says why, and `same` is empty.
 */
export function readJudged(
    given: unknown,
    parts: readonly ModelReport[],
    clean: (text: string) => string = (t) => t,
): { same: FindingPair[]; asked: number; candidates: number; tokens: Tokens | null; seconds: number | null; error: string | null } {
    const findings = findingsOf(parts);
    const expected = candidatePairs(findings);
    const none = (error: string, tokens: Tokens | null = null, seconds: number | null = null) => ({
        same: [],
        asked: 0,
        candidates: expected.total,
        tokens,
        seconds,
        error,
    });
    if (given === undefined || given === null)
        return none("The runner didn't ask (it may be too old to), so findings were merged by where they are only. Update the runner.");
    if (typeof given !== "object" || Array.isArray(given))
        return none("The runner's answers couldn't be read, so findings were merged by where they are only.");
    const g = given as { pairs?: unknown; tokens?: unknown; seconds?: unknown; error?: unknown };
    const t = g.tokens as { input?: unknown; output?: unknown } | null | undefined;
    const used = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 1e9) : 0);
    const tokens: Tokens | null =
        t && typeof t === "object" && used(t.input) + used(t.output) > 0
            ? { input: used(t.input), output: used(t.output), cacheRead: 0, total: used(t.input) + used(t.output) }
            : null;
    const seconds =
        typeof g.seconds === "number" && Number.isFinite(g.seconds) && g.seconds >= 0 ? Math.min(Math.round(g.seconds), 1e6) : null;
    if (typeof g.error === "string" && g.error)
        return none(
            `The model couldn't be asked (${clean(g.error).slice(0, 500)}), so findings were merged by where they are only.`,
            tokens,
            seconds,
        );
    const refused = (why: string) =>
        none(`The runner's answers weren't used (${why}), so findings were merged by where they are only.`, tokens, seconds);
    if (!Array.isArray(g.pairs)) return refused("they aren't a list of pairs");
    if (g.pairs.length > MAX_JUDGE_PAIRS) return refused(`there are more than ${MAX_JUDGE_PAIRS} of them`);
    const pairs: (FindingPair & { same: boolean })[] = [];
    const ref = (r: unknown): FindingPair["a"] | null => {
        const x = r as { part?: unknown; index?: unknown } | null;
        return x && typeof x === "object" && whole(x.part) && whole(x.index) ? { part: x.part, index: x.index } : null;
    };
    const at = (r: FindingPair["a"]) => findings[r.part]?.[r.index] as { path?: unknown } | null | undefined;
    for (const raw of g.pairs as unknown[]) {
        const p = raw as { a?: unknown; b?: unknown; same?: unknown } | null;
        if (!p || typeof p !== "object" || typeof p.same !== "boolean") return refused("one isn't a pair with a true or false answer");
        const a = ref(p.a);
        const b = ref(p.b);
        if (!a || !b) return refused("one doesn't name two findings");
        const x = at(a);
        const y = at(b);
        if (!x || !y || typeof x !== "object" || typeof y !== "object") return refused("one names a finding that isn't in the reviews");
        if (a.part === b.part) return refused("one pairs two findings of the same model");
        if (typeof x.path !== "string" || x.path !== y.path) return refused("one pairs findings in different files");
        const pair = { a, b };
        if (!expected.pairs.some((e) => samePair(e, pair))) return refused("one isn't a pair that was to be asked about");
        if (pairs.some((e) => samePair(e, pair))) return refused("one pair is there twice");
        pairs.push({ ...pair, same: p.same });
    }
    return { same: pairs.filter((p) => p.same), asked: pairs.length, candidates: expected.total, tokens, seconds, error: null };
}

/** One model of a finished review run again by itself, as the review's own page lists it. */
export interface Retry {
    /** The model's place in the review. */
    index: number;
    label: string;
    /** The run that ran it again. */
    id: string;
    /** 2 for the first time it was run again. */
    attempt: number;
    /** Without being asked: the review's `retryFailed` option. */
    auto: boolean;
    status: JobStatus;
    queuedAt: string;
    finishedAt: string | null;
    /** Its own findings, once it has finished. */
    total: number | null;
    /** Of those, how many were new to the report, and how many joined a finding another model made. */
    added: number | null;
    agreed: number | null;
    /** Why its findings weren't added to the report, when it finished but they weren't. */
    notAdded: string | null;
    error: string | null;
}

/** Where a review keeps the runs that ran its models again: it points at them, and they say how they went. */
interface RetryPointer {
    index: number;
    id: string;
    auto: boolean;
}

const retriesOf = (job: Pick<Job, "result">): RetryPointer[] =>
    Array.isArray(job.result?.retries) ? (job.result.retries as RetryPointer[]) : [];

/** What a model run again made of the branch's report, kept with its run. */
interface RerunResult {
    of: string;
    index: number;
    label: string;
    attempt: number;
    auto: boolean;
    added: number | null;
    agreed: number | null;
    notAdded: string | null;
    /** The report with its findings in: what the pull request's check and comment now say. */
    branch?: {
        total: number;
        bySeverity: Record<Severity, number>;
        gaps: ReturnType<typeof reviewGaps>;
        models: string[];
        agreement?: Agreed;
    };
}

/**
 * A job beside a branch's reviews: one model of a finished review run again, or a review run only to
 * compare its models. It doesn't take over the pull request's check, and automatic reviews don't count
 * it as a review.
 */
export const onTheSide = (job: Pick<Job, "rerunOf" | "options">): boolean => Boolean(job.rerunOf || job.options?.bakeOff);

/** A run's result as lists show it: a comparison's findings are left for the comparison itself. */
function listed(result: Job["result"]): Job["result"] {
    const made = result?.bakeOff as BakeOff | undefined;
    if (!result || !made) return result;
    const { findings: _f, ...summary } = made;
    return { ...result, bakeOff: summary };
}

type View = ReturnType<Runs["view"]>;

const sourceOf = (actor: Actor): Job["source"] => (actor.via === "system" ? "automation" : actor.tokenId ? "token" : "person");

/** Same-repository pull requests keep their branch name; those from forks become pr/<number>. */
export function branchForPull(pr: Pull): string {
    const sameRepo = pr.head.repo?.full_name && pr.head.repo.full_name === pr.base.repo?.full_name;
    const name = sameRepo ? pr.head.ref : `pr/${pr.number}`;
    return isValidBranch(name) ? name : `pr/${pr.number}`;
}

export function specForPull(pr: Pull): JobSpec {
    return {
        kind: "pr",
        title: `PR #${pr.number}: ${pr.title}`.slice(0, 300),
        branch: branchForPull(pr),
        gitRef: null,
        baseRef: pr.base.ref,
        headSha: pr.head.sha,
        baseSha: null,
        pr: {
            number: pr.number,
            title: pr.title.slice(0, 300),
            url: pr.html_url ?? null,
            headRef: pr.head.ref,
            author: pr.user?.login ?? null,
        },
        dedupeKey: `pr:${pr.number}`,
    };
}

export function specForBranch(kind: "changes" | "full", gitRef: string, baseRef: string | null, reason?: string): JobSpec {
    return {
        kind,
        title: kind === "full" ? `Full scan of ${gitRef}${reason ? ` (${reason})` : ""}` : `Changes on ${gitRef} since ${baseRef}`,
        branch: gitRef,
        gitRef,
        baseRef: kind === "changes" ? baseRef : null,
        headSha: null,
        baseSha: null,
        pr: null,
        dedupeKey: kind === "full" ? `full:${gitRef}` : `changes:${gitRef}:${baseRef}`,
    };
}

const PROGRESS_KEYS = new Set([
    "phase",
    "files",
    "filesChanged",
    "groups",
    "groupsDone",
    "current",
    "round",
    "roundsFailed",
    "toolCalls",
    "toolFailures",
    "message",
    "tokens",
    "model",
]);

/** One model's progress, in a run with several: the same, with its label, when it started, how long it took and why it was stopped. */
const MODEL_PROGRESS_KEYS = new Set([...PROGRESS_KEYS, "label", "startedAt", "seconds", "reason"]);
MODEL_PROGRESS_KEYS.delete("model");

/** Only what the progress view shows, bounded, its text redacted like the log. */
function cleanProgress(input: unknown, clean: (text: string) => string): Record<string, unknown> {
    const fields = (given: unknown, keys: Set<string>) => {
        const out: Record<string, unknown> = {};
        if (!given || typeof given !== "object") return out;
        for (const [k, v] of Object.entries(given)) {
            if (!keys.has(k)) continue;
            if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.max(0, Math.min(v, 1e9));
            else if (typeof v === "string") out[k] = clean(v.slice(0, 1000)).slice(0, 200);
        }
        return out;
    };
    const out = fields(input, PROGRESS_KEYS);
    // Several models: each one's own progress, in the job's order.
    const models = (input as { models?: unknown } | null)?.models;
    if (Array.isArray(models)) out.models = models.slice(0, MAX_MODELS).map((m) => fields(m, MODEL_PROGRESS_KEYS));
    return out;
}

/** How a model's review in a run with several ended, as its progress says once it has. */
const ENDED = new Set(["done", "failed", "cancelled"]);

/**
 * The models of a running job to stop because they've passed their token budget: OCR has said one used
 * more than the budget it runs under (the project's, or what's left of the instance's allowance if that's
 * less). Only for a job with several models, by each one's own progress; one that has ended, or has no
 * budget, is never named.
 */
export function overBudget(job: Pick<Job, "model" | "progress">): ModelStop[] {
    const models = job.model?.models;
    const progress = job.progress.models;
    if (!models || models.length < 2 || !Array.isArray(progress)) return [];
    const stop: ModelStop[] = [];
    for (const [index, m] of models.entries()) {
        const p = progress[index] as { tokens?: unknown; phase?: unknown } | undefined;
        if (!m.budget || !p || typeof p.tokens !== "number" || ENDED.has(String(p.phase))) continue;
        if (p.tokens > m.budget) stop.push({ index, label: m.label, reason: "overBudget", budget: m.budget });
    }
    return stop;
}

/**
 * A run's progress as it's shown: each model still going says how long it has been (its runner says when it
 * started, by the runner's clock; one that has ended says how long it took itself).
 */
function timed(progress: Job["progress"]): Job["progress"] {
    if (!Array.isArray(progress.models)) return progress;
    const at = now();
    return {
        ...progress,
        models: (progress.models as Record<string, unknown>[]).map((m) => {
            if (typeof m.startedAt !== "string" || typeof m.seconds === "number") return m;
            const going = seconds(m.startedAt, at);
            return { ...m, seconds: Number.isFinite(going) ? going : 0 };
        }),
    };
}

/** Why a model was stopped: what its runner said, or (a runner older than that) what its message says. */
function stopReason(given: unknown, error: string | null): StopReason | null {
    if (given === "stalled" || given === "timeLimit" || given === "overBudget") return given;
    if (!error) return null;
    return /^Stalled: /.test(error) ? "stalled" : /^Stopped after .*time limit/.test(error) ? "timeLimit" : null;
}

/** With no secrets of its own to take out: credentials of known shapes, and characters Postgres can't hold. */
const CLEAN_ONLY = redactor([]);

/**
 * The project's token budget, or what's left of an instance allowance if that's less, so one run can't
 * overspend it. `Models.forRun` never offers an allowance with less than MIN_TOKENS_BUDGET left.
 */
export function budget(project: number | null, allowance: number | null): number | null {
    if (allowance === null) return project;
    return project === null ? allowance : Math.min(project, allowance);
}

type Tokens = NonNullable<ReviewRecord["tokens"]>;

/**
 * The tokens a run used: the larger of what its report says and what OCR said while it ran (a report
 * can be missing, or written before the end). Null when neither said anything.
 */
export function runTokens(reported: Tokens | null, said: unknown): Tokens | null {
    const seen = typeof said === "number" && Number.isFinite(said) && said >= 0 ? Math.round(said) : null;
    if (seen === null || (reported && reported.total >= seen)) return reported;
    // What OCR said while running is a total only; the difference is counted as input.
    if (!reported) return { input: seen, output: 0, cacheRead: 0, total: seen };
    return { ...reported, input: reported.input + (seen - reported.total), total: seen };
}

/** One model's outcome in a run with several. */
interface Part {
    /** The favourite it was (or "instance"), as the job recorded it. */
    id?: string | null;
    provider: string;
    model: string;
    label: string;
    keySource?: "workspace" | "instance";
    budget?: number | null;
    /** Its tokens are its whole budget, since it never said what it used (see `record`). */
    estimated?: boolean;
    status: "done" | "partial" | "failed" | "cancelled";
    /** Why it was stopped, if it was. */
    reason: StopReason | null;
    report: RawReport | null;
    metrics: ReturnType<typeof reportMetrics> | null;
    tokens: Tokens | null;
    seconds: number | null;
    error: string | null;
}

/** Tokens added up across models; null when none of them said. */
export function sumTokens(list: readonly (Tokens | null)[]): Tokens | null {
    const known = list.filter((t): t is Tokens => t !== null);
    if (!known.length) return null;
    return known.reduce((a, t) => ({
        input: a.input + t.input,
        output: a.output + t.output,
        cacheRead: a.cacheRead + t.cacheRead,
        total: a.total + t.total,
    }));
}

/**
 * The options a review runs with, from those asked for: none with one model, and no rule that more
 * models must agree than it has.
 */
export function effectiveOptions(asked: RunOptions, models: number): RunOptions {
    if (models < 2) return structuredClone(NO_OPTIONS);
    const failAt = asked.agreement.failAt === null ? null : Math.min(asked.agreement.failAt, models);
    return { ...asked, agreement: { ...asked.agreement, failAt } };
}

/** What a review's agreement rule made of its findings: the rule, and the critical findings enough models found. */
export interface Agreed {
    /** At least this many models: the rule, or every model that finished when fewer did than the rule asks. */
    models: number;
    critical: number;
}

/**
 * The critical findings of a merged report that at least `failAt` of its models found. When fewer models
 * finished than that, all that did must have: a rule nothing could meet would pass every review.
 */
export function agreedCritical(report: RawReport, failAt: number): Agreed {
    const finished = Array.isArray(report.models) ? report.models.length : 1;
    const models = Math.max(1, Math.min(failAt, finished));
    const found = (c: RawReport["comments"][number]) => (Array.isArray(c.found_by) ? c.found_by.length : 1);
    return { models, critical: report.comments.filter((c) => c.severity === "critical" && found(c) >= models).length };
}

/** Why a queued review won't start: its project now uses another repository. */
const movedOn = (job: Pick<Job, "repository">, now: string) =>
    `This project now uses ${now}, but this review was queued for ${job.repository?.fullName}. Start it again to review ${now}.`;

/** Only what a runner needs of a model: never the rest of what the server knows about it. */
const forRunner = (m: RunModel): RunnerModel => ({
    provider: m.provider,
    protocol: m.protocol,
    url: m.url,
    model: m.model,
    apiKey: m.apiKey,
    ...(m.aws ? { aws: m.aws } : {}),
});

const seconds = (from: string | null, to: string | null) =>
    from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)) : undefined;

export class Runs {
    private readonly core: Core;
    private readonly github: Github;
    private readonly reports: Reports;
    private readonly history: History;
    private readonly models: Models;
    private readonly settings: Settings;
    private readonly limits: ReviewLimitSettings;
    /** Redacting functions by job, so a log batch doesn't decrypt the job's secrets each time. */
    private readonly redactions = new Map<string, (text: string) => string>();
    private readonly progressSent = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> | null }>();
    /** Runners heard from recently, so their record isn't written on every poll. */
    private readonly runnerSeen = new Map<string, number>();
    /** Background work (GitHub statuses and comments) still going, so tests and shutdown can wait for it. */
    private readonly pending = new Set<Promise<unknown>>();
    /** Called once a run has finished and its report is saved (automation refreshes the branch's status). */
    onFinished: (job: Job, project: Project) => void = () => {};

    constructor(
        core: Core,
        github: Github,
        reports: Reports,
        history: History,
        models: Models,
        settings: Settings,
        limits: ReviewLimitSettings = new ReviewLimitSettings(core),
    ) {
        this.core = core;
        this.limits = limits;
        this.github = github;
        this.reports = reports;
        this.history = history;
        this.models = models;
        this.settings = settings;
    }

    private get store() {
        return this.core.store;
    }

    /** Run `task` in the background, logging (not throwing) its failure. */
    background(what: string, task: () => Promise<unknown>): void {
        const p = task()
            .catch((err: unknown) => console.error(`${what} failed: ${(err as Error).message}`))
            .finally(() => this.pending.delete(p));
        this.pending.add(p);
    }

    /** Wait for background work to finish (tests, shutdown). */
    async settled(): Promise<void> {
        while (this.pending.size) await Promise.allSettled([...this.pending]);
    }

    // ---- views -----------------------------------------------------------------------------------

    view(job: Job, project: Pick<Project, "slug"> | null, waiting?: string | null) {
        return {
            id: job.id,
            project: project?.slug ?? null,
            kind: job.kind,
            title: job.title,
            branch: job.branch,
            gitRef: job.gitRef,
            baseRef: job.baseRef,
            headSha: job.headSha,
            baseSha: job.baseSha,
            pr: job.pr,
            requestedBy: { name: job.requestedBy.name, userId: job.requestedBy.userId },
            source: job.source,
            status: job.status,
            queuedAt: job.queuedAt,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            elapsedSeconds: seconds(job.startedAt, job.finishedAt ?? (job.startedAt ? now() : null)) ?? null,
            cancelRequested: job.cancelRequested,
            progress: job.status === "running" ? timed(job.progress) : job.progress,
            result: listed(job.result),
            error: job.error,
            model: job.model,
            requestedModels: job.requestedModels,
            options: job.options ?? null,
            ...(job.rerunOf
                ? {
                      rerunOf: {
                          id: job.rerunOf.jobId,
                          index: job.rerunOf.index,
                          label: job.rerunOf.label,
                          attempt: job.rerunOf.attempt,
                          auto: job.rerunOf.auto,
                      },
                  }
                : {}),
            log: { lines: job.logLines, dropped: job.logDropped },
            ...(waiting !== undefined ? { waiting } : {}),
        };
    }

    private async slugs(workspaceId: string): Promise<Map<string, Project>> {
        return new Map((await this.store.projects.forWorkspace(workspaceId)).map((p) => [p.id, p]));
    }

    private async connectedRunners() {
        const t = Date.now();
        return (await this.store.runners.list()).filter((r) => t - Date.parse(r.lastSeenAt) < RUNNER_GONE_MS);
    }

    /**
     * The connected runners, each with how many reviews it can work on at once (`slots`) and how many it's
     * working on now (`busy`), and how many reviews are running and queued on the whole instance. For
     * instance administrators: runners serve every workspace.
     */
    async runners() {
        const [runners, active] = await Promise.all([this.connectedRunners(), this.store.jobs.active()]);
        const running = active.filter((j) => j.status === "running");
        return {
            runners: runners
                .map((r) => ({
                    name: r.name,
                    version: r.version,
                    slots: r.slots,
                    busy: running.filter((j) => j.runnerId === r.id).length,
                    lastSeenAt: r.lastSeenAt,
                }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            running: running.length,
            queued: active.length - running.length,
        };
    }

    /**
     * Whether reviews in the workspace can start now, and if not, why: in one project, if given (its own
     * models may be chosen), and for one review of it (its kind's models, or those it was asked to use).
     */
    async readiness(
        workspace: Workspace,
        project?: Project,
        job?: Pick<Job, "kind" | "requestedModels">,
    ): Promise<{ ready: boolean; reason: string | null }> {
        const model = project
            ? await this.models.forProject(workspace, project, job?.kind ?? null, job?.requestedModels ?? null)
            : await this.models.forRun(workspace);
        if (!model.ready) return { ready: false, reason: model.reason };
        if (!this.core.config.runnerSecret)
            return { ready: false, reason: "No runner can connect: the server has no TRIAGENT_RUNNER_SECRET set." };
        if (!(await this.connectedRunners()).length) return { ready: false, reason: "No runner is connected. Start one (see the README)." };
        return { ready: true, reason: null };
    }

    /**
     * Queued, running and recent runs in a workspace (one project, if given). Runners serve the whole
     * instance, so their names and versions are only listed for instance administrators (`runnerDetails`);
     * everyone sees how many are connected.
     */
    async list(workspace: Workspace, filter: { projectId?: string; limit?: number; runnerDetails?: boolean } = {}) {
        const projects = await this.slugs(workspace.id);
        // One snapshot of the queue for everything below, so the counts agree with each other.
        const everyActive = await this.store.jobs.active();
        const active = everyActive.filter((j) => j.workspaceId === workspace.id);
        const only = filter.projectId ? projects.get(filter.projectId) : undefined;
        const readiness = await this.readiness(workspace, only);
        // Each queued review waits on its own models: its project's for its kind, or those it was asked to use.
        const reasons = new Map<string, string | null>();
        const waitsOn = (j: Job) => `${j.projectId} ${j.kind} ${j.requestedModels?.join(" ") ?? ""}`;
        for (const j of active) {
            const p = projects.get(j.projectId);
            if (j.status !== "queued" || reasons.has(waitsOn(j)) || !p) continue;
            reasons.set(waitsOn(j), (await this.readiness(workspace, p, j)).reason);
        }
        const limits = await this.limits.read();
        const wsLimit = ReviewLimitSettings.forWorkspace(limits, workspace.id);
        const everyRunning = everyActive.filter((j) => j.status === "running");
        const allRunning = everyRunning.length;
        const wsRunning = active.filter((j) => j.status === "running").length;
        const runners = await this.connectedRunners();
        const busyOn = (r: RunnerRecord) => everyRunning.filter((j) => j.runnerId === r.id).length;
        // The limits can allow more than the runners can do: then reviews wait for a runner with room.
        const freeSlots = runners.reduce((n, r) => n + Math.max(0, r.slots - busyOn(r)), 0);
        const busy =
            wsRunning >= wsLimit
                ? wsLimit === 1
                    ? "Waiting for this workspace's running review to finish."
                    : `Waiting for one of this workspace's running reviews to finish (it runs ${wsLimit} at once).`
                : allRunning >= limits.instance
                  ? "Waiting for a free slot: the instance is running as many reviews as it allows."
                  : runners.length && !freeSlots
                    ? "Waiting for a free runner slot: every connected runner is busy."
                    : "Waiting for a runner to pick it up.";
        const mine = (j: Job) => !filter.projectId || j.projectId === filter.projectId;
        const recent = (
            await this.store.jobs.list(
                {
                    workspaceId: workspace.id,
                    ...(filter.projectId ? { projectId: filter.projectId } : {}),
                    statuses: ["done", "partial", "failed", "cancelled"],
                },
                Math.min(filter.limit ?? 30, 200),
            )
        ).map((j) => this.view(j, projects.get(j.projectId) ?? null));
        return {
            ready: readiness.ready,
            waiting: readiness.reason,
            // `workspace` is this workspace's own limit: never another's, and never more than the instance's.
            concurrency: { instance: limits.instance, workspace: wsLimit },
            runnersConnected: runners.length,
            runners: filter.runnerDetails
                ? runners.map((r) => ({ name: r.name, slots: r.slots, busy: busyOn(r), version: r.version, lastSeenAt: r.lastSeenAt }))
                : [],
            running: active.filter((j) => j.status === "running" && mine(j)).map((j) => this.view(j, projects.get(j.projectId) ?? null)),
            queued: active
                .filter((j) => j.status === "queued" && mine(j))
                .map((j) =>
                    this.view(
                        j,
                        projects.get(j.projectId) ?? null,
                        reasons.get(waitsOn(j)) ??
                            (active.some((r) => r.status === "running" && r.projectId === j.projectId && r.dedupeKey === j.dedupeKey)
                                ? "Waiting for the review of the same thing that's running to finish."
                                : busy),
                    ),
                ),
            recent,
            counts: {
                running: active.filter((j) => j.status === "running" && mine(j)).length,
                queued: active.filter((j) => j.status === "queued" && mine(j)).length,
            },
        };
    }

    private async jobIn(workspace: Workspace, id: string, repos: Repos = this.store): Promise<Job> {
        const job = /^[\w-]{1,40}$/.test(id) ? await repos.jobs.get(id) : null;
        if (!job || job.workspaceId !== workspace.id) throw notFound("No such run in this workspace.");
        return job;
    }

    /** One run, with its log after line `after`. */
    async get(workspace: Workspace, id: string, after = 0) {
        const job = await this.jobIn(workspace, id);
        const project = await this.store.projects.get(job.projectId);
        const lines = await this.store.jobs.log(job.id, Math.max(0, after), MAX_LINES_PER_BATCH);
        return {
            ...this.view(
                job,
                project,
                job.status === "queued"
                    ? (await this.list(workspace, { limit: 1 })).queued.find((q) => q.id === job.id)?.waiting
                    : undefined,
            ),
            ...(project && job.model?.models && !ACTIVE_JOB_STATUSES.includes(job.status)
                ? { retries: await this.retries(job), rerunnable: await this.rerunnable(job, project) }
                : {}),
            logLines: lines,
            next: lines.at(-1)?.seq ?? Math.max(after, job.logDropped),
        };
    }

    /** What a review run only to compare its models found: each model's figures, what they had in common, and the findings. */
    async comparison(workspace: Workspace, id: string) {
        const job = await this.jobIn(workspace, id);
        if (!job.options?.bakeOff) throw notFound("That run isn't a comparison of models. Start one with Compare models only.");
        const made = (job.result?.bakeOff as BakeOff | undefined) ?? null;
        if (!made)
            throw conflict(
                ACTIVE_JOB_STATUSES.includes(job.status)
                    ? "This comparison hasn't finished yet."
                    : `This comparison ${job.status === "cancelled" ? "was cancelled" : "failed"}, so there's nothing to compare. ${job.error ?? ""}`.trim(),
            );
        return { run: this.view(job, await this.store.projects.get(job.projectId)), comparison: made };
    }

    // ---- running one model again -------------------------------------------------------------------

    /** The runs that ran this review's models again, oldest first, each as it stands now. */
    private async retries(job: Job, repos: Repos = this.store): Promise<Retry[]> {
        const out: Retry[] = [];
        for (const p of retriesOf(job)) {
            const run = await repos.jobs.get(p.id);
            if (!run?.rerunOf) continue;
            const made = (run.result?.rerun as RerunResult | undefined) ?? null;
            out.push({
                index: p.index,
                label: run.rerunOf.label,
                id: run.id,
                attempt: run.rerunOf.attempt,
                auto: run.rerunOf.auto,
                status: run.status,
                queuedAt: run.queuedAt,
                finishedAt: run.finishedAt,
                total: typeof run.result?.total === "number" ? run.result.total : null,
                added: made?.added ?? null,
                agreed: made?.agreed ?? null,
                notAdded: made?.notAdded ?? null,
                error: run.error,
            });
        }
        return out;
    }

    /**
     * Why one model of a finished review can't be run again now, or null when it can: it must have failed
     * or been stopped in a review with several that made a report, not be running again already or have
     * its findings in, and the report must still be the branch's.
     */
    private async rerunBlocked(repos: Repos, job: Job, project: Project, index: number): Promise<string | null> {
        const models = job.model?.models;
        const results = job.result?.models as { label: string; status: string }[] | undefined;
        if (job.rerunOf) return "This run is itself one model being run again. Run it again from the review it belongs to.";
        if (job.options?.bakeOff) return "A comparison has no report to add to. Start the comparison again instead.";
        if (!models || models.length < 2 || !Array.isArray(results)) return "Only a review with several models has models to run again.";
        const m = models[index];
        const how = results[index];
        if (!m || !how) return `This review has no model at place ${index}.`;
        if (job.status !== "done" && job.status !== "partial")
            return "No model of this review finished, so it made no report to add to. Start the review again instead.";
        if (how.status === "done" || how.status === "partial")
            return `${m.label} finished in this review, so there's nothing to run again.`;
        for (const r of await this.retries(job, repos)) {
            if (r.index !== index) continue;
            if (ACTIVE_JOB_STATUSES.includes(r.status)) return `${m.label} is already being run again.`;
            if ((r.status === "done" || r.status === "partial") && !r.notAdded) return `${m.label}'s findings have been added already.`;
        }
        const reportId = typeof job.result?.reportId === "string" ? job.result.reportId : null;
        if (!reportId || !job.headSha)
            return "This review doesn't say which report it made or which commit it was of, so nothing can be added to it. Start a new review instead.";
        const stored = await repos.reports.get(project.id, job.branch);
        if (stored?.upload.id !== reportId)
            return `A newer report has replaced this review's on ${job.branch}, so ${m.label}'s findings can't be added to it. Start a new review instead.`;
        if (!m.id) return `${m.label} isn't one of this workspace's favourite models, so it can't be run again by itself.`;
        return null;
    }

    /** The models of a finished review, by place, that didn't finish in it: each can be run again, or says why not. */
    private async rerunnable(job: Job, project: Project): Promise<{ index: number; reason: string | null }[]> {
        const results = Array.isArray(job.result?.models) ? (job.result.models as { status: string }[]) : [];
        const out: { index: number; reason: string | null }[] = [];
        for (const [index, m] of results.entries())
            if (m.status !== "done" && m.status !== "partial")
                out.push({ index, reason: await this.rerunBlocked(this.store, job, project, index) });
        return out;
    }

    /**
     * Queue a job that runs one model of `job` again, on the commit it reviewed, to add its findings to
     * the report `job` made. Returns it, and `job` pointing at it (saved here).
     */
    private async queueRerun(
        w: { tx: Repos; afterCommit(fn: () => void): void },
        job: Job,
        project: Project,
        index: number,
        by: Pick<Job, "requestedBy" | "source"> & { auto: boolean },
    ): Promise<{ queued: Job; job: Job }> {
        const m = job.model?.models?.[index] as NonNullable<NonNullable<Job["model"]>["models"]>[number];
        const queued: Job = {
            id: randomId(),
            workspaceId: job.workspaceId,
            projectId: job.projectId,
            kind: job.kind,
            dedupeKey: `rerun:${job.id}:${index}`,
            title: `${m.label} again: ${job.title}`.slice(0, 300),
            branch: job.branch,
            gitRef: job.gitRef,
            baseRef: job.baseRef,
            headSha: job.headSha,
            baseSha: job.baseSha,
            pr: job.pr,
            requestedBy: by.requestedBy,
            requestedModels: [m.id as string],
            // One model, so none of the review's options: what the review asked for is read from it when this ends.
            options: structuredClone(NO_OPTIONS),
            rerunOf: {
                jobId: job.id,
                index,
                label: m.label,
                attempt: 2 + retriesOf(job).filter((r) => r.index === index).length,
                auto: by.auto,
                reportId: typeof job.result?.reportId === "string" ? job.result.reportId : null,
            },
            source: by.source,
            status: "queued",
            queuedAt: now(),
            startedAt: null,
            finishedAt: null,
            runnerId: null,
            leaseExpiresAt: null,
            cancelRequested: null,
            progress: {},
            result: null,
            error: null,
            model: null,
            credentials: null,
            repository: job.repository,
            logLines: 0,
            logDropped: 0,
        };
        const pointer: RetryPointer = { index, id: queued.id, auto: by.auto };
        const next: Job = { ...job, result: { ...(job.result ?? {}), retries: [...retriesOf(job), pointer] } };
        await w.tx.jobs.put(queued);
        await w.tx.jobs.put(next);
        w.afterCommit(() => {
            this.announce(queued, project, "queued");
            this.announce(next, project, "progress");
        });
        return { queued, job: next };
    }

    /**
     * Run one model of a finished review again: a small job for that model alone, on the commit the review
     * was of. When it finishes, its findings are added to the report the review made, if that's still the
     * branch's report; triage on what's there is left as it is.
     */
    async rerun(actor: Actor, workspace: Workspace, id: string, index: number) {
        const { queued, project } = await this.core.write(actor, async (w) => {
            const job = await this.jobIn(workspace, id, w.tx);
            const project = await w.tx.projects.get(job.projectId);
            if (!project) throw notFound("No such run in this workspace.");
            const why = await this.rerunBlocked(w.tx, job, project, index);
            if (why) throw conflict(why);
            // The model must still be one this workspace can choose (a favourite, or the instance's with an allowance).
            await this.settings.checkModelIds(w.tx, workspace, [job.model?.models?.[index]?.id as string]);
            const by = { requestedBy: { name: actor.name, userId: actor.userId, tokenId: actor.tokenId ?? null }, source: sourceOf(actor) };
            return { queued: (await this.queueRerun(w, job, project, index, { ...by, auto: false })).queued, project };
        });
        return this.view(queued, project);
    }

    /** Resolves once the run has finished, or after `seconds` (at most ten minutes), with its latest state. */
    async waitFor(workspace: Workspace, id: string, waitSeconds: number) {
        const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 600) * 1000;
        for (;;) {
            const job = await this.jobIn(workspace, id);
            const done = !ACTIVE_JOB_STATUSES.includes(job.status);
            if (done || Date.now() >= deadline)
                return { finished: done, run: this.view(job, await this.store.projects.get(job.projectId)) };
            await sleep(Math.min(1000, Math.max(50, deadline - Date.now())));
        }
    }

    // ---- starting and cancelling -------------------------------------------------------------------

    /** Start a review someone asked for: checked against GitHub, then queued. */
    async start(actor: Actor, project: Project, input: StartInput) {
        const gh = await this.github.githubFor(project);
        const branchName = (v: string | undefined, fallback: string) => {
            const b = (v ?? "").trim() || fallback;
            if (!isValidBranch(b)) throw badRequest(`"${b.slice(0, 100)}" isn't a valid branch name.`);
            return b;
        };
        const exists = async (name: string) => {
            await gh.client.branch(gh.repo, name).catch((err: { status?: number }) => {
                throw err.status === 404 ? notFound(`${gh.repo.fullName} has no branch "${name}" on GitHub. Push it first.`) : err;
            });
        };
        let spec: JobSpec;
        if (input.kind === "pr") {
            if (!input.number || !Number.isInteger(input.number) || input.number < 1) throw badRequest("Give the pull request's number.");
            const pr = await gh.client.pull(gh.repo, input.number).catch((err: { status?: number }) => {
                throw err.status === 404 ? notFound(`${gh.repo.fullName} has no pull request #${input.number}.`) : err;
            });
            if (pr.state !== "open") throw badRequest(`Pull request #${pr.number} isn't open.`);
            spec = specForPull(pr);
        } else if (input.kind === "changes") {
            if (!input.branch) throw badRequest("Name the branch whose changes to review.");
            const gitRef = branchName(input.branch, "");
            const base = branchName(input.base, project.defaultBranch);
            if (gitRef === base)
                throw badRequest(`"${gitRef}" is the base branch, so it has no changes of its own. Scan all of it instead.`);
            await exists(gitRef);
            await exists(base);
            const cmp = await gh.client.compare(gh.repo, base, gitRef);
            if (cmp.ahead_by === 0) throw badRequest(`${gitRef} has no commits that aren't on ${base}, so there's nothing to review.`);
            spec = specForBranch("changes", gitRef, base);
        } else {
            const gitRef = branchName(input.branch, project.defaultBranch);
            await exists(gitRef);
            spec = specForBranch("full", gitRef, null);
        }
        const models = input.models?.length ? input.models : null;
        const options = input.options ? runOptions(input.options) : null;
        const workspace = await this.store.workspaces.get(project.workspaceId);
        if (models && workspace) await this.settings.checkModelIds(this.store, workspace, models);
        if (options && workspace) await this.checkOptions(workspace, project, spec.kind, models, options);
        // A comparison is its own thing: it neither replaces nor waits for a review of the same pull request or branch.
        if (options?.bakeOff) spec = { ...spec, title: `Comparison: ${spec.title}`.slice(0, 300), dedupeKey: `compare:${spec.dedupeKey}` };
        const job = await this.enqueue(actor, project, spec, models, options);
        return this.view(job, project);
    }

    /**
     * Options asked for a review, checked against the models it would run with now (its own, or the
     * project's for its kind). Throws a 400 saying what's wrong: they only mean something with several models.
     */
    private async checkOptions(workspace: Workspace, project: Project, kind: JobKind, models: string[] | null, options: RunOptions) {
        if (!anyOption(options)) return;
        const count = models?.length ?? (await this.models.list(workspace, project)).rules?.[kind].ids.length ?? 1;
        if (count < 2)
            throw badRequest(
                `These options are for reviews with two or more models, and this one has ${count === 1 ? "one" : "none"}. Choose more models, or leave the options out.`,
            );
        const failAt = options.agreement.failAt;
        if (failAt !== null && failAt > count)
            throw badRequest(`This review has ${count} models, so agreement.failAt can be at most ${count}.`);
        if (options.bakeOff && (options.retryFailed || failAt !== null || options.agreement.markSingles))
            throw badRequest(
                "A comparison leaves the branch's report and the pull request's check alone, so retryFailed and agreement don't apply to it. Leave them out, or start an ordinary review.",
            );
        if (options.judge) {
            const problem = await this.settings.judgeProblem(this.store, workspace, options.judge);
            if (problem) throw badRequest(problem);
            // "The first that can": at least one of the models it would run with must be able to.
            if (options.judge === JUDGE_FIRST) {
                const ids = models ?? (await this.models.list(workspace, project)).rules?.[kind].ids ?? [];
                const able = [];
                for (const id of ids) if ((await this.settings.judgeProblem(this.store, workspace, id)) === null) able.push(id);
                if (!able.length)
                    throw badRequest(
                        "None of this review's models can be asked which findings are the same problem (they're on Amazon Bedrock, or the instance's). Name a favourite model as `judge`, or leave it out.",
                    );
            }
        }
    }

    /**
     * Queue a review. A queued job for the same thing is replaced; one already queued or running for the
     * same commit is returned instead of queueing another (whichever models that one uses). `models` are
     * this run's own (see `Models.forProject`), and `options` its options for several models; automatic
     * reviews give neither, and get the project's.
     */
    async enqueue(
        actor: Actor,
        project: Project,
        spec: JobSpec,
        models: string[] | null = null,
        options: RunOptions | null = null,
    ): Promise<Job> {
        // The repository it's for, so it never starts on, or reports to, another if the project moves.
        const gh = await this.github.maybeFor(project).catch(() => null);
        const repository = gh ? { id: gh.repo.id, fullName: gh.repo.fullName } : null;
        const created = await this.core.write(actor, async (w) => {
            const same = (await w.tx.jobs.list({ projectId: project.id, statuses: ACTIVE_JOB_STATUSES }, 100)).filter(
                (j) => j.dedupeKey === spec.dedupeKey,
            );
            const duplicate = same.find((j) => spec.headSha && j.headSha === spec.headSha);
            if (duplicate) return { job: duplicate, isNew: false };
            for (const old of same.filter((j) => j.status === "queued")) {
                const replaced: Job = {
                    ...old,
                    status: "cancelled",
                    finishedAt: now(),
                    error: `Replaced by a newer request${spec.headSha ? ` (commit ${spec.headSha.slice(0, 7)})` : ""}.`,
                };
                await w.tx.jobs.put(replaced);
                w.afterCommit(() => this.announce(replaced, project, "finished"));
            }
            const job: Job = {
                id: randomId(),
                workspaceId: project.workspaceId,
                projectId: project.id,
                ...spec,
                requestedBy: { name: actor.name, userId: actor.userId, tokenId: actor.tokenId ?? null },
                requestedModels: models,
                options,
                source: sourceOf(actor),
                status: "queued",
                queuedAt: now(),
                startedAt: null,
                finishedAt: null,
                runnerId: null,
                leaseExpiresAt: null,
                cancelRequested: null,
                progress: {},
                result: null,
                error: null,
                model: null,
                credentials: null,
                repository,
                logLines: 0,
                logDropped: 0,
            };
            await w.tx.jobs.put(job);
            w.afterCommit(() => this.announce(job, project, "queued"));
            return { job, isNew: true };
        });
        if (created.isNew && created.job.kind === "pr" && created.job.headSha && !onTheSide(created.job)) {
            const job = created.job;
            this.background(`Marking ${job.title} as queued on GitHub`, async () => {
                const workspace = await this.store.workspaces.get(project.workspaceId);
                const ready = workspace ? await this.readiness(workspace, project, job) : { ready: false, reason: null };
                await this.github.setStatus(
                    project,
                    job.headSha as string,
                    "pending",
                    ready.ready ? "Queued for review" : "Queued: reviews are waiting (see Triagent)",
                    this.runUrl(workspace, project, job),
                    job.repository,
                );
            });
        }
        return created.job;
    }

    async cancel(actor: Actor, workspace: Workspace, id: string) {
        const out = await this.core.write(actor, async (w) => {
            const job = await this.jobIn(workspace, id, w.tx);
            const project = await w.tx.projects.get(job.projectId);
            if (job.status === "queued") {
                const next: Job = {
                    ...job,
                    status: "cancelled",
                    finishedAt: now(),
                    error: `Cancelled by ${actor.name} before it started.`,
                };
                await w.tx.jobs.put(next);
                w.afterCommit(() => {
                    this.announce(next, project, "finished");
                    this.finishedBeside(next, project);
                    if (project && !onTheSide(next)) this.onFinished(next, project);
                    if (next.kind === "pr" && next.headSha && project && !onTheSide(next))
                        this.background("Marking a cancelled review on GitHub", () =>
                            this.github.setStatus(project, next.headSha as string, "error", "Review cancelled", null, next.repository),
                        );
                });
                return next;
            }
            if (job.status === "running") {
                if (job.cancelRequested) return job;
                const next: Job = { ...job, cancelRequested: { by: actor.name, at: now() } };
                await w.tx.jobs.put(next);
                w.afterCommit(() => this.announce(next, project, "progress"));
                return next;
            }
            throw conflict("That run has already finished.");
        });
        return this.view(out, await this.store.projects.get(out.projectId));
    }

    // ---- the runner protocol -----------------------------------------------------------------------

    private async noteRunner(r: RunnerHello): Promise<void> {
        const last = this.runnerSeen.get(r.id) ?? 0;
        if (Date.now() - last < 15_000) return;
        this.runnerSeen.set(r.id, Date.now());
        if (this.runnerSeen.size > 1000) this.runnerSeen.delete(this.runnerSeen.keys().next().value as string);
        // Kept as how many it works on at once. A runner that only says how many more it can take (an older
        // one) is taken to have that many and the jobs it holds.
        const capacity =
            r.capacity ?? r.slots + (await this.store.jobs.active()).filter((j) => j.status === "running" && j.runnerId === r.id).length;
        await this.store.runners.seen({
            id: r.id,
            name: CLEAN_ONLY(r.name),
            version: r.version === null ? null : CLEAN_ONLY(r.version),
            slots: Math.min(capacity, 100),
            lastSeenAt: now(),
        });
    }

    /** Hand a runner the next job it may start, or null. */
    async claim(runner: RunnerHello): Promise<ClaimedJob | null> {
        await this.noteRunner(runner);
        if (!runner.slots) return null;
        await this.sweep();
        const picked = await this.store.transaction(async (tx) => {
            // Read here, with the queue, so a limit an admin just saved applies to this very claim. Lowering one
            // below what's running stops nothing: no more start until enough have finished.
            const limits = await this.limits.read(tx);
            const active = await tx.jobs.active();
            const running = active.filter((j) => j.status === "running");
            if (running.length >= limits.instance) return null;
            // Never more than the runner works on at once, whatever it says it has room for.
            if (typeof runner.capacity === "number" && running.filter((j) => j.runnerId === runner.id).length >= runner.capacity)
                return null;
            const runningIn = new Map<string, number>();
            for (const j of running) runningIn.set(j.workspaceId, (runningIn.get(j.workspaceId) ?? 0) + 1);
            const queuedIn = new Map<string, Job[]>();
            for (const j of active) if (j.status === "queued") queuedIn.set(j.workspaceId, [...(queuedIn.get(j.workspaceId) ?? []), j]);
            const lastStarted = await tx.jobs.lastStarted();
            // Taking turns: the workspace served longest ago goes first; then whoever has waited longest.
            const order = [...queuedIn.keys()].sort(
                (a, b) =>
                    (lastStarted.get(a) ?? "").localeCompare(lastStarted.get(b) ?? "") ||
                    (queuedIn.get(a)?.[0]?.queuedAt ?? "").localeCompare(queuedIn.get(b)?.[0]?.queuedAt ?? ""),
            );
            for (const workspaceId of order) {
                if ((runningIn.get(workspaceId) ?? 0) >= ReviewLimitSettings.forWorkspace(limits, workspaceId)) continue;
                const workspace = await tx.workspaces.get(workspaceId);
                if (!workspace) continue;
                for (const job of queuedIn.get(workspaceId) ?? []) {
                    // A review of the same thing (a pull request, say) is running: this one waits for it.
                    if (running.some((r) => r.projectId === job.projectId && r.dedupeKey === job.dedupeKey)) continue;
                    const project = await tx.projects.get(job.projectId);
                    if (!project) continue;
                    // Which models depends on the run, its kind and its project; a job whose models aren't ready
                    // waits (the list says why), unless waiting can't help: then it fails, saying so.
                    const automation = await this.settings.automation(tx, project);
                    const chosen = await this.models.forProject(workspace, project, job.kind, job.requestedModels, tx);
                    if (!chosen.ready) {
                        if (chosen.gone) await this.failQueued(tx, job, project, workspace, chosen.reason);
                        continue;
                    }
                    let notConnected: string | null = null;
                    try {
                        const access = await this.github.githubFor(project, tx);
                        if (!sameRepository(job.repository, access.repo)) notConnected = movedOn(job, access.repo.fullName);
                    } catch (err) {
                        if (!(err instanceof NotConnected)) throw err;
                        notConnected = err.message;
                    }
                    if (notConnected) {
                        const failed: Job = { ...job, status: "failed", finishedAt: now(), error: notConnected };
                        await tx.jobs.put(failed);
                        this.store.afterCommit(() => {
                            this.announce(failed, project, "finished");
                            this.finishedBeside(failed, project);
                        });
                        continue;
                    }
                    // With the instance key, a model's budget comes out of what's left of the allowance until the
                    // run ends. Each model has the project's budget to itself; only the instance's is capped.
                    const budgets = chosen.models.map((m) => budget(automation.maxTokensBudget, m.allowance?.remaining ?? null));
                    const model = chosen.models[0] as RunModel;
                    // For a runner that gives every model the job's budget: the tightest, so none can overspend.
                    const capped = budgets.filter((b): b is number => b !== null);
                    const maxTokensBudget = chosen.models.some((m) => m.allowance) ? Math.min(...capped) : automation.maxTokensBudget;
                    // A comparison whose models are down to one since it was asked for can't compare anything, and must
                    // never run as an ordinary review instead: that would replace the branch's report.
                    if (job.options?.bakeOff && chosen.models.length < 2) {
                        const why =
                            "A comparison needs two or more models, and this one now has one. Start it again and choose its models.";
                        await this.failQueued(tx, job, project, workspace, why);
                        continue;
                    }
                    // Its options: its own, or the project's; none of them apply to a review with one model.
                    const asked = job.options ?? runOptions(automation.options);
                    const options = effectiveOptions(asked, chosen.models.length);
                    // The model it asks which findings are the same problem, if it chose to have one asked and there is one.
                    const judge = options.judge ? await this.models.judgeFor(workspace, chosen.models, options.judge, tx) : null;
                    const started: Job = {
                        ...job,
                        status: "running",
                        startedAt: now(),
                        runnerId: runner.id,
                        leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000).toISOString(),
                        model: {
                            id: model.id,
                            provider: model.provider,
                            model: model.model,
                            label: model.label,
                            keySource: model.keySource,
                            budget: budgets[0] ?? null,
                            ...(chosen.models.length > 1
                                ? {
                                      models: chosen.models.map((m, i) => ({
                                          id: m.id,
                                          provider: m.provider,
                                          model: m.model,
                                          label: m.label,
                                          keySource: m.keySource,
                                          budget: budgets[i] ?? null,
                                      })),
                                  }
                                : {}),
                            ...(judge
                                ? {
                                      judge:
                                          "error" in judge
                                              ? judge
                                              : {
                                                    id: judge.model.id,
                                                    provider: judge.model.provider,
                                                    model: judge.model.model,
                                                    label: judge.model.label,
                                                },
                                  }
                                : {}),
                        },
                        options: anyOption(options) ? options : null,
                        progress: { phase: "starting" },
                    };
                    await tx.jobs.put(started);
                    if (anyOption(asked) && !anyOption(options))
                        await tx.jobs.appendLog(
                            job.id,
                            [
                                {
                                    at: now(),
                                    line: "[triagent] This review has one model, so the options for several models don't apply to it.",
                                },
                            ],
                            LOG_CAP_BYTES,
                        );
                    if (judge && "error" in judge)
                        await tx.jobs.appendLog(
                            job.id,
                            [
                                {
                                    at: now(),
                                    line: `[triagent] No model will be asked which findings are the same problem: ${judge.error}. They're merged by where they are only.`,
                                },
                            ],
                            LOG_CAP_BYTES,
                        );
                    return {
                        job: started,
                        project,
                        workspace,
                        models: chosen.models,
                        budgets,
                        automation,
                        maxTokensBudget,
                        judge: judge && "model" in judge ? judge.model : null,
                    };
                }
            }
            return null;
        });
        if (!picked) return null;
        const { job, project, workspace, models, budgets, automation, maxTokensBudget } = picked;
        let judge = picked.judge;

        // Credentials for this job only, minted now (outside the transaction: it calls GitHub).
        let token: string;
        let revoke: boolean;
        let gh: Awaited<ReturnType<Github["githubFor"]>>;
        try {
            gh = await this.github.githubFor(project);
            if (!sameRepository(job.repository, gh.repo)) throw new RepositoryChanged(movedOn(job, gh.repo.fullName));
            ({ token, revoke } = await gh.tokenForJob());
        } catch (err) {
            if (err instanceof RepositoryChanged) {
                await this.conclude(job.id, runner.id, { status: "failed", error: err.message });
                return null;
            }
            await this.conclude(job.id, runner.id, {
                status: "failed",
                error: `Couldn't get access to the repository: ${(err as Error).message}`,
            });
            return null;
        }
        // A URL someone typed in (a custom server, Azure) may resolve somewhere else by now: check it again.
        let unsafe: string | null = null;
        for (const m of models) {
            unsafe ??= await this.models.recheck(m).catch((err: Error) => `Couldn't check the model's URL: ${err.message}`);
        }
        if (unsafe) {
            await this.conclude(job.id, runner.id, { status: "failed", error: unsafe });
            if (revoke) this.revoke(job, token);
            return null;
        }
        // The same check for the model that's asked about the findings; one that fails it isn't asked, and the review goes on.
        const unsafeJudge =
            judge && !models.includes(judge)
                ? await this.models.recheck(judge).catch((err: Error) => `Couldn't check the model's URL: ${err.message}`)
                : null;
        if (unsafeJudge) judge = null;
        const scope = { workspaceId: job.workspaceId, projectId: job.projectId };
        const credentials: JobCredentials = {
            secrets: [token, ...[...models, ...(judge ? [judge] : [])].flatMap((m) => modelSecrets(m))],
            revoke: revoke ? token : null,
        };
        const sealed = this.core.secrets.seal(JSON.stringify(credentials), scope, `job:${job.id}`);
        const stillOurs = await this.store.transaction(async (tx) => {
            const current = await tx.jobs.get(job.id);
            if (current?.status !== "running" || current.runnerId !== runner.id) return false;
            await tx.jobs.put({
                ...current,
                credentials: sealed,
                ...(unsafeJudge && current.model ? { model: { ...current.model, judge: { error: unsafeJudge } } } : {}),
            });
            return true;
        });
        if (!stillOurs) {
            this.revoke(job, credentials.revoke);
            return null;
        }
        this.redactions.set(job.id, redactor(credentials.secrets));
        this.announce(job, project, "started");
        if (job.kind === "pr" && job.headSha && !onTheSide(job))
            this.background(`Marking ${job.title} as in review on GitHub`, () =>
                this.github.setStatus(
                    project,
                    job.headSha as string,
                    "pending",
                    "Reviewing with Open Code Review…",
                    this.runUrl(workspace, project, job),
                    job.repository,
                ),
            );
        return {
            id: job.id,
            kind: job.kind,
            title: job.title,
            leaseSeconds: LEASE_SECONDS,
            repository: { fullName: gh.repo.fullName, cloneUrl: gh.cloneUrl },
            git: { username: "x-access-token", token },
            pr: job.pr ? { number: job.pr.number } : null,
            gitRef: job.gitRef,
            baseRef: job.baseRef,
            headSha: job.headSha,
            timeoutMinutes: job.kind === "full" ? automation.fullScanTimeoutMinutes : automation.reviewTimeoutMinutes,
            stallMinutes: automation.stallMinutes,
            maxTokensBudget,
            model: forRunner(models[0] as RunModel),
            models: models.map((m, i) => ({
                ...forRunner(m),
                label: m.label,
                ...(m.allowance ? { maxTokensBudget: budgets[i] ?? null } : {}),
            })),
            ...(job.rerunOf && job.headSha ? { commit: { head: job.headSha, base: job.baseSha } } : {}),
            ...(judge ? { judge: { ...forRunner(judge), label: judge.label } } : {}),
        };
    }

    /** A model run again has ended, however: the review it belongs to is announced too, so its page shows how it went. */
    private finishedBeside(job: Job, project: Pick<Project, "slug"> | null): void {
        const of = job.rerunOf?.jobId;
        if (of) void this.store.jobs.get(of).then((original) => original && this.announce(original, project, "progress"));
    }

    /** End a queued review that can never start, saying why (and telling its pull request, like a cancelled one). */
    private async failQueued(tx: Repos, job: Job, project: Project, workspace: Workspace, error: string): Promise<void> {
        const failed: Job = { ...job, status: "failed", finishedAt: now(), error };
        await tx.jobs.put(failed);
        this.store.afterCommit(() => {
            this.announce(failed, project, "finished");
            this.finishedBeside(failed, project);
            if (onTheSide(failed)) return;
            this.onFinished(failed, project);
            if (failed.kind === "pr" && failed.headSha)
                this.background(`Marking ${failed.title} as failed on GitHub`, () =>
                    this.github.setStatus(
                        project,
                        failed.headSha as string,
                        "error",
                        "Review failed — see Triagent for details",
                        this.runUrl(workspace, project, failed),
                        failed.repository,
                    ),
                );
        });
    }

    /** The job a runner says it's running, if it still is; otherwise 409 (stop working on it). */
    private async held(tx: Repos, runnerId: string, jobId: string): Promise<Job> {
        const job = /^[\w-]{1,40}$/.test(jobId) ? await tx.jobs.get(jobId) : null;
        if (job?.status !== "running" || job.runnerId !== runnerId)
            throw new ApiError(409, "This job isn't running on this runner any more. Stop working on it.", { code: "job_lost" });
        return job;
    }

    private renewed(job: Job): Job {
        return { ...job, leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000).toISOString() };
    }

    async heartbeat(runner: RunnerHello, jobId: string): Promise<Orders & { leaseExpiresAt: string }> {
        await this.noteRunner(runner);
        const job = await this.store.transaction(async (tx) => {
            const next = this.renewed(await this.held(tx, runner.id, jobId));
            await tx.jobs.put(next);
            return next;
        });
        return { cancel: Boolean(job.cancelRequested), stop: overBudget(job), leaseExpiresAt: job.leaseExpiresAt as string };
    }

    /** The credentials handed out for a job, from its sealed copy (older jobs kept a bare list of secrets). */
    private credentialsOf(job: Job): JobCredentials | null {
        if (!job.credentials) return null;
        try {
            const raw = JSON.parse(
                this.core.secrets.unseal(job.credentials, { workspaceId: job.workspaceId, projectId: job.projectId }, `job:${job.id}`),
            ) as JobCredentials | string[];
            return Array.isArray(raw) ? { secrets: raw, revoke: null } : raw;
        } catch (err) {
            console.error(`Couldn't read the credentials of run ${job.id}: ${(err as Error).message}`);
            return null;
        }
    }

    /** Revoke a job's own GitHub token, in the background (it expires within the hour regardless). */
    private revoke(job: Pick<Job, "id" | "title">, token: string | null): void {
        if (token) this.background(`Revoking the GitHub token of ${job.title}`, () => this.github.app.revokeToken(token));
    }

    private async redactionsFor(job: Job): Promise<(text: string) => string> {
        const hit = this.redactions.get(job.id);
        if (hit) return hit;
        const clean = redactor(this.credentialsOf(job)?.secrets ?? []);
        this.redactions.set(job.id, clean);
        return clean;
    }

    /** Log lines and progress from a runner. Every secret handed out for the job is removed before they're kept. */
    async events(
        runner: RunnerHello,
        jobId: string,
        input: { lines?: { at?: string; line: string }[]; progress?: unknown },
    ): Promise<Orders> {
        await this.noteRunner(runner);
        const lines = (input.lines ?? []).slice(0, MAX_LINES_PER_BATCH);
        const first = await this.store.jobs.get(jobId);
        const redact = first && first.runnerId === runner.id ? await this.redactionsFor(first) : CLEAN_ONLY;
        const clean = lines.map((l) => ({
            at: typeof l.at === "string" && !Number.isNaN(Date.parse(l.at)) ? new Date(l.at).toISOString() : now(),
            line: redact(String(l.line ?? "")).slice(0, MAX_LINE),
        }));
        const progress = input.progress === undefined ? null : cleanProgress(input.progress, redact);
        const job = await this.store.transaction(async (tx) => {
            const held = await this.held(tx, runner.id, jobId);
            // Tokens only go up: the most OCR has said it used.
            if (progress && typeof progress.tokens === "number" && typeof held.progress.tokens === "number")
                progress.tokens = Math.max(progress.tokens, held.progress.tokens);
            const next = this.renewed(progress ? { ...held, progress: { ...held.progress, ...progress } } : held);
            await tx.jobs.put(next);
            if (clean.length) await tx.jobs.appendLog(jobId, clean, LOG_CAP_BYTES);
            return next;
        });
        this.progressed(job);
        // A model that has passed its token budget is to be stopped (if it doesn't finish by itself soon); the others carry on.
        return { cancel: Boolean(job.cancelRequested), stop: overBudget(job) };
    }

    /** Announce progress at most once a second per run (the last change always goes out). */
    private progressed(job: Job): void {
        const sent = this.progressSent.get(job.id) ?? { at: 0, timer: null };
        this.progressSent.set(job.id, sent);
        if (sent.timer) return;
        const wait = Math.max(0, PROGRESS_EVERY_MS - (Date.now() - sent.at));
        sent.timer = setTimeout(() => {
            sent.timer = null;
            sent.at = Date.now();
            void this.store.projects.get(job.projectId).then((p) => this.announce(job, p, "progress"));
        }, wait);
        sent.timer.unref();
    }

    async finish(runner: RunnerHello, jobId: string, input: FinishInput) {
        await this.noteRunner(runner);
        const job = await this.conclude(jobId, runner.id, input);
        return { ok: true, status: job?.status ?? null };
    }

    /** Fail running jobs whose runner stopped renewing the lease (a runner that crashed or was restarted). */
    async sweep(): Promise<number> {
        const t = Date.now();
        const lost = (await this.store.jobs.active()).filter(
            (j) => j.status === "running" && j.leaseExpiresAt && Date.parse(j.leaseExpiresAt) < t,
        );
        for (const j of lost) {
            await this.conclude(
                j.id,
                null,
                j.cancelRequested
                    ? { status: "cancelled" }
                    : {
                          status: "failed",
                          error: `The runner stopped responding (nothing heard for over ${LEASE_SECONDS} seconds), so the review was abandoned. Start it again.`,
                      },
                { lost: true },
            ).catch((err: unknown) => {
                if (!(err instanceof ApiError && err.status === 409)) throw err;
            });
        }
        return lost.length;
    }

    // ---- finishing -------------------------------------------------------------------------------

    /**
     * Record how a run ended, all in one transaction: the report uploaded to its branch (for a finished
     * review), the review history, the job itself and an activity row. GitHub hears about it afterwards.
     */
    private async conclude(jobId: string, runnerId: string | null, input: FinishInput, opts: { lost?: boolean } = {}): Promise<Job | null> {
        const known = await this.store.jobs.get(jobId);
        const redact = known ? await this.redactionsFor(known) : CLEAN_ONLY;
        const clean = (s: string | null | undefined) => (s ? redact(String(s)).slice(0, 2000) : null);
        const sha = (s: unknown) => (typeof s === "string" && /^[0-9a-f]{40}$/i.test(s) ? s.toLowerCase() : null);
        // Every string in a report is redacted before anything reads it: it's stored, and parts of it
        // (warnings, file names) are posted on GitHub. OCR writes "comments": null when it found nothing.
        const readReport = (given: unknown): RawReport | null => {
            const raw = redactDeep(given, redact);
            const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as RawReport) : null;
            return obj && (Array.isArray(obj.comments) || obj.comments === null || obj.comments === undefined)
                ? { ...obj, comments: obj.comments ?? [] }
                : null;
        };
        let report: RawReport | null = null;
        let metrics: ReturnType<typeof reportMetrics> | null = null;
        let gaps: ReturnType<typeof reviewGaps> = null;
        let unreadable: string | null = null;
        // A run with several models: each model's own outcome (in the job's order), and one merged report.
        const listed = known?.model?.models && known.model.models.length > 1 ? known.model.models : null;
        let parts: Part[] | null = null;
        let judged: JudgeResult | null = null;
        try {
            if (listed) {
                parts = listed.map((m, i) => {
                    const given = Array.isArray(input.parts) ? input.parts[i] : undefined;
                    // A failed model's report (if any) still says what it used; only a finished one's findings count.
                    let sent: RawReport | null = null;
                    let error = clean(given?.error);
                    try {
                        sent = given?.report === undefined ? null : readReport(given.report);
                    } catch (err) {
                        error = `Its report couldn't be read: ${clean((err as Error).message)}`;
                    }
                    const own = given?.status === "done" ? sent : null;
                    if (given?.status === "done" && !own) error ??= "It finished without a report.";
                    const partMetrics = sent ? reportMetrics(sent) : null;
                    const status: Part["status"] = own
                        ? reviewGaps(own)
                            ? "partial"
                            : "done"
                        : given?.status === "cancelled"
                          ? "cancelled"
                          : "failed";
                    const time = Number(given?.seconds);
                    // As for a run with one model: an instance-key model that never said what it used is charged
                    // its whole budget, unless the runner reported and it never had its turn.
                    const said = runTokens(partMetrics?.tokens ?? null, given?.tokens);
                    const whole = m.keySource === "instance" && m.budget ? m.budget : 0;
                    const estimated = !said && whole > 0 && (given !== undefined || !Array.isArray(input.parts));
                    return {
                        ...m,
                        status,
                        reason: own ? null : stopReason(given?.reason, error),
                        report: own,
                        metrics: partMetrics,
                        tokens: estimated ? { input: whole, output: 0, cacheRead: 0, total: whole } : said,
                        estimated,
                        seconds: Number.isFinite(time) && time >= 0 ? Math.round(time) : null,
                        error: own ? null : (error ?? (given ? "It failed." : "It didn't run.")),
                    };
                });
                if (parts.some((p) => p.report)) {
                    const reports = parts.map((p): ModelReport => ({ label: p.label, report: p.report, error: p.error }));
                    // The review chose to have a model asked which findings are the same problem: what it said, if it can be used.
                    const judge = known?.model?.judge;
                    let same: FindingPair[] = [];
                    if (judge) {
                        const who = "error" in judge ? null : judge;
                        const read =
                            "error" in judge
                                ? {
                                      ...readJudged({ pairs: [] }, reports),
                                      error: `No model was asked: ${judge.error}. Findings were merged by where they are only.`,
                                  }
                                : readJudged(input.judged, reports, redact);
                        same = read.same;
                        const byPlace = groupFindings(findingsOf(reports));
                        judged = {
                            label: who?.label ?? null,
                            provider: who?.provider ?? null,
                            model: who?.model ?? null,
                            candidates: read.candidates,
                            asked: read.asked,
                            same: same.length,
                            merged: byPlace.length - joinGroups(byPlace, same).length,
                            tokens: read.tokens,
                            seconds: read.seconds,
                            error: read.error,
                        };
                    }
                    report = mergeReports(reports, same);
                    // Kept with the report: triage lists such findings after the others, wherever it's read.
                    if (known?.options?.agreement.markSingles) report.mark_singles = true;
                    metrics = reportMetrics(report);
                    gaps = reviewGaps(report);
                } else unreadable = `No model finished: ${parts.map((p) => `${p.label}: ${p.error}`).join(" ")}`.slice(0, 2000);
            } else {
                report = readReport(input.report);
                metrics = report ? reportMetrics(report) : null;
                gaps = report ? reviewGaps(report) : null;
            }
        } catch (err) {
            report = null;
            unreadable = `The runner sent a report that couldn't be read: ${clean((err as Error).message)}`;
        }

        const record = (status: Exclude<JobStatus, "queued" | "running">, error: string | null, upload: boolean) =>
            this.core.write(REVIEWER, async (w) => {
                const held = await w.tx.jobs.get(jobId);
                if (held?.status !== "running" || (runnerId !== null && held.runnerId !== runnerId))
                    throw new ApiError(409, "This job isn't running on this runner any more.", { code: "job_lost" });
                // A lease renewed since the sweep looked at it isn't lost after all.
                if (opts.lost && held.leaseExpiresAt && Date.parse(held.leaseExpiresAt) >= Date.now()) return null;
                const cancelled = status === "cancelled" || (status === "failed" && held.cancelRequested !== null && !upload);
                const final: JobStatus = cancelled ? "cancelled" : status;
                const project = await w.tx.projects.get(held.projectId);
                const workspace = await w.tx.workspaces.get(held.workspaceId);
                const automation = project ? await this.settings.automation(w.tx, project) : null;
                const headSha = sha(input.headSha) ?? held.headSha;
                const baseSha = sha(input.baseSha) ?? held.baseSha;
                const finishedAt = now();
                // Every instance-key run counts against the allowance: with no figure at all (stopped, cancelled
                // or lost without a word from OCR), the whole budget it was given, marked as an estimate.
                // Several models: what they used between them (the merged report's own figure is the first model's).
                let tokens = parts
                    ? sumTokens([...parts.map((p) => p.tokens), judged?.tokens ?? null])
                    : runTokens(metrics?.tokens ?? null, held.progress.tokens);
                const estimated = !parts && !tokens && held.model?.keySource === "instance" && Boolean(held.model.budget);
                if (estimated) {
                    const b = held.model?.budget as number;
                    tokens = { input: b, output: 0, cacheRead: 0, total: b };
                }
                let counts: { added: number; carriedOver: number; removed: number; reopened: number } | undefined;
                let addedIds: Partial<Record<Severity, string[]>> | undefined;
                // The branch report this run made, so a model of it run again later can tell it's still there.
                let reportId: string | null = null;
                // One model run again: its findings join the report its review made, rather than replacing it.
                const original = held.rerunOf ? await w.tx.jobs.get(held.rerunOf.jobId) : null;
                let rerun: RerunResult | null = null;
                let bakeOff: BakeOff | null = null;
                if (held.rerunOf) {
                    const of = held.rerunOf;
                    rerun = {
                        of: of.jobId,
                        index: of.index,
                        label: of.label,
                        attempt: of.attempt,
                        auto: of.auto,
                        added: null,
                        agreed: null,
                        notAdded: null,
                    };
                    if (upload && project && report) {
                        const made = await this.addRerun(held, original, project, report, headSha);
                        rerun = { ...rerun, ...made.rerun };
                        addedIds = made.addedIds;
                    }
                } else if (upload && report && parts && held.options?.bakeOff) {
                    // Only comparing: nothing goes to the branch. What each model found is kept with the run instead.
                    bakeOff = compareModels(
                        parts.map((p) => ({ ...p, finished: p.report !== null })),
                        report,
                    );
                } else if (upload && project && report) {
                    // Findings this review reported first (for analytics' finding ages): those not on the branch before it.
                    const before = await this.reports.view(w.tx, project, held.branch).catch(() => null);
                    const out = await this.reports.upload(REVIEWER, project, {
                        branch: held.branch,
                        commit: headSha,
                        fileName:
                            held.kind === "pr"
                                ? `PR #${held.pr?.number}`
                                : held.kind === "changes"
                                  ? `Changes since ${held.baseRef}`
                                  : `Full scan ${finishedAt.slice(0, 10)}`,
                        report,
                        confirm: true,
                        reopen: true,
                        scope: held.kind === "full" ? "full" : "diff",
                    });
                    reportId = (out.current as { upload?: { id?: string } | null }).upload?.id ?? null;
                    counts = {
                        added: out.added,
                        carriedOver: out.carriedOver,
                        removed: out.removed,
                        reopened: (out as { reopened?: number }).reopened ?? 0,
                    };
                    addedIds = {};
                    let kept = 0;
                    for (const x of (await this.reports.view(w.tx, project, held.branch)).review.issues) {
                        if (before?.review.byId.has(x.id) || kept++ >= MAX_ADDED_IDS) continue;
                        const list = addedIds[x.severity] ?? [];
                        list.push(x.id);
                        addedIds[x.severity] = list;
                    }
                }
                const errorText =
                    final === "cancelled"
                        ? held.cancelRequested
                            ? `Cancelled by ${held.cancelRequested.by}.`
                            : (error ?? "Cancelled.")
                        : error;
                const common = {
                    ...(held.pr ? { prNumber: held.pr.number } : {}),
                    commit: headSha,
                    requestedBy: held.source === "automation" ? "automation" : held.requestedBy.name,
                    queuedAt: held.queuedAt,
                    ...(held.startedAt ? { startedAt: held.startedAt } : {}),
                    queueSeconds: seconds(held.queuedAt, held.startedAt) ?? 0,
                };
                const failAt = held.options?.agreement.failAt ?? null;
                const result = {
                    total: metrics?.findings.total ?? null,
                    bySeverity: metrics?.findings.bySeverity ?? null,
                    gaps: final === "partial" ? gaps : null,
                    counts: counts ?? null,
                    tokens,
                    ...(estimated || parts?.some((p) => p.estimated) ? { estimatedTokens: true } : {}),
                    filesReviewed: metrics?.files?.reviewed ?? null,
                    ocrVersion: metrics?.ocrVersion ?? null,
                    seconds: seconds(held.startedAt, finishedAt) ?? null,
                    ...(upload && report && failAt ? { agreement: agreedCritical(report, failAt) } : {}),
                    ...(reportId ? { reportId } : {}),
                    ...(rerun ? { rerun } : {}),
                    ...(judged ? { judge: judged } : {}),
                    ...(bakeOff ? { bakeOff } : {}),
                    ...(parts
                        ? {
                              models: parts.map((p) => ({
                                  label: p.label,
                                  provider: p.provider,
                                  model: p.model,
                                  status: p.status,
                                  total: p.report ? (p.metrics?.findings.total ?? null) : null,
                                  tokens: p.tokens?.total ?? null,
                                  seconds: p.seconds,
                                  error: p.error,
                                  reason: p.reason,
                              })),
                          }
                        : {}),
                };
                const { current: _c, round: _r, ...progress } = held.progress;
                const next: Job = {
                    ...held,
                    status: final,
                    headSha,
                    baseSha,
                    finishedAt,
                    leaseExpiresAt: null,
                    credentials: null,
                    error: errorText,
                    result,
                    progress: { ...progress, phase: final === "done" || final === "partial" ? "finished" : final },
                };
                await w.tx.jobs.put(next);
                // Asked to: each model that failed or went quiet is run once more by itself. Not one stopped for
                // passing its token budget (it would only pass it again), and never from a model run again.
                let pointing = next;
                if (parts && reportId && project && held.options?.retryFailed)
                    for (const [i, p] of parts.entries())
                        if (p.status === "failed" && p.reason !== "overBudget" && p.id)
                            pointing = (
                                await this.queueRerun(w, pointing, project, i, {
                                    requestedBy: held.requestedBy,
                                    source: held.source,
                                    auto: true,
                                })
                            ).job;
                if (held.startedAt && !parts)
                    await this.history.record(w.tx, {
                        workspaceId: held.workspaceId,
                        projectId: held.projectId,
                        branch: held.branch,
                        at: finishedAt,
                        source: "run",
                        kind: held.kind,
                        status: final as "done" | "partial" | "failed" | "cancelled",
                        model: held.model?.model ?? null,
                        provider: held.model?.provider ?? null,
                        keySource: held.model?.keySource ?? null,
                        tokens,
                        details: {
                            ...(estimated ? { estimatedTokens: true } : {}),
                            ...common,
                            ocrVersion: metrics?.ocrVersion ?? null,
                            runSeconds: seconds(held.startedAt, finishedAt) ?? 0,
                            ...(metrics ? { findings: metrics.findings } : {}),
                            ...(counts ? { counts } : {}),
                            files: { ...(metrics?.files ?? {}), failedGroups: gaps?.groups ?? metrics?.files?.failedGroups ?? 0 },
                            ...(metrics?.toolCalls ? { toolCalls: metrics.toolCalls } : {}),
                            ...(metrics?.llm ? { llm: metrics.llm } : {}),
                            ...(addedIds ? { addedIds } : {}),
                            error: errorText,
                            // A model run again counts under the review it belongs to: one scan, with this as another attempt.
                            ...(held.rerunOf && original
                                ? {
                                      attempt: held.rerunOf.attempt,
                                      scan: {
                                          id: original.id,
                                          models: original.model?.models?.map((m) => m.label) ?? [held.rerunOf.label],
                                          lead: false,
                                          status: original.status as "done" | "partial",
                                          findings: typeof original.result?.total === "number" ? original.result.total : null,
                                      },
                                  }
                                : {}),
                        },
                    });
                // Several models: a record each (for comparing them), grouped by the scan; the lead carries the branch's changes.
                if (held.startedAt && parts) {
                    const scan = {
                        id: held.id,
                        models: parts.map((p) => p.label),
                        status: final as "done" | "partial" | "failed" | "cancelled",
                        findings: metrics?.findings.total ?? null,
                    };
                    for (const [i, p] of parts.entries())
                        await this.history.record(w.tx, {
                            workspaceId: held.workspaceId,
                            projectId: held.projectId,
                            branch: held.branch,
                            at: finishedAt,
                            source: "run",
                            kind: held.kind,
                            status: final === "cancelled" && p.status === "failed" ? "cancelled" : p.status,
                            model: p.model,
                            provider: p.provider,
                            keySource: p.keySource ?? "workspace",
                            tokens: p.tokens,
                            details: {
                                ...(p.estimated ? { estimatedTokens: true } : {}),
                                ...common,
                                ocrVersion: p.metrics?.ocrVersion ?? null,
                                runSeconds: p.seconds ?? 0,
                                ...(p.report && p.metrics ? { findings: p.metrics.findings } : {}),
                                ...(i === 0 && counts ? { counts } : {}),
                                files: { ...(p.metrics?.files ?? {}), failedGroups: p.metrics?.files?.failedGroups ?? 0 },
                                ...(p.metrics?.toolCalls ? { toolCalls: p.metrics.toolCalls } : {}),
                                ...(p.metrics?.llm ? { llm: p.metrics.llm } : {}),
                                ...(i === 0 && addedIds ? { addedIds } : {}),
                                error: p.error ?? (i === 0 ? errorText : null),
                                ...(held.options?.bakeOff ? { bakeOff: true } : {}),
                                scan: { ...scan, lead: i === 0 },
                            },
                        });
                    // The model that was asked about the findings: its tokens are the scan's too, counted as merging.
                    if (judged?.model && (judged.tokens || judged.asked))
                        await this.history.record(w.tx, {
                            workspaceId: held.workspaceId,
                            projectId: held.projectId,
                            branch: held.branch,
                            at: finishedAt,
                            source: "run",
                            kind: held.kind,
                            status: judged.error ? "failed" : "done",
                            model: judged.model,
                            provider: judged.provider,
                            keySource: "workspace",
                            tokens: judged.tokens,
                            details: {
                                ...common,
                                merging: true,
                                ...(judged.seconds !== null ? { runSeconds: judged.seconds } : {}),
                                error: judged.error,
                                scan: { ...scan, lead: false },
                            },
                        });
                }
                await w.activity(
                    {
                        workspaceId: held.workspaceId,
                        projectId: held.projectId,
                        branch: held.branch,
                        kind: "run",
                        itemId: held.id,
                        changes: {
                            finished: {
                                title: held.title,
                                status: final,
                                total: metrics?.findings.total ?? null,
                                critical: metrics?.findings.bySeverity.critical ?? 0,
                                requestedBy: held.requestedBy.userId,
                                ...(errorText ? { error: errorText.slice(0, 300) } : {}),
                            },
                        },
                    },
                    project?.slug ?? null,
                );
                // The job's own GitHub token goes with it, however it ended.
                const revoke = this.credentialsOf(held)?.revoke ?? null;
                w.afterCommit(() => {
                    this.revoke(next, revoke);
                    this.afterFinish(pointing, project, workspace, automation?.failOnCritical ?? true);
                });
                return pointing;
            });

        if (input.status === "done") {
            if (!report) return record("failed", unreadable ?? "The runner finished without a report.", false);
            try {
                return await record(gaps ? "partial" : "done", null, true);
            } catch (err) {
                if (err instanceof ApiError && err.code === "job_lost") throw err;
                return this.recordOrFail(
                    () =>
                        record("failed", `The review finished, but its report couldn't be saved: ${clean((err as Error).message)}`, false),
                    jobId,
                );
            }
        }
        return this.recordOrFail(
            () => record(input.status === "cancelled" ? "cancelled" : "failed", clean(input.error) ?? "The review failed.", false),
            jobId,
        );
    }

    /**
     * Add the findings of a model run again to the report its review made, if that's still the branch's
     * report and this is the commit it was of. Otherwise nothing changes, and the answer says why.
     */
    private async addRerun(held: Job, original: Job | null, project: Project, report: RawReport, headSha: string | null) {
        const of = held.rerunOf as NonNullable<Job["rerunOf"]>;
        const notAdded = (why: string) => ({ rerun: { added: null, agreed: null, notAdded: why }, addedIds: undefined });
        const short = (s: string | null | undefined) => (s ?? "an unknown commit").slice(0, 7);
        if (!original?.headSha || headSha !== original.headSha)
            return notAdded(
                `It reviewed ${short(headSha)}, not ${short(original?.headSha)}, the commit the review was of, so its findings weren't added to the report. The runner may be too old to review an earlier commit: update it, then run the model again.`,
            );
        const out = of.reportId
            ? await this.reports.addModelFindings(REVIEWER, project, {
                  branch: held.branch,
                  uploadId: of.reportId,
                  label: of.label,
                  report,
              })
            : null;
        if (!out)
            return notAdded(
                `A newer report has replaced the review's on ${held.branch}, so these findings weren't added to it. Start a new review to have ${of.label}'s findings there.`,
            );
        const addedIds: Partial<Record<Severity, string[]>> = {};
        for (const x of out.addedIssues.slice(0, MAX_ADDED_IDS)) addedIds[x.severity] = [...(addedIds[x.severity] ?? []), x.id];
        const whole = reportMetrics(out.report);
        const failAt = original.options?.agreement.failAt ?? null;
        const branch: NonNullable<RerunResult["branch"]> = {
            total: whole.findings.total,
            bySeverity: whole.findings.bySeverity,
            gaps: reviewGaps(out.report),
            models: Array.isArray(out.report.models) ? (out.report.models as string[]) : [],
            ...(failAt ? { agreement: agreedCritical(out.report, failAt) } : {}),
        };
        return { rerun: { added: out.added, agreed: out.agreed, notAdded: null, branch }, addedIds };
    }

    /**
     * Record how a run ended; if even that fails (something in what the runner sent that the rest can't
     * cope with), end the job anyway, so it never stays running with its credentials.
     */
    private async recordOrFail(record: () => Promise<Job | null>, jobId: string): Promise<Job | null> {
        try {
            return await record();
        } catch (err) {
            if (err instanceof ApiError && err.code === "job_lost") throw err;
            console.error(`Recording how run ${jobId} ended failed: ${(err as Error).message}`);
            const ended = await this.store.transaction(async (tx) => {
                const held = await tx.jobs.get(jobId);
                if (held?.status !== "running") return null;
                const next: Job = {
                    ...held,
                    status: "failed",
                    finishedAt: now(),
                    leaseExpiresAt: null,
                    credentials: null,
                    error: "The review ended, but how it ended couldn't be recorded. See the server log.",
                };
                await tx.jobs.put(next);
                const revoke = this.credentialsOf(held)?.revoke ?? null;
                const project = await tx.projects.get(held.projectId);
                const workspace = await tx.workspaces.get(held.workspaceId);
                // Finished like any other run (so its pull request isn't left pending); failOnCritical only matters for a review that's done.
                this.store.afterCommit(() => {
                    this.revoke(next, revoke);
                    this.afterFinish(next, project, workspace, true);
                });
                return next;
            });
            return ended;
        }
    }

    runUrl(workspace: Pick<Workspace, "slug"> | null, project: Project, job: Pick<Job, "id">): string | null {
        if (!workspace) return null;
        return `${this.core.config.publicOrigin}/w/${encodeURIComponent(workspace.slug)}/p/${encodeURIComponent(project.slug)}/runs/${encodeURIComponent(job.id)}`;
    }

    private issuesUrl(workspace: Pick<Workspace, "slug">, project: Project, branch: string, id?: string): string {
        const base = `${this.core.config.publicOrigin}/w/${encodeURIComponent(workspace.slug)}/p/${encodeURIComponent(project.slug)}/issues`;
        return `${base}${id ? `/${encodeURIComponent(id)}` : ""}?branch=${encodeURIComponent(branch)}`;
    }

    private afterFinish(job: Job, project: Project | null, workspace: Workspace | null, failOnCritical: boolean): void {
        this.redactions.delete(job.id);
        const sent = this.progressSent.get(job.id);
        if (sent?.timer) clearTimeout(sent.timer);
        this.progressSent.delete(job.id);
        this.announce(job, project, "finished");
        this.finishedBeside(job, project);
        if (!project) return;
        // A model run again reports only once its findings are in the review's report: the check and comment are then that report's.
        // A comparison never does: it has nothing to say about the pull request.
        const reports = job.rerunOf ? Boolean((job.result?.rerun as RerunResult | undefined)?.branch) : !job.options?.bakeOff;
        if (job.kind === "pr" && job.pr && job.headSha && workspace && reports)
            this.background(`Reporting ${job.title} to GitHub`, () => this.tellGithub(job, project, workspace, failOnCritical));
        if (onTheSide(job)) return;
        try {
            this.onFinished(job, project);
        } catch (err) {
            console.error(`After ${job.title} finished: ${(err as Error).message}`);
        }
    }

    /** The pull request's commit status, and (for a finished review) its comment. */
    private async tellGithub(job: Job, project: Project, workspace: Workspace, failOnCritical: boolean): Promise<void> {
        const sha = job.headSha as string;
        const notes: string[] = [];
        // Only the repository this review was of: if the project points elsewhere now, say so and stop.
        const current = await this.github.maybeFor(project).catch(() => null);
        if (current && !sameRepository(job.repository, current.repo)) {
            const why = `this project now uses ${current.repo.fullName}, and this review was of ${job.repository?.fullName}`;
            await this.store.jobs.appendLog(job.id, [{ at: now(), line: `[triagent] Not reporting to GitHub: ${why}.` }], LOG_CAP_BYTES);
            await this.store.transaction(async (tx) => {
                const latest = await tx.jobs.get(job.id);
                if (latest) await tx.jobs.put({ ...latest, result: { ...(latest.result ?? {}), github: [`not reported: ${why}`] } });
            });
            return;
        }
        const note = async (what: string, task: () => Promise<unknown>) => {
            try {
                await task();
                notes.push(`${what}: done`);
            } catch (err) {
                const message = (err as Error).message;
                notes.push(`${what}: failed (${message})`);
                await this.store.jobs.appendLog(
                    job.id,
                    [{ at: now(), line: CLEAN_ONLY(`[triagent] Couldn't update the pull request (${what}): ${message}`) }],
                    LOG_CAP_BYTES,
                );
            }
        };
        if (job.status === "done" || job.status === "partial") {
            // A model run again: the whole report, with its findings in, is what's reported.
            const whole = (job.result?.rerun as RerunResult | undefined)?.branch ?? null;
            const bySeverity = (whole?.bySeverity ?? job.result?.bySeverity ?? { critical: 0, high: 0, medium: 0, low: 0 }) as Record<
                Severity,
                number
            >;
            const total = Number(whole?.total ?? job.result?.total ?? 0);
            const agreed = (whole ? whole.agreement : (job.result?.agreement as Agreed | undefined)) ?? null;
            const gaps = whole ? whole.gaps : ((job.result?.gaps as ReturnType<typeof reviewGaps>) ?? null);
            const status = finishedStatus({
                status: whole ? (gaps ? "partial" : "done") : job.status,
                total,
                bySeverity,
                failOnCritical,
                agreed,
            });
            const view = await this.reports.view(this.store, project, job.branch).catch(() => null);
            const urgent = view
                ? view.filter(
                      parseFilters(
                          { severity: "critical,high", status: "open,in_progress", sort: "priority" },
                          { maxLimit: 50, defaultLimit: 50 },
                      ),
                  )
                : [];
            await note("commit status", () =>
                this.github.setStatus(
                    project,
                    sha,
                    status.state,
                    status.description,
                    this.issuesUrl(workspace, project, job.branch),
                    job.repository,
                ),
            );
            await note("comment", () =>
                this.github.upsertComment(
                    project,
                    job.pr?.number as number,
                    commentBody({
                        marker: COMMENT_MARKER,
                        total,
                        bySeverity,
                        urgent,
                        gaps,
                        models: whole?.models ?? job.model?.models?.map((m) => m.label) ?? null,
                        failOnCritical,
                        agreed,
                        commit: sha,
                        issuesUrl: this.issuesUrl(workspace, project, job.branch),
                        issueUrl: (id) => this.issuesUrl(workspace, project, job.branch, id),
                        pullRequestsUrl: `${this.core.config.publicOrigin}/w/${encodeURIComponent(workspace.slug)}/p/${encodeURIComponent(project.slug)}/pull-requests`,
                    }),
                    job.repository,
                ),
            );
        } else {
            const state: CommitState = "error";
            // Commit statuses are public: the runner's error (paths, OCR's output) stays in Triagent.
            const description = job.status === "cancelled" ? "Review cancelled" : "Review failed — see Triagent for details";
            await note("commit status", () =>
                this.github.setStatus(project, sha, state, description, this.runUrl(workspace, project, job), job.repository),
            );
        }
        await this.store.transaction(async (tx) => {
            const current = await tx.jobs.get(job.id);
            if (current) await tx.jobs.put({ ...current, result: { ...(current.result ?? {}), github: notes } });
        });
    }

    private announce(job: Job, project: Pick<Project, "slug"> | null, what: "queued" | "started" | "progress" | "finished"): void {
        this.core.events.announce({
            workspace: job.workspaceId,
            project: project?.slug ?? null,
            branch: job.branch,
            kind: "run",
            id: job.id,
            fields: [what],
        });
    }
}

export type RunView = View;
