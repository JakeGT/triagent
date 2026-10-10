// Several models' reviews of the same change, as one report for triage. Findings from different models
// at the same place (the same file and category, lines overlapping or within a few of each other, or
// both without lines) are one finding, marked with every model that found it. The first model's wording
// leads (the project lists its models in order); the others' are kept with it. One model's own findings
// are never merged with each other: two findings from one model are two findings.

import type { RawComment, RawReport } from "./report.ts";

/** Lines apart that still count as the same place: models point at the same code a line or two differently. */
const LINE_SLACK = 3;
/** At most this many models review a change, and have their reports merged. */
export const MAX_MODELS = 5;

export interface ModelReport {
    /** How people know the model: its name, with its provider when two list the same name. */
    label: string;
    /** Its report, redacted; null when its review failed or was stopped. */
    report: RawReport | null;
    /** Why it has no report, or didn't finish. */
    error?: string | null;
}

/** What another model said about a finding the lead model's wording stands for. */
export interface OtherTake {
    model: string;
    severity?: unknown;
    category?: unknown;
    start_line?: unknown;
    end_line?: unknown;
    content: string;
    suggestion_code?: string | null;
}

const line = (v: unknown): number | null => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
const categoryOf = (c: RawComment) => (typeof c.category === "string" ? c.category.toLowerCase() : "");

function span(c: RawComment): [number, number] | null {
    const start = line(c.start_line);
    if (start === null) return null;
    const end = line(c.end_line);
    return [start, end !== null && end >= start ? end : start];
}

/** How far apart two findings are (0 when their lines overlap), or null when they aren't at the same place. */
export function distance(a: RawComment, b: RawComment): number | null {
    if (a.path !== b.path || categoryOf(a) !== categoryOf(b)) return null;
    const x = span(a);
    const y = span(b);
    if (!x || !y) return !x && !y ? 0 : null;
    const gap = Math.max(0, Math.max(x[0], y[0]) - Math.min(x[1], y[1]));
    return gap <= LINE_SLACK ? gap : null;
}

interface Cluster {
    lead: RawComment;
    models: string[];
    others: OtherTake[];
}

/**
 * The reports of a review run with several models, as one. Its `models` lists those that produced a
 * report, in order; failed models are warnings (`model_failed`), so the review counts as partial.
 */
export function mergeReports(parts: readonly ModelReport[]): RawReport {
    const done = parts.filter((p): p is ModelReport & { report: RawReport } => p.report !== null);
    const lead = done[0]?.report;
    const clusters: Cluster[] = [];
    const byPath = new Map<string, Cluster[]>();
    for (const part of done) {
        for (const c of Array.isArray(part.report.comments) ? part.report.comments : []) {
            // Something in the list that isn't a finding at all can't spoil the other models' findings.
            if (!c || typeof c !== "object" || typeof c.path !== "string") continue;
            let best: Cluster | null = null;
            let bestGap = Number.POSITIVE_INFINITY;
            for (const k of byPath.get(c.path) ?? []) {
                if (k.models.includes(part.label)) continue;
                const gap = distance(k.lead, c);
                if (gap !== null && gap < bestGap) {
                    best = k;
                    bestGap = gap;
                }
            }
            if (best) {
                best.models.push(part.label);
                best.others.push({
                    model: part.label,
                    severity: c.severity,
                    category: c.category,
                    start_line: c.start_line,
                    end_line: c.end_line,
                    content: c.content,
                    suggestion_code: c.suggestion_code ?? null,
                });
                continue;
            }
            const k: Cluster = { lead: c, models: [part.label], others: [] };
            clusters.push(k);
            const same = byPath.get(c.path);
            if (same) same.push(k);
            else byPath.set(c.path, [k]);
        }
    }

    const warnings: unknown[] = [];
    for (const part of done) {
        for (const w of Array.isArray(part.report.warnings) ? part.report.warnings : []) {
            if (!w || typeof w !== "object") continue;
            const x = w as Record<string, unknown>;
            warnings.push({ ...x, message: `${part.label}: ${typeof x.message === "string" ? x.message : ""}` });
        }
    }
    for (const part of parts) {
        if (part.report) continue;
        warnings.push({ type: "model_failed", file: "", model: part.label, message: `${part.label}: ${part.error || "didn't finish"}` });
    }

    const { comments: _c, warnings: _w, ...rest } = lead ?? { comments: [] };
    return {
        ...rest,
        comments: clusters.map((k) => ({ ...k.lead, found_by: k.models, ...(k.others.length ? { also: k.others } : {}) })),
        project_summary: lead?.project_summary ?? "",
        warnings,
        models: done.map((p) => p.label),
        model_summaries: done.slice(1).map((p) => ({ model: p.label, summary: p.report.project_summary ?? "" })),
    };
}

/**
 * Names for a review's models: each one's nickname or name, with its provider when two in the review share
 * that, and a number if they still do, so no two are known by the same label.
 */
export function modelLabels(models: readonly { name?: string | null; model: string; providerName: string }[]): string[] {
    const plain = models.map((m) => m.name ?? m.model);
    const seen = new Map<string, number>();
    return plain
        .map((p, i) => (plain.filter((x) => x === p).length > 1 ? `${p} (${models[i]?.providerName})` : p))
        .map((label) => {
            const n = (seen.get(label) ?? 0) + 1;
            seen.set(label, n);
            return n > 1 ? `${label} #${n}` : label;
        });
}
