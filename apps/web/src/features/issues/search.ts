// The Issues page keeps its filters in the URL (?severity=high,critical&status=open&q=…), so a view can
// be bookmarked, shared and restored with the back button. These functions turn the URL's strings into
// typed filters and back, and into the API's query.

import {
    CATEGORIES,
    type Category,
    ISSUE_SORTS,
    type IssueSort,
    MAX_ID,
    SEVERITIES,
    type Severity,
    STATUSES,
    type Status,
} from "@triagent/shared";

export const FLAGS = ["hasSuggestion", "needsDiscussion", "duplicates", "adjusted", "lowerConfidence"] as const;
export type Flag = (typeof FLAGS)[number];

export const FLAG_LABEL: Record<Flag, { yes: string; no: string }> = {
    hasSuggestion: { yes: "Has a suggested fix", no: "No suggested fix" },
    needsDiscussion: { yes: "Needs discussion", no: "Doesn't need discussion" },
    duplicates: { yes: "Duplicates", no: "Not duplicates" },
    adjusted: { yes: "Rating corrected", no: "Rating not corrected" },
    lowerConfidence: { yes: "Lower confidence (one model found it)", no: "Not lower confidence" },
};

export const PAGE_SIZE = 100;
const MAX_OFFSET = 1_000_000;

export interface IssueSearch {
    branch?: string;
    severity?: Severity[];
    category?: Category[];
    status?: Status[];
    path?: string;
    q?: string;
    /** A name, or "none" for unassigned. */
    assignee?: string;
    task?: string;
    hasSuggestion?: boolean;
    needsDiscussion?: boolean;
    duplicates?: boolean;
    adjusted?: boolean;
    /** Only findings marked as lower confidence, or only the others (reviews that asked for the mark). */
    lowerConfidence?: boolean;
    /** Only findings at least this many models found (reviews run with several). */
    foundBy?: number;
    /** Only findings this model found (its name in the review), and with `onlyModel`, that no other did. */
    model?: string;
    onlyModel?: boolean;
    /** Only findings under this common issue (its id). */
    pattern?: string;
    sort?: IssueSort;
    /** From 1. */
    page?: number;
}

function text(value: unknown, max = 500): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const s = String(value).trim().slice(0, max);
    return s || undefined;
}

function listOf<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
    const raw = Array.isArray(value) ? value.join(",") : text(value, 1000);
    if (!raw) return undefined;
    const picked = allowed.filter((a) => raw.split(",").some((v) => v.trim() === a));
    return picked.length ? picked : undefined;
}

function flag(value: unknown): boolean | undefined {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    return undefined;
}

/** Typed filters from the URL. Unknown values are dropped rather than sent to the server. */
export function parseIssueSearch(raw: Record<string, unknown>): IssueSearch {
    const out: IssueSearch = {};
    const branch = text(raw.branch, 200);
    if (branch) out.branch = branch;
    const severity = listOf(raw.severity, SEVERITIES);
    if (severity) out.severity = severity;
    const category = listOf(raw.category, CATEGORIES);
    if (category) out.category = category;
    const status = listOf(raw.status, STATUSES);
    if (status) out.status = status;
    for (const k of ["path", "q", "assignee", "task"] as const) {
        // The server's limits (parseFilters): longer values would be refused.
        const v = text(raw[k], k === "assignee" ? 64 : k === "q" ? 200 : k === "task" ? MAX_ID : 500);
        if (v) out[k] = v;
    }
    for (const k of FLAGS) {
        const v = flag(raw[k]);
        if (v !== undefined) out[k] = v;
    }
    const foundBy = Number(raw.foundBy);
    if (Number.isInteger(foundBy) && foundBy >= 2 && foundBy <= 10) out.foundBy = foundBy;
    const model = text(raw.model, 200);
    if (model) {
        out.model = model;
        // Means nothing without a model to be the only one.
        if (flag(raw.onlyModel) === true) out.onlyModel = true;
    }
    const pattern = text(raw.pattern, 40);
    if (pattern) out.pattern = pattern;
    const sort = text(raw.sort);
    if (sort && (ISSUE_SORTS as readonly string[]).includes(sort) && sort !== "priority") out.sort = sort as IssueSort;
    const page = Number(raw.page);
    // The server takes offsets up to 1,000,000.
    if (Number.isInteger(page) && page > 1 && page <= MAX_OFFSET / PAGE_SIZE + 1) out.page = page;
    return out;
}

/** The API query for these filters (lists comma-separated, one page of results). */
export function issueApiQuery(s: IssueSearch, pageSize = PAGE_SIZE): Record<string, string | undefined> {
    const join = (v: readonly string[] | undefined) => (v?.length ? v.join(",") : undefined);
    const bool = (v: boolean | undefined) => (v === undefined ? undefined : String(v));
    return {
        severity: join(s.severity),
        category: join(s.category),
        status: join(s.status),
        path: s.path,
        q: s.q,
        assignee: s.assignee,
        task: s.task,
        hasSuggestion: bool(s.hasSuggestion),
        needsDiscussion: bool(s.needsDiscussion),
        duplicates: bool(s.duplicates),
        adjusted: bool(s.adjusted),
        lowerConfidence: bool(s.lowerConfidence),
        foundBy: s.foundBy ? String(s.foundBy) : undefined,
        model: s.model,
        onlyModel: s.model && s.onlyModel ? "true" : undefined,
        pattern: s.pattern,
        sort: s.sort,
        limit: String(pageSize),
        offset: s.page && s.page > 1 ? String((s.page - 1) * pageSize) : undefined,
    };
}

/** Add or remove one value from a list filter; an empty list means no filter. */
export function toggle<T extends string>(list: readonly T[] | undefined, value: T): T[] | undefined {
    const current = list ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    return next.length ? next : undefined;
}

/** How many filters are on (not counting branch, sort and page). */
export function activeFilters(s: IssueSearch): number {
    let n = 0;
    for (const k of ["severity", "category", "status"] as const) if (s[k]?.length) n++;
    for (const k of ["path", "q", "assignee", "task"] as const) if (s[k]) n++;
    for (const k of FLAGS) if (s[k] !== undefined) n++;
    if (s.foundBy) n++;
    if (s.model) n++;
    if (s.pattern) n++;
    return n;
}

/** The same view with every filter cleared (keeps the branch and sort). */
export function withoutFilters(s: IssueSearch): IssueSearch {
    return { ...(s.branch ? { branch: s.branch } : {}), ...(s.sort ? { sort: s.sort } : {}) };
}

/** Any change to the filters starts again from the first page. */
export function withFilter(s: IssueSearch, patch: Partial<IssueSearch>): IssueSearch {
    const next: IssueSearch = { ...s, ...patch };
    delete next.page;
    for (const [k, v] of Object.entries(next))
        if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete next[k as keyof IssueSearch];
    return next;
}
