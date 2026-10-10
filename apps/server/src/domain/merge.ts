// Several models' reviews of the same change, as one report for triage. Findings from different models
// at the same place (the same file and category, lines overlapping or within a few of each other, or
// both without lines) are one finding, marked with every model that found it. The first model's wording
// leads (the project lists its models in order); the others' are kept with it. One model's own findings
// are never merged with each other: two findings from one model are two findings.

import { distance, type FindingPair, type FindingRef, groupFindings, joinGroups } from "@triagent/shared/merge";
import type { RawComment, RawReport } from "./report.ts";

export { distance };

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

/** Each model's findings, as the shared grouping takes them (packages/shared/src/merge.ts). */
export const findingsOf = (parts: readonly ModelReport[]) =>
    parts.map((p) => (p.report && Array.isArray(p.report.comments) ? p.report.comments : null));

const take = (model: string, c: RawComment): OtherTake => ({
    model,
    severity: c.severity,
    category: c.category,
    start_line: c.start_line,
    end_line: c.end_line,
    content: c.content,
    suggestion_code: c.suggestion_code ?? null,
});

/**
 * The reports of a review run with several models, as one. Its `models` lists those that produced a
 * report, in order; failed models are warnings (`model_failed`), so the review counts as partial. `same`
 * are pairs of findings a model said are the same problem: they're one finding too.
 */
export function mergeReports(parts: readonly ModelReport[], same: readonly FindingPair[] = []): RawReport {
    const done = parts.filter((p): p is ModelReport & { report: RawReport } => p.report !== null);
    const lead = done[0]?.report;
    const byPlace = groupFindings(findingsOf(parts));
    const groups = same.length ? joinGroups(byPlace, same) : byPlace;
    const comment = (r: FindingRef) => ((parts[r.part] as ModelReport).report as RawReport).comments[r.index] as RawComment;
    const label = (r: FindingRef) => (parts[r.part] as ModelReport).label;
    const comments = groups.map((g) => ({
        ...comment(g[0] as FindingRef),
        found_by: g.map(label),
        ...(g.length > 1 ? { also: g.slice(1).map((r) => take(label(r), comment(r))) } : {}),
    }));

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
        comments,
        project_summary: lead?.project_summary ?? "",
        warnings,
        models: done.map((p) => p.label),
        model_summaries: done.slice(1).map((p) => ({ model: p.label, summary: p.report.project_summary ?? "" })),
    };
}

/**
 * A merged report with one more model's findings added: a model that failed in the review and was run
 * again by itself. What's there keeps its place and wording (so its triage stays with it); the model's
 * findings at the same place as one of them join it, and the rest are added after. Findings added by
 * hand are left alone. Null when the report already has this model's findings.
 */
export function addModel(report: RawReport, label: string, part: RawReport): { report: RawReport; added: number; agreed: number } | null {
    const models = Array.isArray(report.models) ? report.models.filter((m): m is string => typeof m === "string") : [];
    if (models.includes(label)) return null;
    const found = (c: RawComment) => (Array.isArray(c.found_by) ? (c.found_by as unknown[]) : []);
    const comments = report.comments.map((c) => ({ ...c }));
    const before = comments.length;
    let agreed = 0;
    for (const c of Array.isArray(part.comments) ? part.comments : []) {
        if (!c || typeof c !== "object" || typeof c.path !== "string") continue;
        let best: RawComment | null = null;
        let bestGap = Number.POSITIVE_INFINITY;
        // Only what was there before: its own findings, added below, are never joined to each other.
        for (let i = 0; i < before; i++) {
            const k = comments[i] as RawComment;
            if (k.added_by || found(k).includes(label)) continue;
            const gap = distance(k, c);
            if (gap !== null && gap < bestGap) {
                best = k;
                bestGap = gap;
            }
        }
        if (best) {
            best.found_by = [...found(best), label];
            best.also = [...(Array.isArray(best.also) ? best.also : []), take(label, c)];
            agreed++;
        } else comments.push({ ...c, found_by: [label] });
    }
    // It's no longer a model that didn't finish; what its own review couldn't finish is said under its name.
    const warnings: unknown[] = (Array.isArray(report.warnings) ? report.warnings : []).filter((w) => {
        const x = w as { type?: unknown; model?: unknown } | null;
        return !(x && x.type === "model_failed" && x.model === label);
    });
    for (const w of Array.isArray(part.warnings) ? part.warnings : []) {
        if (!w || typeof w !== "object") continue;
        const x = w as Record<string, unknown>;
        warnings.push({ ...x, message: `${label}: ${typeof x.message === "string" ? x.message : ""}` });
    }
    return {
        report: {
            ...report,
            comments,
            warnings,
            models: [...models, label],
            model_summaries: [
                ...(Array.isArray(report.model_summaries) ? report.model_summaries : []),
                { model: label, summary: part.project_summary ?? "" },
            ],
        },
        added: comments.length - before,
        agreed,
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
