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
import { badRequest } from "../errors.ts";
import { cleanText } from "./names.ts";

export { MAX_ID };

export interface IssueFilters {
    severity: Severity[];
    category: Category[];
    status: Status[];
    path: string;
    q: string;
    task: string;
    /** A name, "none" for unassigned, or "" for anyone. */
    assignee: string;
    hasSuggestion: boolean | null;
    needsDiscussion: boolean | null;
    duplicates: boolean | null;
    /** Only findings whose rating someone corrected (or only ones nobody did). */
    adjusted: boolean | null;
    /** Only findings at least this many models found (reviews run with several), or null for any. */
    foundBy: number | null;
    /** Only findings this model found (its name in the review: see the list's `models`), or null for any. */
    model: string | null;
    /** With `model`: only findings no other model found. */
    onlyModel: boolean;
    /** Only findings marked as lower confidence (one model found them, and the review asked), or only the others. */
    lowerConfidence: boolean | null;
    ids: string[];
    /**
     * Only findings under this common issue. The view doesn't know which those are: whoever reads the
     * filters turns it into `ids` first (services/patterns.ts `narrow`).
     */
    pattern: string;
    sort: IssueSort;
    limit: number;
    offset: number;
}

type Input = URLSearchParams | Record<string, unknown>;

function read(input: Input, k: string): unknown {
    if (input instanceof URLSearchParams) {
        const all = input.getAll(k);
        return all.length > 1 ? all : (all[0] ?? undefined);
    }
    return input[k];
}

/** "a,b", ["a", "b"] and ["a,b", "c"] all become a list. */
export function list(value: unknown): string[] {
    if (value == null || value === "") return [];
    return (Array.isArray(value) ? value : [value])
        .flatMap((v) => String(v).split(","))
        .map((v) => v.trim())
        .filter(Boolean);
}

export function oneOf<T extends string>(values: string[], allowed: readonly T[], field: string): T[] {
    const bad = values.filter((v) => !(allowed as readonly string[]).includes(v));
    if (bad.length) throw badRequest(`Unknown ${field}: ${bad.join(", ")}. Allowed: ${allowed.join(", ")}.`);
    return values as T[];
}

function text(value: unknown, max: number, field: string): string {
    if (value == null) return "";
    if (typeof value !== "string") throw badRequest(`${field} must be text.`);
    const v = cleanText(value).trim();
    if (v.length > max) throw badRequest(`${field} must be at most ${max} characters.`);
    return v;
}

function flag(value: unknown, field: string): boolean | null {
    if (value === undefined || value === null || value === "") return null;
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    throw badRequest(`${field} must be true or false.`);
}

function whole(value: unknown, fallback: number, min: number, max: number, field: string): number {
    if (value == null || value === "") return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${field} must be a whole number from ${min} to ${max}.`);
    return n;
}

/** Filters from a query string or an MCP tool's arguments (both spellings of the flags are accepted). */
export function parseFilters(input: Input, { maxLimit = 500, defaultLimit = 50 } = {}): IssueFilters {
    // The first alias actually given: an empty one counts as not given, as it does for every field.
    const get = (...keys: string[]) => keys.map((k) => read(input, k)).find((v) => v !== undefined && v !== "");
    const sort = String(get("sort") || "priority");
    const foundBy = get("foundBy", "found_by");
    if (flag(get("onlyModel", "only_model"), "onlyModel") === true && !text(get("model"), 200, "model"))
        throw badRequest('"onlyModel" needs "model": the model whose findings no other model found.');
    return {
        severity: oneOf(list(get("severity")), SEVERITIES, "severity"),
        category: oneOf(list(get("category")), CATEGORIES, "category"),
        status: oneOf(list(get("status")), STATUSES, "status"),
        path: text(get("path"), 500, "path"),
        q: text(get("q"), 200, "q"),
        task: text(get("task"), MAX_ID, "task"),
        assignee: text(get("assignee"), 64, "assignee"),
        hasSuggestion: flag(get("hasSuggestion", "has_suggestion"), "hasSuggestion"),
        needsDiscussion: flag(get("needsDiscussion", "needs_discussion"), "needsDiscussion"),
        duplicates: flag(get("duplicates"), "duplicates"),
        adjusted: flag(get("adjusted"), "adjusted"),
        foundBy: foundBy == null ? null : whole(foundBy, 1, 1, 10, "foundBy"),
        model: text(get("model"), 200, "model") || null,
        onlyModel: flag(get("onlyModel", "only_model"), "onlyModel") === true,
        lowerConfidence: flag(get("lowerConfidence", "lower_confidence"), "lowerConfidence"),
        ids: list(get("ids")),
        pattern: text(get("pattern"), 40, "pattern"),
        sort: oneOf([sort], ISSUE_SORTS, "sort")[0] as IssueSort,
        limit: whole(get("limit"), defaultLimit, 1, maxLimit, "limit"),
        offset: whole(get("offset"), 0, 0, 1_000_000, "offset"),
    };
}

export function describeFilters(f: IssueFilters): string {
    const parts: string[] = [];
    for (const k of ["severity", "category", "status"] as const) if (f[k].length) parts.push(`${k}=${f[k].join(",")}`);
    for (const k of ["path", "q", "task", "assignee"] as const) if (f[k]) parts.push(`${k}=${f[k]}`);
    for (const k of ["hasSuggestion", "needsDiscussion", "duplicates", "adjusted", "lowerConfidence"] as const)
        if (f[k] !== null) parts.push(`${k}=${f[k]}`);
    if (f.pattern) parts.push("under one common issue");
    else if (f.ids.length) parts.push(`${f.ids.length} chosen id(s)`);
    if (f.foundBy) parts.push(`found by at least ${f.foundBy} models`);
    if (f.model) parts.push(f.onlyModel ? `found only by ${f.model}` : `found by ${f.model}`);
    return parts.length ? ` for ${parts.join(", ")}` : "";
}
