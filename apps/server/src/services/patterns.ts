// Common issues: the kinds of problem reviews keep finding in a project, each with what goes wrong and
// how to avoid it. People and agents read them before writing code there (the MCP tool
// `list_common_issues`, and an issue says which one it's under); the Issues page filters by one, so a
// whole kind of problem can be worked through, or dismissed, together.
//
// The workspace's analysis model (services/analyst.ts) groups a branch's open findings: under the common
// issues there already are where they fit, under new ones where several share a cause. It's asked about
// the findings nothing is under yet, so asking again after a review only costs what that review added.
// People can edit, hide, merge, delete and add them.
//
// And likely false positives: the open findings a model thinks the team would dismiss, going by what it
// has dismissed before and why. Suggestions only: nothing is closed.

import { CATEGORIES, type Category, SEVERITIES, type Severity } from "@triagent/shared";
import type { BranchView, EffectiveIssue } from "../domain/branch.ts";
import type { IssueFilters } from "../domain/filters.ts";
import { cleanText } from "../domain/names.ts";
import {
    type DismissedExample,
    FALSE_POSITIVE_BATCH,
    FALSE_POSITIVE_MAX,
    FALSE_POSITIVE_SYSTEM,
    FEW_DISMISSED,
    falsePositiveQuestion,
    GROUP_BATCH,
    GROUP_MAX,
    GROUP_SYSTEM,
    groupQuestion,
    MAX_DISMISSED_SHOWN,
    MAX_GUIDANCE,
    MAX_SUMMARY,
    MAX_TITLE,
    readGroups,
    readLikely,
    thinGrouping,
    thinHistory,
} from "../domain/patterns.ts";
import { priorityCompare, severityWeight } from "../domain/report.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { now, randomId } from "../security.ts";
import type { Analysis, Pattern, PatternFinding, Project, Workspace } from "../store/types.ts";
import type { Analyst } from "./analyst.ts";
import type { Actor, Core } from "./core.ts";
import type { Reports } from "./reports.ts";

export const MAX_PATTERNS = 200;

const zero = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0 });

export interface PatternInput {
    title?: string | undefined;
    summary?: string | undefined;
    guidance?: string | undefined;
    category?: Category | null | undefined;
    hidden?: boolean | undefined;
}

/** A common issue as pages and agents see it: with what's under it on a branch now. */
export interface PatternView extends Pattern {
    /** Its findings on this branch that are still reported and still open, and all it has had on any branch. */
    open: number;
    total: number;
    openBySeverity: Record<Severity, number>;
    /** Where its open findings are, the most first. */
    files: { path: string; open: number }[];
    /** A few of its open findings, the most urgent first. */
    examples: { id: string; title: string; path: string; startLine: number | null; severity: Severity }[];
    lastSeenAt: string | null;
}

const text = (v: unknown, max: number, what: string): string => {
    if (typeof v !== "string") throw badRequest(`${what} must be text.`);
    const t = cleanText(v).trim();
    if (t.length > max) throw badRequest(`${what} must be at most ${max} characters.`);
    return t;
};

/** What a branch's grouping and its likely false positives are filed under. */
const subjectOf = (project: Project, branch: string) => `${project.id}:${branch}`;

export class CommonIssues {
    private readonly core: Core;
    private readonly reports: Reports;
    private readonly analyst: Analyst;

    constructor(core: Core, reports: Reports, analyst: Analyst) {
        this.core = core;
        this.reports = reports;
        this.analyst = analyst;
    }

    private get store() {
        return this.core.store;
    }

    // ---- reading -----------------------------------------------------------------------------------

    private viewOf(pattern: Pattern, links: readonly PatternFinding[], branch: string, view: BranchView): PatternView {
        const mine = links.filter((l) => l.patternId === pattern.id);
        const open = mine
            .filter((l) => l.branch === branch)
            .map((l) => view.issue(l.findingId))
            .filter((x): x is EffectiveIssue => x !== null && !view.isDone(x.id))
            .sort(priorityCompare);
        const openBySeverity = zero();
        const files = new Map<string, number>();
        for (const x of open) {
            openBySeverity[x.severity]++;
            files.set(x.path, (files.get(x.path) ?? 0) + 1);
        }
        return {
            ...pattern,
            open: open.length,
            total: mine.length,
            openBySeverity,
            files: [...files]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, 5)
                .map(([path, n]) => ({ path, open: n })),
            examples: open
                .slice(0, 5)
                .map((x) => ({ id: x.id, title: x.title, path: x.path, startLine: x.startLine, severity: x.severity })),
            lastSeenAt: mine.reduce<string | null>((latest, l) => (latest === null || l.addedAt > latest ? l.addedAt : latest), null),
        };
    }

    /** A project's common issues with what's under each on `branch`, the heaviest first; hidden ones last. */
    async list(workspace: Workspace, project: Project, branch: string) {
        const view = await this.reports.view(this.store, project, branch);
        const patterns = await this.store.patterns.forProject(project.id);
        const links = await this.store.patterns.findings(project.id);
        const under = new Set(links.filter((l) => l.branch === branch).map((l) => l.findingId));
        const open = view.issues().filter((x) => !view.isDone(x.id));
        const weight = (p: PatternView) => SEVERITIES.reduce((n, s) => n + p.openBySeverity[s] * severityWeight(s), 0);
        const items = patterns
            .map((p) => this.viewOf(p, links, branch, view))
            .sort(
                (a, b) =>
                    Number(a.hidden) - Number(b.hidden) || weight(b) - weight(a) || b.total - a.total || a.title.localeCompare(b.title),
            );
        return {
            branch,
            items,
            /** Open findings on the branch: all of them, and those under no common issue yet. */
            open: open.length,
            ungrouped: open.filter((x) => !under.has(x.id)).length,
            /** The last time a model was asked to group this branch's findings, as it stands. */
            grouping: await this.analyst.latest(workspace, "patterns", subjectOf(project, branch)),
            model: await this.analyst.model(workspace),
        };
    }

    /** The common issue a finding is under, with its advice: for the issue's own page and for agents. */
    async forIssue(project: Project, branch: string, findingId: string) {
        const link = (await this.store.patterns.findings(project.id, branch)).find((l) => l.findingId === findingId);
        const pattern = link ? await this.store.patterns.get(link.patternId) : null;
        return pattern && !pattern.hidden
            ? { id: pattern.id, title: pattern.title, summary: pattern.summary, guidance: pattern.guidance }
            : null;
    }

    /** The ids of the findings under a common issue on a branch: what the issues list filters by. */
    async findingIds(project: Project, branch: string, patternId: string): Promise<string[]> {
        const pattern = await this.get(project, patternId);
        return (await this.store.patterns.findings(project.id, branch)).filter((l) => l.patternId === pattern.id).map((l) => l.findingId);
    }

    /**
     * Filters as the branch's view can apply them: one for a common issue becomes the ids of the findings
     * under it (and of those, only the ids already asked for, if any were). An unknown one is a 404.
     */
    async narrow(project: Project, branch: string, filters: IssueFilters): Promise<IssueFilters> {
        if (!filters.pattern) return filters;
        const under = await this.findingIds(project, branch, filters.pattern);
        const ids = filters.ids.length ? under.filter((id) => filters.ids.includes(id)) : under;
        // None under it: an id no finding has, so nothing matches (an empty list would mean "any").
        return { ...filters, ids: ids.length ? ids : ["(none)"] };
    }

    private async get(project: Project, id: string): Promise<Pattern> {
        const p = /^[\w-]{1,40}$/.test(id) ? await this.store.patterns.get(id) : null;
        if (!p || p.projectId !== project.id) throw notFound("No such common issue in this project.");
        return p;
    }

    // ---- people's changes --------------------------------------------------------------------------

    private checked(input: PatternInput): PatternInput {
        const out: PatternInput = {};
        if (input.title !== undefined) {
            out.title = text(input.title, MAX_TITLE, "The title");
            if (out.title.length < 4) throw badRequest("Give the common issue a title of a few words.");
        }
        if (input.summary !== undefined) out.summary = text(input.summary, MAX_SUMMARY, "What goes wrong");
        if (input.guidance !== undefined) out.guidance = text(input.guidance, MAX_GUIDANCE, "How to avoid it");
        if (input.category !== undefined) {
            if (input.category !== null && !(CATEGORIES as readonly unknown[]).includes(input.category))
                throw badRequest(`Unknown category. Allowed: ${CATEGORIES.join(", ")}.`);
            out.category = input.category;
        }
        if (input.hidden !== undefined) out.hidden = Boolean(input.hidden);
        return out;
    }

    async create(actor: Actor, workspace: Workspace, project: Project, input: PatternInput): Promise<Pattern> {
        const v = this.checked(input);
        if (!v.title) throw badRequest("Give the common issue a title.");
        return this.core.write(actor, async (w) => {
            if ((await w.tx.patterns.forProject(project.id)).length >= MAX_PATTERNS)
                throw conflict(`A project can have ${MAX_PATTERNS} common issues. Merge or delete some first.`);
            const at = now();
            const pattern: Pattern = {
                id: randomId(),
                workspaceId: workspace.id,
                projectId: project.id,
                title: v.title as string,
                summary: v.summary ?? "",
                guidance: v.guidance ?? "",
                category: v.category ?? null,
                hidden: false,
                source: "person",
                createdBy: actor.name,
                createdAt: at,
                updatedBy: null,
                updatedAt: at,
            };
            await w.tx.patterns.put(pattern);
            await w.activity(
                {
                    workspaceId: workspace.id,
                    projectId: project.id,
                    branch: null,
                    kind: "pattern",
                    itemId: pattern.id,
                    changes: { created: { title: pattern.title } },
                },
                project.slug,
            );
            return pattern;
        });
    }

    async update(actor: Actor, project: Project, id: string, input: PatternInput): Promise<Pattern> {
        const v = this.checked(input);
        return this.core.write(actor, async (w) => {
            const before = await w.tx.patterns.get(id);
            if (!before || before.projectId !== project.id) throw notFound("No such common issue in this project.");
            const next: Pattern = {
                ...before,
                ...(v.title !== undefined ? { title: v.title } : {}),
                ...(v.summary !== undefined ? { summary: v.summary } : {}),
                ...(v.guidance !== undefined ? { guidance: v.guidance } : {}),
                ...(v.category !== undefined ? { category: v.category } : {}),
                ...(v.hidden !== undefined ? { hidden: v.hidden } : {}),
            };
            const changed = (["title", "summary", "guidance", "category", "hidden"] as const).filter((k) => next[k] !== before[k]);
            if (!changed.length) return before;
            const saved = { ...next, updatedBy: actor.name, updatedAt: now() };
            await w.tx.patterns.put(saved);
            await w.activity(
                {
                    workspaceId: project.workspaceId,
                    projectId: project.id,
                    branch: null,
                    kind: "pattern",
                    itemId: id,
                    // Which fields, and the short ones' values: the advice itself is on the page.
                    changes: {
                        title: saved.title,
                        ...(changed.includes("title") ? { renamed: { from: before.title, to: saved.title } } : {}),
                        ...(changed.includes("hidden") ? { hidden: { from: before.hidden, to: saved.hidden } } : {}),
                        edited: changed.filter((k) => k !== "title" && k !== "hidden"),
                    },
                },
                project.slug,
            );
            return saved;
        });
    }

    /** Put everything under one common issue under another, and delete the first. */
    async merge(actor: Actor, project: Project, id: string, into: string): Promise<Pattern> {
        if (id === into) throw badRequest("Choose a different common issue to merge into.");
        return this.core.write(actor, async (w) => {
            const from = await w.tx.patterns.get(id);
            const to = /^[\w-]{1,40}$/.test(into) ? await w.tx.patterns.get(into) : null;
            if (!from || from.projectId !== project.id) throw notFound("No such common issue in this project.");
            if (!to || to.projectId !== project.id) throw notFound("The common issue to merge into isn't in this project.");
            await w.tx.patterns.move(from.id, to.id);
            await w.tx.patterns.delete(from.id);
            await w.activity(
                {
                    workspaceId: project.workspaceId,
                    projectId: project.id,
                    branch: null,
                    kind: "pattern",
                    itemId: to.id,
                    changes: { title: to.title, merged: { from: from.title } },
                },
                project.slug,
            );
            return to;
        });
    }

    async remove(actor: Actor, project: Project, id: string): Promise<void> {
        await this.core.write(actor, async (w) => {
            const p = await w.tx.patterns.get(id);
            if (!p || p.projectId !== project.id) throw notFound("No such common issue in this project.");
            await w.tx.patterns.delete(id);
            await w.activity(
                {
                    workspaceId: project.workspaceId,
                    projectId: project.id,
                    branch: null,
                    kind: "pattern",
                    itemId: id,
                    changes: { deleted: { title: p.title } },
                },
                project.slug,
            );
        });
    }

    // ---- grouping ----------------------------------------------------------------------------------

    /**
     * Ask the analysis model to put the branch's open findings that are under no common issue yet under
     * existing or new ones. At most GROUP_MAX findings in one go, the most urgent first: the answer says how
     * many were left for the next.
     */
    async group(actor: Actor, workspace: Workspace, project: Project, branch: string): Promise<Analysis> {
        const subject = subjectOf(project, branch);
        const running = await this.analyst.latest(workspace, "patterns", subject);
        if (running?.status === "running") return running;
        const view = await this.reports.view(this.store, project, branch);
        const under = new Set((await this.store.patterns.findings(project.id, branch)).map((l) => l.findingId));
        const open = view.issues().filter((x) => !view.isDone(x.id));
        const todo = open.filter((x) => !under.has(x.id)).sort(priorityCompare);
        if (!todo.length)
            throw conflict(
                open.length
                    ? "Every open finding on this branch is under a common issue already."
                    : "There are no open findings on this branch to group.",
            );
        const now_ = todo.slice(0, GROUP_MAX);
        const warning = thinGrouping(open.length);
        return this.analyst.begin(
            actor,
            workspace,
            { kind: "patterns", projectId: project.id, branch, subject, input: null },
            async (ask) => {
                let created = 0;
                let grouped = 0;
                for (let i = 0; i < now_.length; i += GROUP_BATCH) {
                    const batch = now_.slice(i, i + GROUP_BATCH);
                    // Read again each time: the batch before may have added some, and people may have meanwhile.
                    const existing = (await this.store.patterns.forProject(project.id)).filter((p) => !p.hidden);
                    const letters = existing.map((_, k) => `e${k + 1}`);
                    const said = await ask(
                        GROUP_SYSTEM,
                        groupQuestion({
                            existing: existing.map((p, k) => ({
                                id: letters[k] as string,
                                title: p.title,
                                summary: p.summary.slice(0, 300),
                            })),
                            findings: batch.map((x, k) => ({
                                n: k + 1,
                                severity: x.severity,
                                category: x.category,
                                file: x.path,
                                title: x.title.slice(0, 200),
                            })),
                        }),
                    );
                    const groups = readGroups(
                        said,
                        letters,
                        batch.map((_, k) => k + 1),
                    );
                    if (!groups) throw new Error("its answer wasn't one that could be read");
                    const made = await this.core.write(actor, async (w) => {
                        const at = now();
                        const have = (await w.tx.patterns.forProject(project.id)).length;
                        let fresh = 0;
                        const rows: PatternFinding[] = [];
                        for (const g of groups) {
                            let patternId: string;
                            if ("existing" in g) patternId = (existing[letters.indexOf(g.existing)] as Pattern).id;
                            else {
                                if (have + fresh >= MAX_PATTERNS) continue;
                                patternId = randomId();
                                fresh++;
                                await w.tx.patterns.put({
                                    id: patternId,
                                    workspaceId: workspace.id,
                                    projectId: project.id,
                                    ...g.fresh,
                                    hidden: false,
                                    source: "model",
                                    createdBy: actor.name,
                                    createdAt: at,
                                    updatedBy: null,
                                    updatedAt: at,
                                });
                            }
                            for (const n of g.findings) {
                                const x = batch[n - 1] as EffectiveIssue;
                                rows.push({
                                    patternId,
                                    projectId: project.id,
                                    branch,
                                    findingId: x.id,
                                    path: x.path,
                                    title: x.title.slice(0, 300),
                                    severity: x.severity,
                                    addedAt: at,
                                });
                            }
                        }
                        await w.tx.patterns.link(rows);
                        return { fresh, linked: rows.length };
                    });
                    created += made.fresh;
                    grouped += made.linked;
                }
                return {
                    /** New common issues, findings put under one (new or not), findings looked at, and those left for next time. */
                    created,
                    grouped,
                    considered: now_.length,
                    left: todo.length - now_.length,
                    ...(warning ? { warning } : {}),
                };
            },
        );
    }

    // ---- likely false positives --------------------------------------------------------------------

    /** Findings the project has dismissed as won't fix (not as duplicates) with a reason, the most recent first. */
    private async dismissed(project: Project) {
        const out: { id: string; branch: string; category: Category; path: string; title: string; reason: string; at: string }[] = [];
        for (const stored of await this.store.reports.branches(project.id)) {
            const view = await this.reports.viewStored(this.store, project, stored);
            for (const x of view.issues()) {
                const r = view.record("issue", x.id);
                const reason = r?.notes.at(-1)?.text.trim();
                if (r?.status !== "wont_fix" || r.duplicateOf || !reason) continue;
                out.push({
                    id: x.id,
                    branch: stored.branch,
                    category: x.category,
                    path: x.path,
                    title: x.title,
                    reason: reason.replace(/\s+/g, " ").slice(0, 300),
                    at: r.updatedAt ?? "",
                });
            }
        }
        return out.sort((a, b) => b.at.localeCompare(a.at));
    }

    /** What was last suggested for a branch, with only the findings still open, and how much there is to learn from. */
    async falsePositives(workspace: Workspace, project: Project, branch: string) {
        const analysis = await this.analyst.latest(workspace, "falsePositives", subjectOf(project, branch));
        const view = await this.reports.view(this.store, project, branch);
        const dismissed = (await this.dismissed(project)).length;
        const items = ((analysis?.result?.items as Suggested[] | undefined) ?? []).flatMap((s) => {
            const x = view.issue(s.id);
            if (!x || view.isDone(x.id)) return [];
            return [
                { ...s, title: x.title, path: x.path, startLine: x.startLine, severity: x.severity, foundBy: x.foundBy?.length ?? null },
            ];
        });
        return {
            branch,
            analysis,
            items,
            /** Findings dismissed with a reason in the project, and how many it takes to rely on a suggestion. */
            dismissed,
            enough: FEW_DISMISSED,
            model: await this.analyst.model(workspace),
        };
    }

    async findFalsePositives(actor: Actor, workspace: Workspace, project: Project, branch: string): Promise<Analysis> {
        const subject = subjectOf(project, branch);
        const running = await this.analyst.latest(workspace, "falsePositives", subject);
        if (running?.status === "running") return running;
        const dismissed = await this.dismissed(project);
        if (!dismissed.length)
            throw conflict(
                "Nothing has been dismissed with a reason in this project yet, so there's nothing to learn from. Mark some findings won't fix, with a note saying why, first.",
            );
        const view = await this.reports.view(this.store, project, branch);
        // What only one model found first: that's where false positives mostly are. Then the least serious.
        const open = view
            .issues()
            .filter((x) => !view.isDone(x.id))
            .sort((a, b) => (a.foundBy?.length ?? 1) - (b.foundBy?.length ?? 1) || priorityCompare(b, a));
        if (!open.length) throw conflict("There are no open findings on this branch.");
        const considered = open.slice(0, FALSE_POSITIVE_MAX);
        const shown = dismissed.slice(0, MAX_DISMISSED_SHOWN);
        const examples: DismissedExample[] = shown.map((d, k) => ({
            n: k + 1,
            category: d.category,
            file: d.path,
            title: d.title.slice(0, 200),
            reason: d.reason,
        }));
        const warning = thinHistory(dismissed.length);
        return this.analyst.begin(
            actor,
            workspace,
            { kind: "falsePositives", projectId: project.id, branch, subject, input: null },
            async (ask) => {
                const items: Suggested[] = [];
                for (let i = 0; i < considered.length; i += FALSE_POSITIVE_BATCH) {
                    const batch = considered.slice(i, i + FALSE_POSITIVE_BATCH);
                    const said = await ask(
                        FALSE_POSITIVE_SYSTEM,
                        falsePositiveQuestion({
                            dismissed: examples,
                            open: batch.map((x, k) => ({
                                n: k + 1,
                                severity: x.severity,
                                category: x.category,
                                file: x.path,
                                title: x.title.slice(0, 200),
                                foundByModels: x.foundBy?.length ?? null,
                            })),
                        }),
                    );
                    const likely = readLikely(
                        said,
                        batch.map((_, k) => k + 1),
                        examples.map((e) => e.n),
                    );
                    if (!likely) throw new Error("its answer wasn't one that could be read");
                    for (const l of likely) {
                        const x = batch[l.finding - 1] as EffectiveIssue;
                        const like = shown[l.like - 1] as (typeof shown)[number];
                        items.push({
                            id: x.id,
                            why: l.why,
                            like: { id: like.id, branch: like.branch, title: like.title, reason: like.reason },
                        });
                    }
                }
                return {
                    items,
                    considered: considered.length,
                    left: open.length - considered.length,
                    dismissed: dismissed.length,
                    ...(warning ? { warning } : {}),
                };
            },
        );
    }
}

/** One open finding a model thinks would be dismissed, the dismissed one it's like, and why. */
interface Suggested {
    id: string;
    why: string;
    like: { id: string; branch: string; title: string; reason: string };
}
