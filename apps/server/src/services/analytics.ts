// Gathers what analytics needs (review history, the activity log and the current reports for the
// projects and branch in scope) with bounded reads, and hands it to domain/analytics.ts.

import {
    type AnalyticsDays,
    type AnalyticsResult,
    type AnalyticsSection,
    analyse,
    type CurrentFinding,
    costOf,
    rangeStart,
} from "../domain/analytics.ts";
import type { ActivityRow, Project, Workspace } from "../store/types.ts";
import type { Core } from "./core.ts";
import type { Prices } from "./prices.ts";
import type { Projects } from "./projects.ts";
import type { Reports } from "./reports.ts";

/** Upper bounds on what one request reads (`current`: findings in the current reports); past them the answer says it's partial. */
export const LIMITS = { history: 20_000, activity: 50_000, current: 200_000, sources: 200_000, page: 1000 };

export interface AnalyticsScope {
    project?: string | undefined;
    branch?: string | undefined;
    days: AnalyticsDays;
    /** Only these parts (each tab of the page asks for its own): the rest isn't read or worked out. */
    sections?: readonly AnalyticsSection[] | undefined;
}

export type Analytics = AnalyticsResult & {
    scope: { project: string | null; branch: string | null; projects: { slug: string; name: string }[] };
    /**
     * Reads that hit their limit: the figures leave out the oldest history and activity rows, and
     * (`current`) the findings of the branches not reached.
     */
    truncated: { history: boolean; activity: boolean; current: boolean; sources: boolean };
    /**
     * With the reviews part: what a model was asked to write in the range (services/analyst.ts), apart from
     * the reviews' own figures: how many were written, and the tokens of all that were asked for (one that
     * failed still used some). `cost` is null when none of it has a price; `unpricedTokens` are left out of
     * it. `truncated`: there were more than were read, so these are the most recent only.
     */
    analysis?: { count: number; tokens: number; cost: number | null; unpricedTokens: number; truncated: boolean };
};

export class AnalyticsService {
    private readonly core: Core;
    private readonly projects: Projects;
    private readonly reports: Reports;
    private readonly prices: Prices;
    private readonly clock: () => number;

    constructor(core: Core, projects: Projects, reports: Reports, prices: Prices, clock: () => number = Date.now) {
        this.core = core;
        this.projects = projects;
        this.reports = reports;
        this.prices = prices;
        this.clock = clock;
    }

    async compute(workspace: Workspace, scope: AnalyticsScope): Promise<Analytics> {
        const store = this.core.store;
        const now = this.clock();
        const all = await store.projects.forWorkspace(workspace.id);
        const inScope: Project[] = scope.project ? [await this.projects.get(store, workspace, scope.project)] : all;
        const projectId = scope.project ? inScope[0]?.id : undefined;
        const branch = scope.branch || null;

        const sections = scope.sections?.length ? new Set(scope.sections) : null;
        const wants = (...parts: AnalyticsSection[]) => !sections || parts.some((s) => sections.has(s));

        const history = await store.reviewHistory.list({ workspaceId: workspace.id, ...(projectId ? { projectId } : {}) }, LIMITS.history);

        // The activity log, newest first, back to the start of the range.
        const since = rangeStart(scope.days, now);
        const activity: ActivityRow[] = [];
        let truncatedActivity = false;
        const filter = { workspaceId: workspace.id, ...(projectId ? { projectId } : {}), ...(branch ? { branch } : {}) };
        // Only the parts about findings and triage read the activity log, and only the findings part the reports.
        for (let before: string | undefined; wants("findings", "triage"); ) {
            const page = await store.activity.list(filter, { limit: LIMITS.page, ...(before ? { before } : {}) });
            let reachedStart = false;
            for (const row of page) {
                if (since !== null && Date.parse(row.at) < since) {
                    reachedStart = true;
                    break;
                }
                activity.push(row);
            }
            if (reachedStart || page.length < LIMITS.page) break;
            if (activity.length >= LIMITS.activity) {
                truncatedActivity = true;
                break;
            }
            before = page.at(-1)?.id;
        }

        // What's open now, from the current reports of the branches in scope.
        const current: CurrentFinding[] = [];
        let truncatedCurrent = false;
        gather: for (const project of wants("findings", "triage") ? inScope : []) {
            const stored = branch
                ? [await store.reports.get(project.id, branch)].filter((s) => s !== null)
                : await store.reports.branches(project.id);
            for (const s of stored) {
                // Enough already: the reports left aren't read at all.
                if (current.length >= LIMITS.current) {
                    truncatedCurrent = true;
                    break gather;
                }
                const view = await this.reports.viewStored(store, project, s);
                for (const x of view.issues()) {
                    if (current.length >= LIMITS.current) {
                        truncatedCurrent = true;
                        break gather;
                    }
                    const record = view.record("issue", x.id);
                    current.push({
                        projectId: project.id,
                        branch: s.branch,
                        id: x.id,
                        path: x.path,
                        severity: x.severity,
                        category: x.category,
                        status: record?.status ?? "open",
                        assignee: record?.assignee ?? null,
                        needsDiscussion: Boolean(record?.needsDiscussion),
                    });
                }
            }
        }

        // Who found what, for the scope.
        const sources = wants("models")
            ? await store.findingSources.list(
                  { workspaceId: workspace.id, ...(projectId ? { projectId } : {}), ...(branch ? { branch } : {}) },
                  LIMITS.sources,
              )
            : [];

        const slugs = new Map(all.map((p) => [p.id, p.slug]));
        const price = await this.prices.resolver(workspace.id);
        // What analyses took, for the scope's project (a question about every project belongs to none).
        const analysis = { count: 0, tokens: 0, cost: null as number | null, unpricedTokens: 0, truncated: false };
        if (wants("reviews")) {
            const asked = await store.analyses.list(
                {
                    workspaceId: workspace.id,
                    ...(projectId ? { projectId } : {}),
                    ...(since !== null ? { since: new Date(since).toISOString() } : {}),
                },
                LIMITS.page * 5,
            );
            analysis.truncated = asked.length >= LIMITS.page * 5;
            for (const a of asked) {
                if (branch && a.branch !== branch) continue;
                if (a.status === "done") analysis.count++;
                if (!a.tokens?.total) continue;
                analysis.tokens += a.tokens.total;
                const c = costOf(
                    { input: a.tokens.input, output: a.tokens.output, cacheRead: 0, total: a.tokens.total },
                    a.model ? price(a.model.model) : null,
                );
                if (c === null) analysis.unpricedTokens += a.tokens.total;
                else analysis.cost = (analysis.cost ?? 0) + c;
            }
        }
        const result = analyse({
            now,
            days: scope.days,
            branch,
            history,
            activity,
            current,
            sources,
            ...(sections ? { sections } : {}),
            price,
            projectSlug: (id) => (id ? (slugs.get(id) ?? null) : null),
        });
        return {
            ...result,
            ...(wants("reviews") ? { analysis } : {}),
            scope: {
                project: scope.project ? (inScope[0]?.slug ?? null) : null,
                branch,
                projects: all.map((p) => ({ slug: p.slug, name: p.name })),
            },
            truncated: {
                history: history.length >= LIMITS.history,
                activity: truncatedActivity,
                current: truncatedCurrent,
                sources: sources.length >= LIMITS.sources,
            },
        };
    }
}
