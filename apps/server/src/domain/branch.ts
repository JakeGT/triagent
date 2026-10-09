// What one branch looks like: its report with everyone's triage applied. Read-only; changes go through
// services/triage.ts, which builds a fresh BranchView afterwards.

import { CATEGORIES, type Category, DONE_STATUSES, SEVERITIES, type Severity, STATUSES, type Status } from "@triagent/shared";
import { notFound } from "../errors.ts";
import type { ActivityRow, ItemKind, Note, TriageRecord } from "../store/types.ts";
import type { IssueFilters } from "./filters.ts";
import { type Issue, type OtherFinding, priorityCompare, type Review, severityWeight, type Task } from "./report.ts";

/** A finding with corrections applied. `reviewer*` hold the reviewer's own rating when it was changed. */
export interface EffectiveIssue extends Issue {
    readonly reviewerSeverity: Severity | null;
    readonly reviewerCategory: Category | null;
}

export interface IssueSummary {
    id: string;
    index: number;
    severity: Severity;
    category: Category;
    reviewerSeverity: Severity | null;
    reviewerCategory: Category | null;
    status: Status;
    assignee: string | null;
    path: string;
    startLine: number | null;
    endLine: number | null;
    title: string;
    hasSuggestion: boolean;
    addedBy: string | null;
    /** The models that found it, when the review ran with several; null otherwise. */
    foundBy: string[] | null;
    sourceUrl: string | null;
    noteCount: number;
    rev: number;
    needsDiscussion: boolean;
    duplicateOf: string | null;
    duplicateCount: number;
    updatedAt: string | null;
}

export interface IssueDetail extends IssueSummary {
    content: string;
    existingCode: string | null;
    suggestionCode: string | null;
    /** What the other models that found it said (reviews run with several). */
    alsoFound: OtherFinding[];
    notes: Note[];
    duplicates: { id: string; title: string; path: string; startLine: number | null }[];
    duplicateOfTitle: string | null;
    updatedBy: string | null;
    tasks: { id: string; section: string; title: string }[];
}

export interface Counts {
    severity: Record<Severity, number>;
    category: Record<Category, number>;
    status: Record<Status, number>;
}

const zeroes = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

export const recordKey = (kind: ItemKind, id: string) => `${kind}:${id}`;

export interface BranchContext {
    project: { slug: string; name: string; repoUrl: string | null };
    branch: string;
    commit: string | null;
}

export class BranchView {
    readonly review: Review;
    readonly context: BranchContext;
    private readonly records: ReadonlyMap<string, TriageRecord>;
    private readonly effective: readonly EffectiveIssue[];
    private readonly effectiveById: ReadonlyMap<string, EffectiveIssue>;
    private readonly duplicatesById: ReadonlyMap<string, string[]>;
    private readonly searchText: ReadonlyMap<string, string>;

    constructor(review: Review, records: Iterable<TriageRecord>, context: BranchContext) {
        this.review = review;
        this.context = context;
        this.records = new Map([...records].map((r) => [recordKey(r.kind, r.itemId), r]));
        this.effective = review.issues.map((x) => {
            const r = this.record("issue", x.id);
            const severity = r?.severity ?? x.severity;
            const category = r?.category ?? x.category;
            return Object.freeze({
                ...x,
                severity,
                category,
                reviewerSeverity: severity !== x.severity ? x.severity : null,
                reviewerCategory: category !== x.category ? x.category : null,
            });
        });
        this.effectiveById = new Map(this.effective.map((x) => [x.id, x]));
        const dups = new Map<string, string[]>();
        for (const r of this.records.values()) {
            if (r.kind !== "issue" || !r.duplicateOf || !review.byId.has(r.itemId)) continue;
            dups.set(r.duplicateOf, [...(dups.get(r.duplicateOf) ?? []), r.itemId]);
        }
        this.duplicatesById = dups;
        this.searchText = new Map(
            review.issues.map((x) => [
                x.id,
                [x.id, x.path, x.title, x.content, x.existingCode ?? "", x.suggestionCode ?? ""].join("\n").toLowerCase(),
            ]),
        );
    }

    get branch(): string {
        return this.context.branch;
    }

    record(kind: ItemKind, id: string): TriageRecord | null {
        return this.records.get(recordKey(kind, id)) ?? null;
    }

    issues(): readonly EffectiveIssue[] {
        return this.effective;
    }

    issue(id: string): EffectiveIssue | null {
        return this.effectiveById.get(id) ?? null;
    }

    duplicatesOf(id: string): string[] {
        return this.duplicatesById.get(id) ?? [];
    }

    statusOf(kind: ItemKind, id: string): Status {
        return this.record(kind, id)?.status ?? "open";
    }

    isDone(id: string): boolean {
        return DONE_STATUSES.has(this.statusOf("issue", id));
    }

    // ---- issues ----------------------------------------------------------------------

    sourceUrl(x: Issue): string | null {
        const repo = this.context.project.repoUrl;
        if (!repo) return null;
        // encodeURIComponent leaves ( and ) alone; encoded too, the URL can sit inside a Markdown link.
        const enc = (s: string) => encodeURIComponent(s).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));
        const ref = enc(this.context.commit ?? this.branch).replace(/%2F/g, "/");
        const file = x.path.split("/").map(enc).join("/");
        const lines = x.startLine ? `#L${x.startLine}${x.endLine && x.endLine !== x.startLine ? `-L${x.endLine}` : ""}` : "";
        return `${repo}/blob/${ref}/${file}${lines}`;
    }

    summary(x: EffectiveIssue): IssueSummary {
        const r = this.record("issue", x.id);
        return {
            id: x.id,
            index: x.index,
            severity: x.severity,
            category: x.category,
            reviewerSeverity: x.reviewerSeverity,
            reviewerCategory: x.reviewerCategory,
            status: r?.status ?? "open",
            assignee: r?.assignee ?? null,
            path: x.path,
            startLine: x.startLine,
            endLine: x.endLine,
            title: x.title,
            hasSuggestion: x.suggestionCode !== null,
            addedBy: x.addedBy,
            foundBy: x.foundBy ? [...x.foundBy] : null,
            sourceUrl: this.sourceUrl(x),
            noteCount: r?.notes.length ?? 0,
            rev: r?.rev ?? 0,
            needsDiscussion: r?.needsDiscussion ?? false,
            duplicateOf: r?.duplicateOf ?? null,
            duplicateCount: this.duplicatesOf(x.id).length,
            updatedAt: r?.updatedAt ?? null,
        };
    }

    detail(x: EffectiveIssue): IssueDetail {
        const r = this.record("issue", x.id);
        return {
            ...this.summary(x),
            content: x.content,
            existingCode: x.existingCode,
            suggestionCode: x.suggestionCode,
            alsoFound: [...x.alsoFound],
            notes: r?.notes ?? [],
            duplicates: this.duplicatesOf(x.id).map((id) => {
                const d = this.issue(id) as EffectiveIssue;
                return { id, title: d.title, path: d.path, startLine: d.startLine };
            }),
            duplicateOfTitle: r?.duplicateOf ? (this.issue(r.duplicateOf)?.title ?? null) : null,
            updatedBy: r?.updatedBy ?? null,
            tasks: (this.review.tasksByPath.get(x.path) ?? []).map((id) => {
                const t = this.review.taskById.get(id) as Task;
                return { id: t.id, section: t.section, title: t.title };
            }),
        };
    }

    getIssue(id: string): IssueDetail {
        const x = this.issue(id);
        if (!x) throw notFound(`No issue ${id} on branch ${this.branch}.`);
        return this.detail(x);
    }

    filter(f: IssueFilters): EffectiveIssue[] {
        const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
        let inTask: Set<string> | null = null;
        if (f.task) {
            const t = this.review.taskById.get(f.task);
            if (!t) throw notFound(`No task ${f.task} on branch ${this.branch}.`);
            inTask = new Set(t.issueIds);
        }
        const ids = f.ids.length ? new Set(f.ids) : null;
        const path = f.path.replace(/^\.\//, "");
        const folder = path.endsWith("/") ? path : `${path}/`;
        const out = this.effective.filter((x) => {
            const r = this.record("issue", x.id);
            if (ids && !ids.has(x.id)) return false;
            if (inTask && !inTask.has(x.id)) return false;
            if (f.severity.length && !f.severity.includes(x.severity)) return false;
            if (f.category.length && !f.category.includes(x.category)) return false;
            if (f.status.length && !f.status.includes(r?.status ?? "open")) return false;
            if (path && x.path !== path && !x.path.startsWith(folder)) return false;
            if (f.hasSuggestion !== null && (x.suggestionCode !== null) !== f.hasSuggestion) return false;
            if (f.adjusted !== null && Boolean(x.reviewerSeverity || x.reviewerCategory) !== f.adjusted) return false;
            if (f.needsDiscussion !== null && Boolean(r?.needsDiscussion) !== f.needsDiscussion) return false;
            if (f.duplicates !== null && Boolean(r?.duplicateOf) !== f.duplicates) return false;
            if (f.foundBy !== null && (x.foundBy?.length ?? 1) < f.foundBy) return false;
            if (f.assignee) {
                const a = r?.assignee ?? null;
                if (f.assignee.toLowerCase() === "none" ? a !== null : (a ?? "").toLowerCase() !== f.assignee.toLowerCase()) return false;
            }
            if (terms.length) {
                const hay = this.searchText.get(x.id) ?? "";
                if (!terms.every((t) => hay.includes(t))) return false;
            }
            return true;
        });
        const updated = (x: Issue) => this.record("issue", x.id)?.updatedAt ?? "";
        const compare: Record<IssueFilters["sort"], (a: EffectiveIssue, b: EffectiveIssue) => number> = {
            priority: priorityCompare,
            severity: priorityCompare,
            index: (a, b) => a.index - b.index,
            path: (a, b) => a.path.localeCompare(b.path) || (a.startLine ?? 0) - (b.startLine ?? 0),
            updated: (a, b) => updated(b).localeCompare(updated(a)) || priorityCompare(a, b),
            agreement: (a, b) => (b.foundBy?.length ?? 1) - (a.foundBy?.length ?? 1) || priorityCompare(a, b),
        };
        return out.sort(compare[f.sort]);
    }

    listIssues(f: IssueFilters, { full = false } = {}) {
        const all = this.filter(f);
        const page = all.slice(f.offset, f.offset + f.limit);
        return {
            total: all.length,
            offset: f.offset,
            limit: f.limit,
            counts: this.counts(all),
            /** The models the review ran with, when it ran with several (findings say which found them). */
            models: this.review.meta.models,
            items: full ? page.map((x) => this.detail(x)) : page.map((x) => this.summary(x)),
        };
    }

    counts(issues: readonly EffectiveIssue[]): Counts {
        const c: Counts = { severity: zeroes(SEVERITIES), category: zeroes(CATEGORIES), status: zeroes(STATUSES) };
        for (const x of issues) {
            c.severity[x.severity]++;
            c.category[x.category]++;
            c.status[this.statusOf("issue", x.id)]++;
        }
        return c;
    }

    countSeverity(issues: readonly Issue[]): Record<Severity, number> {
        const c = zeroes(SEVERITIES);
        for (const x of issues) c[x.severity]++;
        return c;
    }

    // ---- files, tasks, overview ----------------------------------------------------------

    listFiles({ prefix = "", limit = 1000 } = {}) {
        const items = [];
        for (const [path, ids] of this.review.issuesByPath) {
            if (prefix && !path.startsWith(prefix)) continue;
            const xs = ids.map((id) => this.issue(id) as EffectiveIssue);
            const c = this.counts(xs);
            const open = xs.filter((x) => !this.isDone(x.id));
            items.push({
                path,
                total: xs.length,
                open: open.length,
                weight: open.reduce((n, x) => n + severityWeight(x.severity), 0),
                severity: c.severity,
                status: c.status,
                tasks: this.review.tasksByPath.get(path) ?? [],
            });
        }
        items.sort((a, b) => b.weight - a.weight || b.total - a.total || a.path.localeCompare(b.path));
        return { total: items.length, items: items.slice(0, limit) };
    }

    taskSummary(t: Task) {
        const r = this.record("task", t.id);
        const status = this.counts(t.issueIds.map((id) => this.issue(id) as EffectiveIssue)).status;
        return {
            id: t.id,
            sectionId: t.sectionId,
            section: t.section,
            position: t.position,
            title: t.title,
            markdown: t.markdown,
            status: r?.status ?? "open",
            assignee: r?.assignee ?? null,
            files: t.files,
            issueCount: t.issueIds.length,
            issuesDone: status.resolved + status.wont_fix,
            issueStatus: status,
            noteCount: r?.notes.length ?? 0,
            rev: r?.rev ?? 0,
            updatedAt: r?.updatedAt ?? null,
        };
    }

    getTask(id: string) {
        const t = this.review.taskById.get(id);
        if (!t) throw notFound(`No task ${id} on branch ${this.branch}.`);
        const r = this.record("task", id);
        return {
            ...this.taskSummary(t),
            body: t.body,
            notes: r?.notes ?? [],
            updatedBy: r?.updatedBy ?? null,
            issues: t.issueIds
                .map((i) => this.issue(i) as EffectiveIssue)
                .sort(priorityCompare)
                .map((x) => this.summary(x)),
        };
    }

    listTasks({ section = "", status = [] as Status[] } = {}) {
        const sections = this.review.sections.filter((s) => !section || s.id === section);
        if (section && !sections.length)
            throw notFound(`No section ${section}. Sections: ${this.review.sections.map((s) => s.id).join(", ") || "none"}.`);
        const items = sections
            .flatMap((s) => s.taskIds.map((id) => this.taskSummary(this.review.taskById.get(id) as Task)))
            .filter((t) => !status.length || status.includes(t.status));
        return { sections: sections.map((s) => ({ id: s.id, title: s.title, taskCount: s.taskIds.length })), total: items.length, items };
    }

    /** The summary section shown as the review's themes: "Top issues", or the first with items. */
    themeSection() {
        return this.review.sections.find((s) => s.id === "top-issues") ?? this.review.sections.find((s) => s.taskIds.length) ?? null;
    }

    overview(recentActivity: ActivityRow[]) {
        const issues = this.effective;
        const done = issues.filter((x) => this.isDone(x.id)).length;
        const themes = this.themeSection();
        return {
            branch: this.branch,
            meta: this.review.meta,
            flags: {
                needsDiscussion: issues.filter((x) => this.record("issue", x.id)?.needsDiscussion).length,
                duplicates: issues.filter((x) => this.record("issue", x.id)?.duplicateOf).length,
            },
            totals: {
                issues: issues.length,
                files: this.review.paths.length,
                tasks: this.review.tasks.length,
                done,
                remaining: issues.length - done,
            },
            status: this.counts(issues).status,
            bySeverity: SEVERITIES.map((severity) => {
                const xs = issues.filter((x) => x.severity === severity);
                return { severity, total: xs.length, ...this.counts(xs).status };
            }),
            byCategory: CATEGORIES.map((category) => {
                const xs = issues.filter((x) => x.category === category);
                return { category, total: xs.length, ...this.counts(xs).severity, done: xs.filter((x) => this.isDone(x.id)).length };
            }).filter((c) => c.total),
            hotspots: this.listFiles({ limit: 12 }).items,
            themesTitle: themes?.title ?? null,
            themes: themes ? this.listTasks({ section: themes.id }).items : [],
            // [id, severity, status, title], most urgent first: one cell per finding on the tally board.
            grid: [...issues]
                .sort(priorityCompare)
                .map((x) => [x.id, x.severity, this.statusOf("issue", x.id), x.title.replace(/`/g, "").slice(0, 140)]),
            recentActivity,
        };
    }
}

/** Findings `head` adds compared with `base`, and those it no longer has. */
export function compareBranches(base: BranchView, head: BranchView) {
    const added = head
        .issues()
        .filter((x) => !base.review.byId.has(x.id))
        .sort(priorityCompare);
    const gone = base
        .issues()
        .filter((x) => !head.review.byId.has(x.id))
        .sort(priorityCompare);
    const shared = head.issues().filter((x) => base.review.byId.has(x.id));
    return {
        base: base.branch,
        head: head.branch,
        // A pull-request review only covers its changes, so "gone" findings weren't fixed, just not looked at.
        headScope: head.review.meta.upload?.scope ?? "full",
        added: { total: added.length, severity: head.countSeverity(added), items: added.map((x) => head.summary(x)) },
        gone: { total: gone.length, severity: base.countSeverity(gone), items: gone.map((x) => base.summary(x)) },
        shared: {
            total: shared.length,
            doneOnBase: shared.filter((x) => base.isDone(x.id)).length,
            doneOnHead: shared.filter((x) => head.isDone(x.id)).length,
        },
    };
}
