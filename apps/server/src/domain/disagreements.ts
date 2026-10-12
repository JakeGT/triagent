// Where the models of a review disagreed, from the branch's report: the same finding rated differently,
// and findings from different models that sit at the same lines but weren't merged (they filed it under
// different kinds of problem, mostly). The second list is where agreement is undercounted: some of those
// pairs are one problem said two ways.

import { type Category, SEVERITIES, type Severity } from "@triagent/shared";
import { LINE_SLACK } from "@triagent/shared/merge";
import { type Issue, priorityCompare } from "./report.ts";

export const MAX_DISAGREEMENTS = 100;

export interface Rating {
    model: string;
    severity: Severity | null;
    category: Category | null;
}

/** One finding several models found, and rated differently. The first rating is the one the finding shows. */
export interface RatedDifferently {
    id: string;
    path: string;
    startLine: number | null;
    title: string;
    ratings: Rating[];
    /** How far apart the ratings are: 1 for high and medium, 3 for critical and low. */
    spread: number;
}

export interface ApartSide {
    id: string;
    title: string;
    severity: Severity;
    category: Category;
    startLine: number;
    endLine: number;
    foundBy: string[];
}

/** Two findings from different models, in the same file and within a few lines of each other, that weren't merged. */
export interface LeftApart {
    path: string;
    /** Lines between them: 0 when they overlap. */
    gap: number;
    a: ApartSide;
    b: ApartSide;
}

export interface Disagreements {
    /** The review's models, or null when it ran with one (then there's nothing to disagree about). */
    models: string[] | null;
    rated: { total: number; items: RatedDifferently[] };
    apart: { total: number; items: LeftApart[] };
}

const rank = (s: Severity | null) => (s === null ? null : SEVERITIES.indexOf(s));

function ratedDifferently(x: Issue): RatedDifferently | null {
    if (!x.foundBy || x.foundBy.length < 2 || !x.alsoFound.length) return null;
    const ratings: Rating[] = [
        { model: x.foundBy[0] as string, severity: x.severity, category: x.category },
        ...x.alsoFound.map((o) => ({ model: o.model, severity: o.severity, category: o.category })),
    ];
    const ranks = ratings.map((r) => rank(r.severity)).filter((r): r is number => r !== null);
    const spread = ranks.length ? Math.max(...ranks) - Math.min(...ranks) : 0;
    return spread > 0 ? { id: x.id, path: x.path, startLine: x.startLine, title: x.title, ratings, spread } : null;
}

const side = (x: Issue): ApartSide => ({
    id: x.id,
    title: x.title,
    severity: x.severity,
    category: x.category,
    startLine: x.startLine as number,
    endLine: x.endLine ?? (x.startLine as number),
    foundBy: [...(x.foundBy ?? [])],
});

/** The disagreements in a report's findings (as the reviewer rated them: corrections made in triage don't count). */
export function disagreements(issues: readonly Issue[], models: readonly string[] | null, limit = MAX_DISAGREEMENTS): Disagreements {
    if (!models || models.length < 2) return { models: null, rated: { total: 0, items: [] }, apart: { total: 0, items: [] } };
    const rated = issues
        .map(ratedDifferently)
        .filter((r): r is RatedDifferently => r !== null)
        .sort((a, b) => b.spread - a.spread || a.path.localeCompare(b.path) || (a.startLine ?? 0) - (b.startLine ?? 0));

    const byPath = new Map<string, Issue[]>();
    for (const x of issues) {
        // Only what a model found, at lines of its own: a finding added by hand, or about a whole file, has no place to be near.
        if (!x.foundBy?.length || x.addedBy || x.startLine === null) continue;
        byPath.set(x.path, [...(byPath.get(x.path) ?? []), x]);
    }
    const apart: (LeftApart & { order: number })[] = [];
    for (const [path, unsorted] of byPath) {
        // In line order, so a finding is only compared with those that start near its end: a file can have thousands.
        const list = [...unsorted].sort((p, q) => (p.startLine as number) - (q.startLine as number) || p.index - q.index);
        for (const [i, x] of list.entries()) {
            const xEnd = x.endLine ?? (x.startLine as number);
            for (let j = i + 1; j < list.length; j++) {
                const y = list[j] as Issue;
                // Everything after starts later still, and so is further off.
                if ((y.startLine as number) - xEnd > LINE_SLACK) break;
                // A model's own findings are never one finding, so two that share a model were never candidates.
                if (x.foundBy?.some((m) => y.foundBy?.includes(m))) continue;
                const [a, b] = [side(x), side(y)];
                const gap = Math.max(0, Math.max(a.startLine, b.startLine) - Math.min(a.endLine, b.endLine));
                if (gap > LINE_SLACK) continue;
                const [first, second] = priorityCompare(x, y) <= 0 ? [a, b] : [b, a];
                apart.push({ path, gap, a: first, b: second, order: Math.min(x.index, y.index) });
            }
        }
    }
    // The closest first, then the most serious: an overlapping pair with a critical in it is the likeliest to matter.
    apart.sort(
        (p, q) =>
            p.gap - q.gap ||
            SEVERITIES.indexOf(p.a.severity) - SEVERITIES.indexOf(q.a.severity) ||
            p.path.localeCompare(q.path) ||
            p.order - q.order,
    );
    return {
        models: [...models],
        rated: { total: rated.length, items: rated.slice(0, limit) },
        apart: { total: apart.length, items: apart.slice(0, limit).map(({ order: _o, ...p }) => p) },
    };
}
