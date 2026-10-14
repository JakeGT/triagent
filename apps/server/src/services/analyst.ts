// Asking a model to write about reviews and findings: a comparison of a review's models, a summary of
// what a review changed, an answer to a question about the analytics. A workspace picks the model
// (Settings → Analysis): one of its favourites, with its own key. Nothing is asked until it has.
//
// The server makes the request itself (packages/shared/src/ask.ts), as it does for a provider's list of
// models: there's no checkout involved, and a question shouldn't wait for a runner. A URL someone typed
// in is checked again before each one (services/model-urls.ts). The model is sent figures the server
// worked out and findings' titles and places, never code (domain/analyst.ts).
//
// Each asking is a row (`analyses`): running, then done with what was written, or failed saying why. It
// happens in the background, and the page asks again until it's there. What it took in tokens is kept
// with it, and analytics count it apart from reviews.

import type { Severity } from "@triagent/shared";
import { askModel, type Said, whyNot } from "@triagent/shared/ask";
import { log } from "@triagent/shared/log";
import { canBeAsked, modelSecrets } from "@triagent/shared/model";
import { redactor } from "@triagent/shared/redact";
import {
    ANSWER_SYSTEM,
    type AskContext,
    agreementOf,
    answerQuestion,
    COMPARISON_SYSTEM,
    type ComparisonFigures,
    comparisonQuestion,
    describeLookup,
    disagreementExamples,
    type ListedFinding,
    type Lookup,
    type LookupResult,
    MAX_QUESTION,
    PLAN_SYSTEM,
    planQuestion,
    readPlan,
    SUMMARY_SYSTEM,
    type SummaryFigures,
    summaryQuestion,
    thinData,
    written,
} from "../domain/analyst.ts";
import { type AnalyticsDays, costOf, folderOf } from "../domain/analytics.ts";
import type { BakeOff } from "../domain/bake-off.ts";
import { disagreements } from "../domain/disagreements.ts";
import { parseFilters } from "../domain/filters.ts";
import { type Issue, parseReport, priorityCompare } from "../domain/report.ts";
import { ApiError, badRequest, conflict, notFound } from "../errors.ts";
import { logFailure } from "../failure.ts";
import { analyticsText } from "../mcp/analytics-tool.ts";
import { now, randomId } from "../security.ts";
import type { Analysis, AnalysisKind, Job, Project, Repos, Workspace } from "../store/types.ts";
import type { AnalyticsService } from "./analytics.ts";
import type { Actor, Core } from "./core.ts";
import type { ModelSetup, ResolvedModel } from "./model-setup.ts";
import type { Prices } from "./prices.ts";
import type { Projects } from "./projects.ts";
import type { Reports } from "./reports.ts";
import type { Runs } from "./runs.ts";

const KEY = "analysis";
/** One request to the model: these are short pieces of writing, but some models think first. */
const TIMEOUT_MS = 120_000;
/** A row still "running" after this long was left by a server that stopped: it's shown as failed. */
const STALE_MS = 10 * 60_000;
/** How many a workspace may ask for in an hour: enough for anyone working, not for a loop. */
export const MAX_PER_HOUR = 40;
const EXAMPLES = 8;

const ZERO = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0 });

export interface AnalysisSettings {
    /** The favourite model that's asked; null until one is chosen. */
    model: string | null;
    /** Written without being asked, when a review finishes. */
    afterReview: { comparison: boolean; summary: boolean };
}

const DEFAULTS: AnalysisSettings = { model: null, afterReview: { comparison: false, summary: false } };

export interface AnalystOptions {
    fetch?: typeof fetch | undefined;
    now?: (() => number) | undefined;
    timeoutMs?: number | undefined;
}

type Ready = { ready: true; model: ResolvedModel; id: string; label: string } | { ready: false; reason: string };

/** What a piece of work is given to ask with: each call is one request, and its tokens are added up. */
export type Ask = (system: string, user: string) => Promise<string>;

const listed = (x: Pick<Issue, "severity" | "category" | "path" | "title">): ListedFinding => ({
    severity: x.severity,
    category: x.category,
    file: x.path,
    title: x.title.slice(0, 200),
});

export class Analyst {
    private readonly core: Core;
    private readonly setup: ModelSetup;
    private readonly runs: Runs;
    private readonly reports: Reports;
    private readonly analytics: AnalyticsService;
    private readonly prices: Prices;
    private readonly projects: Projects;
    private readonly options: AnalystOptions;
    private readonly pending = new Set<Promise<unknown>>();

    constructor(
        core: Core,
        setup: ModelSetup,
        runs: Runs,
        reports: Reports,
        analytics: AnalyticsService,
        prices: Prices,
        projects: Projects,
        options: AnalystOptions = {},
    ) {
        this.core = core;
        this.setup = setup;
        this.runs = runs;
        this.reports = reports;
        this.analytics = analytics;
        this.prices = prices;
        this.projects = projects;
        this.options = options;
    }

    private get store() {
        return this.core.store;
    }

    private clock(): number {
        return this.options.now?.() ?? Date.now();
    }

    /** Wait for what's being written to finish (tests, shutdown). */
    async settled(): Promise<void> {
        while (this.pending.size) await Promise.allSettled([...this.pending]);
    }

    // ---- settings ----------------------------------------------------------------------------------

    async settings(repos: Repos, workspace: Workspace): Promise<AnalysisSettings> {
        const value = (await repos.settings.get(workspace.id, null, KEY))?.value as Partial<AnalysisSettings> | undefined;
        return {
            model: typeof value?.model === "string" ? value.model : null,
            afterReview: { ...DEFAULTS.afterReview, ...(value?.afterReview ?? {}) },
        };
    }

    /** Whether there's a model to ask now, and if not, why: what pages show beside what could be asked for. */
    async model(workspace: Workspace): Promise<{ ready: true; label: string } | { ready: false; reason: string }> {
        const chosen = await this.chosen(this.store, workspace);
        return chosen.ready ? { ready: true, label: chosen.label } : { ready: false, reason: chosen.reason };
    }

    /** The model that would be asked now, with its key, or why nothing can be. Reveals a secret: never return it. */
    private async chosen(repos: Repos, workspace: Workspace): Promise<Ready> {
        const { model } = await this.settings(repos, workspace);
        if (!model) return { ready: false, reason: "No model is chosen for analysis yet. An admin can choose one in Settings → Analysis." };
        const r = await this.setup.resolveFavourite(repos, workspace, model);
        if (!r)
            return {
                ready: false,
                reason: "The model chosen for analysis has been removed from the workspace's models. An admin can choose another in Settings → Analysis.",
            };
        const label = r.favourite.name ?? r.favourite.model;
        if (!r.ready) return { ready: false, reason: `${label} needs ${r.missing} in Settings → Models before it can be asked.` };
        if (!canBeAsked(r.model.protocol))
            return {
                ready: false,
                reason: `${label} is on Amazon Bedrock, where a model can't be asked. Choose another in Settings → Analysis.`,
            };
        return { ready: true, model: r.model, id: r.favourite.id, label };
    }

    /** Settings → Analysis: what's chosen, whether it can be asked now, and what could be chosen. */
    async view(workspace: Workspace) {
        const settings = await this.settings(this.store, workspace);
        const chosen = await this.chosen(this.store, workspace);
        const { favourites } = await this.setup.favourites(this.store, { kind: "workspace", workspace });
        const since = new Date(this.clock() - 3_600_000).toISOString();
        const lastHour = (await this.store.analyses.list({ workspaceId: workspace.id, since }, MAX_PER_HOUR + 1)).length;
        return {
            ...settings,
            ready: chosen.ready,
            /** Why nothing can be asked now. */
            reason: chosen.ready ? null : chosen.reason,
            label: chosen.ready ? chosen.label : null,
            models: favourites.map((f) => ({
                id: f.id,
                name: f.name ?? f.model,
                model: f.model,
                providerName: f.providerName,
                ready: f.ready,
                missing: f.missing,
                canBeAsked: f.canJudge,
            })),
            limit: { perHour: MAX_PER_HOUR, lastHour },
        };
    }

    async save(
        actor: Actor,
        workspace: Workspace,
        input: { model?: string | null; afterReview?: Partial<AnalysisSettings["afterReview"]> },
    ) {
        await this.core.write(actor, async (w) => {
            const before = await this.settings(w.tx, workspace);
            const next: AnalysisSettings = {
                model: input.model === undefined ? before.model : input.model,
                afterReview: { ...before.afterReview, ...(input.afterReview ?? {}) },
            };
            if (next.model && next.model !== before.model) {
                // Whether or not it has its key yet: one that isn't ready is saved, and says what it needs.
                const { favourites } = await this.setup.favourites(w.tx, { kind: "workspace", workspace });
                const favourite = favourites.find((f) => f.id === next.model);
                if (!favourite) throw badRequest("That isn't one of this workspace's models. Add it in Settings → Models first.");
                if (!favourite.canJudge)
                    throw badRequest(
                        "A model on Amazon Bedrock can't be asked: only Open Code Review knows how to sign its requests. Choose another.",
                    );
            }
            await w.tx.settings.put({ workspaceId: workspace.id, projectId: null, key: KEY, value: next });
            const changes: Record<string, unknown> = {};
            if (next.model !== before.model) changes.model = { from: before.model, to: next.model };
            for (const k of ["comparison", "summary"] as const)
                if (next.afterReview[k] !== before.afterReview[k]) changes[k] = { from: before.afterReview[k], to: next.afterReview[k] };
            if (Object.keys(changes).length) await w.audit({ workspaceId: workspace.id, kind: "settings", target: "analysis", changes });
        });
        return this.view(workspace);
    }

    // ---- asking ------------------------------------------------------------------------------------

    /** A row as it stands: one left "running" by a server that stopped is failed, saying so. */
    private async settle(a: Analysis): Promise<Analysis> {
        if (a.status !== "running" || this.clock() - Date.parse(a.createdAt) < STALE_MS) return a;
        const failed: Analysis = { ...a, status: "failed", finishedAt: now(), error: "It was interrupted before it finished. Ask again." };
        await this.store.analyses.put(failed);
        return failed;
    }

    async latest(workspace: Workspace, kind: AnalysisKind, subject: string): Promise<Analysis | null> {
        const [a] = await this.store.analyses.list({ workspaceId: workspace.id, kind, subject }, 1);
        return a ? this.settle(a) : null;
    }

    /** One analysis, for the page that's waiting on it. */
    async get(workspace: Workspace, id: string): Promise<Analysis> {
        const a = /^[\w-]{1,40}$/.test(id) ? await this.store.analyses.get(id) : null;
        if (!a || a.workspaceId !== workspace.id) throw notFound("No such analysis in this workspace.");
        return this.settle(a);
    }

    /**
     * Start a piece of writing: a row that's running, and `work` going on in the background until the row
     * is done or failed. Throws 409 when no model can be asked, saying why, and 429 past the hour's limit.
     */
    async begin(
        actor: Actor,
        workspace: Workspace,
        what: Pick<Analysis, "kind" | "projectId" | "branch" | "subject" | "input">,
        work: (ask: Ask) => Promise<Record<string, unknown>>,
    ): Promise<Analysis> {
        const chosen = await this.chosen(this.store, workspace);
        if (!chosen.ready) throw conflict(chosen.reason, { code: "no_analysis_model" });
        const since = new Date(this.clock() - 3_600_000).toISOString();
        const recent = await this.store.analyses.list({ workspaceId: workspace.id, since }, MAX_PER_HOUR + 1);
        if (recent.length >= MAX_PER_HOUR)
            throw new ApiError(
                429,
                `This workspace has asked for ${MAX_PER_HOUR} analyses in the last hour, which is the limit. Try again later.`,
            );
        const row: Analysis = {
            id: randomId(),
            workspaceId: workspace.id,
            ...what,
            status: "running",
            requestedBy: { name: actor.name, userId: actor.userId },
            model: { id: chosen.id, provider: chosen.model.provider, model: chosen.model.model, label: chosen.label },
            tokens: null,
            result: null,
            error: null,
            createdAt: new Date(this.clock()).toISOString(),
            finishedAt: null,
        };
        await this.store.analyses.put(row);

        const tokens = { input: 0, output: 0, total: 0 };
        const clean = redactor(modelSecrets(chosen.model));
        let checked = false;
        const ask: Ask = async (system, user) => {
            // A URL someone typed in may resolve somewhere else by now.
            if (!checked) {
                const unsafe = await this.setup.recheck(chosen.model);
                if (unsafe) throw new Error(unsafe);
                checked = true;
            }
            const said: Said = await askModel(chosen.model, {
                system,
                user,
                timeoutMs: this.options.timeoutMs ?? TIMEOUT_MS,
                fetch: this.options.fetch,
            });
            tokens.input += said.input;
            tokens.output += said.output;
            tokens.total = tokens.input + tokens.output;
            if (!said.text.trim()) throw new Error("it answered with nothing");
            return said.text;
        };
        const task = (async () => {
            let end: Pick<Analysis, "status" | "result" | "error">;
            try {
                end = { status: "done", result: await work(ask), error: null };
            } catch (err) {
                const why = clean(whyNot(err)).slice(0, 500);
                // The provider, the network or the model's answer: it happens. A fault of ours is worth knowing about.
                if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError)
                    logFailure("Writing an analysis failed", err, { analysis: row.id, kind: row.kind });
                else log.warn("A model couldn't be asked for an analysis", { analysis: row.id, kind: row.kind, reason: why });
                end = { status: "failed", result: null, error: `${chosen.label} couldn't write it: ${why}.` };
            }
            await this.store.analyses.put({ ...row, ...end, tokens: tokens.total ? { ...tokens } : null, finishedAt: now() });
        })()
            .catch((err: unknown) => logFailure("Couldn't save an analysis", err, { analysis: row.id }))
            .finally(() => this.pending.delete(task));
        this.pending.add(task);
        return row;
    }

    // ---- a review's models compared, and what it changed -------------------------------------------

    private async job(workspace: Workspace, id: string): Promise<Job> {
        const job = /^[\w-]{1,40}$/.test(id) ? await this.store.jobs.get(id) : null;
        if (!job || job.workspaceId !== workspace.id) throw notFound("No such review in this workspace.");
        return job;
    }

    /** Why a review can't have each thing written about it, or null when it can. */
    private eligible(job: Job): { comparison: string | null; summary: string | null } {
        const finished = job.status === "done" || job.status === "partial";
        const models = ((job.result?.models as { total: number | null }[] | undefined) ?? []).filter((m) => m.total !== null).length;
        const unfinished = "The review hasn't finished with findings.";
        return {
            comparison: !finished ? unfinished : models < 2 ? "A comparison needs a review two or more models finished." : null,
            summary: !finished
                ? unfinished
                : job.rerunOf || job.options?.bakeOff
                  ? "This run didn't replace a branch's report, so it changed nothing to summarise."
                  : !job.result?.reportId
                    ? "This review's report wasn't kept."
                    : null,
        };
    }

    /** What's been written about a review, and what could be. */
    async forRun(workspace: Workspace, runId: string) {
        const job = await this.job(workspace, runId);
        const can = this.eligible(job);
        const chosen = await this.chosen(this.store, workspace);
        return {
            comparison: await this.latest(workspace, "comparison", job.id),
            summary: await this.latest(workspace, "summary", job.id),
            /** Why each can't be written for this review; null when it can. */
            unavailable: can,
            model: chosen.ready ? { ready: true as const, label: chosen.label } : { ready: false as const, reason: chosen.reason },
        };
    }

    /** The latest of each for a branch: its newest finished review's. */
    async forBranch(workspace: Workspace, project: Project, branch: string) {
        const jobs = (
            await this.store.jobs.list({ workspaceId: workspace.id, projectId: project.id, statuses: ["done", "partial"] }, 200)
        ).filter((j) => j.branch === branch);
        const summarised = jobs.find((j) => this.eligible(j).summary === null) ?? null;
        const compared = jobs.find((j) => this.eligible(j).comparison === null) ?? null;
        const chosen = await this.chosen(this.store, workspace);
        const run = (j: Job | null) => (j ? { id: j.id, title: j.title, finishedAt: j.finishedAt } : null);
        return {
            branch,
            summary: { run: run(summarised), analysis: summarised ? await this.latest(workspace, "summary", summarised.id) : null },
            comparison: { run: run(compared), analysis: compared ? await this.latest(workspace, "comparison", compared.id) : null },
            model: chosen.ready ? { ready: true as const, label: chosen.label } : { ready: false as const, reason: chosen.reason },
        };
    }

    /** Still being written for this review: asking again gives the same one. */
    private async inHand(workspace: Workspace, kind: AnalysisKind, subject: string): Promise<Analysis | null> {
        const a = await this.latest(workspace, kind, subject);
        return a?.status === "running" ? a : null;
    }

    async writeComparison(actor: Actor, workspace: Workspace, runId: string): Promise<Analysis> {
        const job = await this.job(workspace, runId);
        const why = this.eligible(job).comparison;
        if (why) throw conflict(why);
        const running = await this.inHand(workspace, "comparison", job.id);
        if (running) return running;
        const figures = await this.comparisonFigures(workspace, job);
        return this.begin(
            actor,
            workspace,
            { kind: "comparison", projectId: job.projectId, branch: job.branch, subject: job.id, input: null },
            async (ask) => ({
                markdown: written(await ask(COMPARISON_SYSTEM, comparisonQuestion(figures))),
                /** Whether it had the findings to go on, or only each model's figures. */
                withFindings: figures.agreement !== null,
            }),
        );
    }

    private async comparisonFigures(workspace: Workspace, job: Job): Promise<ComparisonFigures> {
        const breakdown = await this.runs.breakdown(workspace, job.id);
        const price = await this.prices.resolver(workspace.id);
        const project = await this.store.projects.get(job.projectId);
        // The findings themselves: the branch's report if it's still this review's, or what a comparison run kept.
        let findings: Pick<Issue, "severity" | "category" | "path" | "title" | "foundBy" | "index">[] = [];
        let disagreed: ReturnType<typeof disagreements> | null = null;
        const stored = project ? await this.store.reports.get(project.id, job.branch) : null;
        if (project && stored && job.result?.reportId && stored.upload.id === job.result.reportId) {
            const view = await this.reports.viewStored(this.store, project, stored);
            findings = [...view.review.issues];
            disagreed = disagreements(view.review.issues, view.review.meta.models);
        } else if (job.result?.bakeOff) {
            const made = job.result.bakeOff as BakeOff;
            findings = made.findings.map((f, i) => ({
                severity: f.severity,
                category: (f.category as Issue["category"]) ?? "other",
                path: f.path,
                title: f.title,
                foundBy: f.foundBy,
                index: i,
            }));
        }
        const have = findings.length > 0;
        const ran = breakdown.models.filter((m) => m.findings !== null).length;
        const agreement = have ? agreementOf(findings, ran) : null;
        const sorted = [...findings].sort(priorityCompare);
        return {
            review: job.title,
            kind: job.kind,
            findings: typeof job.result?.total === "number" ? job.result.total : null,
            agreement: agreement?.all ?? null,
            seriousAgreement: agreement?.serious ?? null,
            models: breakdown.models.map((m) => {
                const mine = sorted.filter((x) => x.foundBy?.includes(m.label));
                const byCategory: ComparisonFigures["models"][number]["byCategory"] = {};
                for (const x of mine) byCategory[x.category] = (byCategory[x.category] ?? 0) + 1;
                const bySeverity = ZERO();
                for (const x of mine) bySeverity[x.severity]++;
                return {
                    name: m.label,
                    status: m.status,
                    findings: m.findings,
                    onlyItFound: m.unique ?? (have ? mine.filter((x) => x.foundBy?.length === 1).length : null),
                    bySeverity: m.bySeverity ?? (have ? bySeverity : null),
                    byCategory: have ? byCategory : null,
                    seconds: m.seconds,
                    tokens: m.tokensTotal,
                    cost: costOf(m.tokens, price(m.model, m.provider)),
                    onlyItFoundExamples: mine
                        .filter((x) => x.foundBy?.length === 1)
                        .slice(0, EXAMPLES)
                        .map(listed),
                };
            }),
            ratedDifferently: disagreed?.rated.total ?? 0,
            nearButNotMerged: disagreed?.apart.total ?? 0,
            ...(disagreed ? disagreementExamples(disagreed) : { ratedDifferentlyExamples: [], nearButNotMergedExamples: [] }),
        };
    }

    async writeSummary(actor: Actor, workspace: Workspace, runId: string): Promise<Analysis> {
        const job = await this.job(workspace, runId);
        const why = this.eligible(job).summary;
        if (why) throw conflict(why);
        const running = await this.inHand(workspace, "summary", job.id);
        if (running) return running;
        const figures = await this.summaryFigures(job);
        return this.begin(
            actor,
            workspace,
            { kind: "summary", projectId: job.projectId, branch: job.branch, subject: job.id, input: null },
            async (ask) => ({
                markdown: written(await ask(SUMMARY_SYSTEM, summaryQuestion(figures))),
                ...(figures.first
                    ? {
                          warning:
                              "This is the first review of this branch, so there's nothing to compare it with: this describes what it found.",
                      }
                    : {}),
                figures: {
                    first: figures.first,
                    newFindings: figures.newFindings,
                    noLongerReported: figures.noLongerReported,
                    reopened: figures.reopened,
                },
            }),
        );
    }

    /** What a review changed on its branch: its report against the one it replaced. */
    private async summaryFigures(job: Job): Promise<SummaryFigures> {
        const project = await this.store.projects.get(job.projectId);
        const stored = project ? await this.store.reports.get(project.id, job.branch) : null;
        if (!project || !stored || stored.upload.id !== job.result?.reportId)
            throw conflict(
                "A later review has replaced this one's report, so what it changed can no longer be worked out. Summarise the latest review.",
            );
        const view = await this.reports.viewStored(this.store, project, stored);
        const now_ = view.review.issues;
        // The report it replaced: the newest one archived for the branch.
        const before = (await this.store.reports.archived(project.id, job.branch)).filter((a) => a.reason === "replaced").at(-1) ?? null;
        const was = before ? parseReport(before.report, before.upload).issues : [];
        const wasIds = new Set(was.map((x) => x.id));
        const nowIds = new Set(now_.map((x) => x.id));
        const added = now_.filter((x) => !wasIds.has(x.id)).sort(priorityCompare);
        const gone = was.filter((x) => !nowIds.has(x.id)).sort(priorityCompare);
        const done = new Set(
            (before?.triage ?? [])
                .filter((t) => t.kind === "issue" && (t.status === "resolved" || t.status === "wont_fix"))
                .map((t) => t.itemId),
        );
        const count = (list: readonly Issue[]) => {
            const c = ZERO();
            for (const x of list) c[x.severity]++;
            return c;
        };
        const folders = new Map<string, number>();
        for (const x of added) folders.set(folderOf(x.path), (folders.get(folderOf(x.path)) ?? 0) + 1);
        const counts = job.result?.counts as { reopened?: number } | null | undefined;
        return {
            review: job.title,
            scope: stored.upload.scope,
            first: !before,
            findingsNow: now_.length,
            bySeverityNow: count(now_),
            newFindings: added.length,
            newBySeverity: count(added),
            noLongerReported: gone.length,
            stillReported: now_.length - added.length,
            reopened: counts?.reopened ?? 0,
            noLongerReportedAndDone: gone.filter((x) => done.has(x.id)).length,
            newExamples: added.slice(0, 20).map(listed),
            noLongerReportedExamples: gone.slice(0, 12).map(listed),
            newByFolder: [...folders]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([folder, findings]) => ({ folder, findings })),
        };
    }

    /**
     * A review has finished: write what the workspace asked to have written without being asked. Never
     * throws, and never more than the settings say: a workspace that chose nothing is asked nothing.
     */
    reviewFinished(job: Job): void {
        const task = (async () => {
            const workspace = await this.store.workspaces.get(job.workspaceId);
            if (!workspace) return;
            const { afterReview } = await this.settings(this.store, workspace);
            const can = this.eligible(job);
            const actor: Actor = { name: "automation", userId: null, via: "system" };
            for (const [on, why, write] of [
                [afterReview.summary, can.summary, () => this.writeSummary(actor, workspace, job.id)],
                [afterReview.comparison, can.comparison, () => this.writeComparison(actor, workspace, job.id)],
            ] as const) {
                if (!on || why) continue;
                await write().catch((err: unknown) =>
                    // No model chosen, or over the hour's limit: said on the page when someone asks. Anything else is ours.
                    err instanceof ApiError
                        ? log.info("Nothing was written about a finished review", { run: job.id, reason: err.message })
                        : logFailure("Couldn't start writing about a finished review", err, { run: job.id }),
                );
            }
        })()
            .catch((err: unknown) => logFailure("Couldn't look at a finished review for analysis", err, { run: job.id }))
            .finally(() => this.pending.delete(task));
        this.pending.add(task);
    }

    // ---- a question --------------------------------------------------------------------------------

    async ask(
        actor: Actor,
        workspace: Workspace,
        input: { question: string; project?: string | undefined; branch?: string | undefined; days?: AnalyticsDays | undefined },
    ): Promise<Analysis> {
        const question = input.question.replace(/\s+/g, " ").trim();
        if (question.length < 3) throw badRequest("Ask a question.");
        if (question.length > MAX_QUESTION) throw badRequest(`Keep the question under ${MAX_QUESTION} characters.`);
        const days = input.days ?? 30;
        // An unknown project is a 404 here, before anything is asked.
        const data = await this.analytics.compute(workspace, { project: input.project, branch: input.branch, days });
        const all = await this.store.projects.forWorkspace(workspace.id);
        const scope = `${data.scope.project ?? "every project"}, ${data.scope.branch ? `branch ${data.scope.branch}` : "all branches"}, ${days ? `the last ${days} days` : "all time"}`;
        const ctx: AskContext = {
            question,
            today: new Date(this.clock()).toISOString().slice(0, 10),
            scope,
            analytics: analyticsText(data),
            projects: all.map((p) => ({ slug: p.slug, name: p.name, defaultBranch: p.defaultBranch })),
            models: [...new Set((data.models?.rows ?? []).flatMap((r) => [r.labels[0] ?? r.key]))].slice(0, 20),
        };
        const warning = thinData(data.reviews?.total ?? 0, (data.findings?.open ?? 0) + (data.findings?.closed ?? 0));
        const project = input.project ? (all.find((p) => p.slug === input.project) ?? null) : null;
        return this.begin(
            actor,
            workspace,
            {
                kind: "answer",
                projectId: project?.id ?? null,
                branch: input.branch ?? null,
                subject: "",
                input: { question, project: input.project ?? null, branch: input.branch ?? null, days },
            },
            async (ask) => {
                const plan = readPlan(
                    await ask(PLAN_SYSTEM, planQuestion(ctx)),
                    all.map((p) => p.slug),
                );
                if (!plan) throw new Error("its answer wasn't one that could be read");
                let markdown: string;
                let looked: LookupResult[] = [];
                if ("answer" in plan) markdown = written(plan.answer);
                else {
                    looked = [];
                    for (const l of plan.lookups) looked.push(await this.lookup(workspace, all, l));
                    markdown = written(await ask(ANSWER_SYSTEM, answerQuestion(ctx, looked)));
                }
                return {
                    markdown,
                    scope,
                    ...(warning ? { warning } : {}),
                    /** What it looked at beyond the analytics: each a view of an issues list the page can link to. */
                    lookups: looked.map((r) => ({
                        ...r.lookup,
                        label: describeLookup(r.lookup),
                        total: r.total,
                        ...(r.error ? { error: r.error } : {}),
                    })),
                };
            },
        );
    }

    /** One look at an issues list, as the asker's workspace sees it. */
    private async lookup(workspace: Workspace, projects: readonly Project[], l: Lookup): Promise<LookupResult> {
        const project = projects.find((p) => p.slug === l.project && p.workspaceId === workspace.id);
        if (!project) return { lookup: l, error: "No such project.", total: 0, findings: [] };
        try {
            const view = await this.reports.view(this.store, project, l.branch ?? project.defaultBranch);
            const { project: _p, branch: _b, ...filters } = l;
            const all = view.filter(parseFilters({ ...filters, limit: 500 }));
            const counts = view.counts(all);
            const some = <K extends string>(c: Record<K, number>) =>
                Object.fromEntries(Object.entries(c).filter(([, n]) => (n as number) > 0)) as Partial<Record<K, number>>;
            return {
                lookup: l,
                total: all.length,
                bySeverity: counts.severity,
                byCategory: some(counts.category),
                byStatus: counts.status,
                findings: all.slice(0, 25).map((x) => ({
                    ...listed(x),
                    status: view.statusOf("issue", x.id),
                    foundBy: x.foundBy ? [...x.foundBy] : null,
                })),
            };
        } catch (err) {
            if (err instanceof ApiError) return { lookup: l, error: err.message.slice(0, 200), total: 0, findings: [] };
            throw err;
        }
    }
}
