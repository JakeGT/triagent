// Review runs. A run is a job in the store: queued, claimed by a runner (a separate process with no
// database, over /internal/runner), kept alive by its lease, and finished by uploading the report.
//
// Scheduling is fair between workspaces: the workspace whose last run started longest ago goes first,
// oldest job first within it, under an instance-wide cap and a per-workspace cap. A job only starts
// when its workspace's review model is ready (`models.forRun`). A runner that stops renewing its lease
// loses the job, which is marked failed, saying so.

import { setTimeout as sleep } from "node:timers/promises";
import type { Severity } from "@triagent/shared";
import { modelSecrets, type RunnerModel } from "@triagent/shared/model";
import { redactDeep, redactor } from "@triagent/shared/redact";
import { parseFilters } from "../domain/filters.ts";
import { type ModelReport, mergeReports } from "../domain/merge.ts";
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
    type Workspace,
} from "../store/types.ts";
import type { Actor, Core } from "./core.ts";
import type { CommitState, Pull } from "./github/client.ts";
import { COMMENT_MARKER, type Github, NotConnected, RepositoryChanged, sameRepository } from "./github/service.ts";
import type { History } from "./history.ts";
import type { Models, RunModel } from "./models.ts";
import type { Reports } from "./reports.ts";
import type { Settings } from "./settings.ts";

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
    slots: number;
}

/** How one model's review went, in a run with several (in the order the job gave them). */
export interface FinishPart {
    status: "done" | "failed" | "cancelled";
    report?: unknown;
    error?: string | null;
    /** The most tokens OCR said it used while running. */
    tokens?: number | null;
    seconds?: number | null;
}

export interface FinishInput {
    status: "done" | "failed" | "cancelled";
    report?: unknown;
    /** A run with several models: how each went. `report` is unused then; the server merges these. */
    parts?: FinishPart[];
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
    timeoutMinutes: number;
    maxTokensBudget: number | null;
    /** The protocol OCR speaks to the model and this job's credentials for it: the first of `models`. */
    model: RunnerModel;
    /** Every model to review with, in order, each with how people know it. One, unless the project lists several. */
    models: (RunnerModel & { label: string })[];
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

/** Only what the progress view shows, bounded, its text redacted like the log. */
function cleanProgress(input: unknown, clean: (text: string) => string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!input || typeof input !== "object") return out;
    for (const [k, v] of Object.entries(input)) {
        if (!PROGRESS_KEYS.has(k)) continue;
        if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.max(0, Math.min(v, 1e9));
        else if (typeof v === "string") out[k] = clean(v.slice(0, 1000)).slice(0, 200);
    }
    return out;
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
    provider: string;
    model: string;
    label: string;
    status: "done" | "partial" | "failed" | "cancelled";
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
    /** Redacting functions by job, so a log batch doesn't decrypt the job's secrets each time. */
    private readonly redactions = new Map<string, (text: string) => string>();
    private readonly progressSent = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> | null }>();
    /** Runners heard from recently, so their record isn't written on every poll. */
    private readonly runnerSeen = new Map<string, number>();
    /** Background work (GitHub statuses and comments) still going, so tests and shutdown can wait for it. */
    private readonly pending = new Set<Promise<unknown>>();
    /** Called once a run has finished and its report is saved (automation refreshes the branch's status). */
    onFinished: (job: Job, project: Project) => void = () => {};

    constructor(core: Core, github: Github, reports: Reports, history: History, models: Models, settings: Settings) {
        this.core = core;
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
            progress: job.progress,
            result: job.result,
            error: job.error,
            model: job.model,
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

    /** Whether reviews in the workspace (in one project, if given: it may list its own models) can start now, and if not, why. */
    async readiness(workspace: Workspace, project?: Project): Promise<{ ready: boolean; reason: string | null }> {
        const model = project
            ? await this.models.forProject(workspace, await this.settings.automation(this.store, project))
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
        const active = (await this.store.jobs.active()).filter((j) => j.workspaceId === workspace.id);
        const only = filter.projectId ? projects.get(filter.projectId) : undefined;
        const readiness = await this.readiness(workspace, only);
        // Each queued review waits on its own project's models.
        const reasons = new Map<string, string | null>();
        for (const j of active) {
            const p = projects.get(j.projectId);
            if (j.status !== "queued" || reasons.has(j.projectId) || !p) continue;
            reasons.set(j.projectId, (await this.readiness(workspace, p)).reason);
        }
        const cfg = this.core.config;
        const allRunning = (await this.store.jobs.active()).filter((j) => j.status === "running").length;
        const wsRunning = active.filter((j) => j.status === "running").length;
        const busy =
            wsRunning >= cfg.reviewConcurrencyPerWorkspace
                ? "Waiting for this workspace's running review to finish."
                : allRunning >= cfg.reviewConcurrency
                  ? "Waiting for a free slot: the instance is running as many reviews as it allows."
                  : "Waiting for a runner to pick it up.";
        const mine = (j: Job) => !filter.projectId || j.projectId === filter.projectId;
        const runners = await this.connectedRunners();
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
            concurrency: { instance: cfg.reviewConcurrency, workspace: cfg.reviewConcurrencyPerWorkspace },
            runnersConnected: runners.length,
            runners: filter.runnerDetails
                ? runners.map((r) => ({ name: r.name, slots: r.slots, version: r.version, lastSeenAt: r.lastSeenAt }))
                : [],
            running: active.filter((j) => j.status === "running" && mine(j)).map((j) => this.view(j, projects.get(j.projectId) ?? null)),
            queued: active
                .filter((j) => j.status === "queued" && mine(j))
                .map((j) => this.view(j, projects.get(j.projectId) ?? null, reasons.get(j.projectId) ?? busy)),
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
            logLines: lines,
            next: lines.at(-1)?.seq ?? Math.max(after, job.logDropped),
        };
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
        const job = await this.enqueue(actor, project, spec);
        return this.view(job, project);
    }

    /**
     * Queue a review. A queued job for the same thing is replaced; one already queued or running for the
     * same commit is returned instead of queueing another.
     */
    async enqueue(actor: Actor, project: Project, spec: JobSpec): Promise<Job> {
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
        if (created.isNew && created.job.kind === "pr" && created.job.headSha) {
            const job = created.job;
            this.background(`Marking ${job.title} as queued on GitHub`, async () => {
                const workspace = await this.store.workspaces.get(project.workspaceId);
                const ready = workspace ? await this.readiness(workspace, project) : { ready: false, reason: null };
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
                    if (project) this.onFinished(next, project);
                    if (next.kind === "pr" && next.headSha && project)
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
        await this.store.runners.seen({
            id: r.id,
            name: CLEAN_ONLY(r.name),
            version: r.version === null ? null : CLEAN_ONLY(r.version),
            slots: r.slots,
            lastSeenAt: now(),
        });
    }

    /** Hand a runner the next job it may start, or null. */
    async claim(runner: RunnerHello): Promise<ClaimedJob | null> {
        await this.noteRunner(runner);
        if (!runner.slots) return null;
        await this.sweep();
        const cfg = this.core.config;
        const picked = await this.store.transaction(async (tx) => {
            const active = await tx.jobs.active();
            const running = active.filter((j) => j.status === "running");
            if (running.length >= cfg.reviewConcurrency) return null;
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
                if ((runningIn.get(workspaceId) ?? 0) >= cfg.reviewConcurrencyPerWorkspace) continue;
                const workspace = await tx.workspaces.get(workspaceId);
                if (!workspace) continue;
                for (const job of queuedIn.get(workspaceId) ?? []) {
                    const project = await tx.projects.get(job.projectId);
                    if (!project) continue;
                    // Which models depends on the project; a job whose models aren't ready waits (the list says why).
                    const automation = await this.settings.automation(tx, project);
                    const chosen = await this.models.forProject(workspace, automation, tx);
                    if (!chosen.ready) continue;
                    const model = chosen.models[0] as RunModel;
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
                        this.store.afterCommit(() => this.announce(failed, project, "finished"));
                        continue;
                    }
                    // With the instance key, this comes out of what's left of the allowance until the run ends.
                    const maxTokensBudget = budget(automation.maxTokensBudget, model.allowance?.remaining ?? null);
                    const started: Job = {
                        ...job,
                        status: "running",
                        startedAt: now(),
                        runnerId: runner.id,
                        leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000).toISOString(),
                        model: {
                            provider: model.provider,
                            model: model.model,
                            keySource: model.keySource,
                            budget: maxTokensBudget,
                            ...(chosen.models.length > 1
                                ? { models: chosen.models.map((m) => ({ provider: m.provider, model: m.model, label: m.label })) }
                                : {}),
                        },
                        progress: { phase: "starting" },
                    };
                    await tx.jobs.put(started);
                    return { job: started, project, workspace, models: chosen.models, automation, maxTokensBudget };
                }
            }
            return null;
        });
        if (!picked) return null;
        const { job, project, workspace, models, automation, maxTokensBudget } = picked;

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
        const scope = { workspaceId: job.workspaceId, projectId: job.projectId };
        const credentials: JobCredentials = { secrets: [token, ...models.flatMap((m) => modelSecrets(m))], revoke: revoke ? token : null };
        const sealed = this.core.secrets.seal(JSON.stringify(credentials), scope, `job:${job.id}`);
        const stillOurs = await this.store.transaction(async (tx) => {
            const current = await tx.jobs.get(job.id);
            if (current?.status !== "running" || current.runnerId !== runner.id) return false;
            await tx.jobs.put({ ...current, credentials: sealed });
            return true;
        });
        if (!stillOurs) {
            this.revoke(job, credentials.revoke);
            return null;
        }
        this.redactions.set(job.id, redactor(credentials.secrets));
        this.announce(job, project, "started");
        if (job.kind === "pr" && job.headSha)
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
            maxTokensBudget,
            model: forRunner(models[0] as RunModel),
            models: models.map((m) => ({ ...forRunner(m), label: m.label })),
        };
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

    async heartbeat(runner: RunnerHello, jobId: string): Promise<{ cancel: boolean; leaseExpiresAt: string }> {
        await this.noteRunner(runner);
        const job = await this.store.transaction(async (tx) => {
            const next = this.renewed(await this.held(tx, runner.id, jobId));
            await tx.jobs.put(next);
            return next;
        });
        return { cancel: Boolean(job.cancelRequested), leaseExpiresAt: job.leaseExpiresAt as string };
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
    async events(runner: RunnerHello, jobId: string, input: { lines?: { at?: string; line: string }[]; progress?: unknown }) {
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
        return { cancel: Boolean(job.cancelRequested) };
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
                    return {
                        ...m,
                        status,
                        report: own,
                        metrics: partMetrics,
                        tokens: runTokens(partMetrics?.tokens ?? null, given?.tokens),
                        seconds: Number.isFinite(time) && time >= 0 ? Math.round(time) : null,
                        error: own ? null : (error ?? (given ? "It failed." : "It didn't run.")),
                    };
                });
                if (parts.some((p) => p.report)) {
                    report = mergeReports(parts.map((p): ModelReport => ({ label: p.label, report: p.report, error: p.error })));
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
                let tokens = parts ? sumTokens(parts.map((p) => p.tokens)) : runTokens(metrics?.tokens ?? null, held.progress.tokens);
                const estimated = !tokens && held.model?.keySource === "instance" && Boolean(held.model.budget);
                if (estimated) {
                    const b = held.model?.budget as number;
                    tokens = { input: b, output: 0, cacheRead: 0, total: b };
                }
                let counts: { added: number; carriedOver: number; removed: number; reopened: number } | undefined;
                let addedIds: Partial<Record<Severity, string[]>> | undefined;
                if (upload && project && report) {
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
                const result = {
                    total: metrics?.findings.total ?? null,
                    bySeverity: metrics?.findings.bySeverity ?? null,
                    gaps: final === "partial" ? gaps : null,
                    counts: counts ?? null,
                    tokens,
                    ...(estimated ? { estimatedTokens: true } : {}),
                    filesReviewed: metrics?.files?.reviewed ?? null,
                    ocrVersion: metrics?.ocrVersion ?? null,
                    seconds: seconds(held.startedAt, finishedAt) ?? null,
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
                            keySource: "workspace",
                            tokens: p.tokens,
                            details: {
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
                                scan: { ...scan, lead: i === 0 },
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
                    this.afterFinish(next, project, workspace, automation?.failOnCritical ?? true);
                });
                return next;
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
                this.store.afterCommit(() => {
                    this.revoke(next, revoke);
                    this.redactions.delete(next.id);
                    this.announce(next, null, "finished");
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
        if (!project) return;
        if (job.kind === "pr" && job.pr && job.headSha && workspace)
            this.background(`Reporting ${job.title} to GitHub`, () => this.tellGithub(job, project, workspace, failOnCritical));
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
            const bySeverity = (job.result?.bySeverity ?? { critical: 0, high: 0, medium: 0, low: 0 }) as Record<Severity, number>;
            const total = Number(job.result?.total ?? 0);
            const status = finishedStatus({ status: job.status, total, bySeverity, failOnCritical });
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
                        gaps: (job.result?.gaps as never) ?? null,
                        models: job.model?.models?.map((m) => m.label) ?? null,
                        failOnCritical,
                        commit: sha,
                        issuesUrl: this.issuesUrl(workspace, project, job.branch),
                        issueUrl: (id) => this.issuesUrl(workspace, project, job.branch, id),
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
