// Comparing models: what a review run only to compare them (its `bakeOff` option) keeps instead of a
// report on a branch. Each model's own figures, how much they found in common, and the findings
// themselves with who found each, so the page can show what only one model saw.

import { SEVERITIES, type Severity } from "@triagent/shared";
import { lineOf, type RawComment, type RawReport, titleOf } from "./report.ts";

/** The most findings kept with a comparison, and of each one's text: a full scan with five models can have thousands. */
export const MAX_COMPARED = 500;
const MAX_TEXT = 1500;

type Tokens = { input: number; output: number; cacheRead: number; total: number };

export interface ComparedModel {
    label: string;
    provider: string;
    model: string;
    status: "done" | "partial" | "failed" | "cancelled";
    /** Its own findings; null when it didn't finish. */
    total: number | null;
    /** Of those: the ones no other model found, and the ones another did. */
    unique: number | null;
    shared: number | null;
    bySeverity: Record<Severity, number> | null;
    tokens: Tokens | null;
    seconds: number | null;
    error: string | null;
}

export interface ComparedFinding {
    path: string;
    startLine: number | null;
    endLine: number | null;
    severity: Severity;
    category: string;
    title: string;
    content: string;
    /** The models that found it, the first one's wording leading. */
    foundBy: string[];
}

export interface BakeOff {
    models: ComparedModel[];
    /** `overlap[i][j]`: findings both model i and model j found (their place in `models`); on the diagonal, model i's own. */
    overlap: number[][];
    /** Findings once merged, and how many of them more than one model found. */
    total: number;
    agreed: number;
    /** The findings, most models agreeing first; at most MAX_COMPARED of them (`truncated` when there were more). */
    findings: ComparedFinding[];
    truncated: boolean;
}

export interface ComparedPart {
    label: string;
    provider: string;
    model: string;
    status: ComparedModel["status"];
    /** Whether its findings are in the merged report. */
    finished: boolean;
    tokens: Tokens | null;
    seconds: number | null;
    error: string | null;
}

const found = (c: RawComment): string[] => (Array.isArray(c.found_by) ? c.found_by.filter((m): m is string => typeof m === "string") : []);
const severity = (c: RawComment): Severity => ((SEVERITIES as readonly unknown[]).includes(c.severity) ? (c.severity as Severity) : "low");

/**
 * The comparison of a review's models, from how each went and their merged report (domain/merge.ts):
 * a merged finding is one each model in its `found_by` found.
 */
export function compareModels(parts: readonly ComparedPart[], merged: RawReport): BakeOff {
    const comments = merged.comments.filter((c) => c && typeof c === "object" && typeof c.path === "string");
    const by = comments.map(found);
    const models: ComparedModel[] = parts.map((p) => {
        const own = comments.filter((_c, i) => by[i]?.includes(p.label));
        const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
        for (const c of own) bySeverity[severity(c)]++;
        const unique = own.filter((c) => found(c).length === 1).length;
        return {
            label: p.label,
            provider: p.provider,
            model: p.model,
            status: p.status,
            total: p.finished ? own.length : null,
            unique: p.finished ? unique : null,
            shared: p.finished ? own.length - unique : null,
            bySeverity: p.finished ? bySeverity : null,
            tokens: p.tokens,
            seconds: p.seconds,
            error: p.error,
        };
    });
    const overlap = parts.map((a) => parts.map((b) => by.filter((m) => m.includes(a.label) && m.includes(b.label)).length));
    // Most agreed on first, then as the merged report has them.
    const order = comments.map((_c, i) => i).sort((i, j) => (by[j]?.length ?? 0) - (by[i]?.length ?? 0) || i - j);
    return {
        models,
        overlap,
        total: comments.length,
        agreed: by.filter((m) => m.length > 1).length,
        findings: order.slice(0, MAX_COMPARED).map((i) => {
            const c = comments[i] as RawComment;
            return {
                path: c.path.slice(0, 500),
                startLine: lineOf(c.start_line),
                endLine: lineOf(c.end_line),
                severity: severity(c),
                category: typeof c.category === "string" ? c.category.slice(0, 40) : "other",
                title: titleOf(String(c.content ?? "")),
                content: String(c.content ?? "").slice(0, MAX_TEXT),
                foundBy: by[i] ?? [],
            };
        }),
        truncated: comments.length > MAX_COMPARED,
    };
}
