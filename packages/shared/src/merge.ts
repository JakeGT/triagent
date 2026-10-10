// Which findings of a review run with several models are the same finding: the part of merging that the
// server (which merges the models' reports, domain/merge.ts) and the runner (which asks a model about the
// pairs the lines and category leave apart) must agree on. Findings are named by where they are: the
// model's place in the review, and the finding's place in that model's list.
//
// Not exported from the package index: it's for Node (the runner and the server), not the web app.

/** Lines apart that still count as the same place: models point at the same code a line or two differently. */
export const LINE_SLACK = 3;
/** At most this many pairs of findings are put to a model in one review. */
export const MAX_JUDGE_PAIRS = 200;

/** What says where a finding is, as OCR writes it. */
export interface Located {
    path: string;
    category?: unknown;
    start_line?: unknown;
    end_line?: unknown;
}

/** One finding of a review: the model's place in the review, and the finding's place in its list. */
export interface FindingRef {
    part: number;
    index: number;
}

/** Two findings from different models that may be the same problem. */
export interface FindingPair {
    a: FindingRef;
    b: FindingRef;
}

const line = (v: unknown): number | null => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
const categoryOf = (c: Located) => (typeof c.category === "string" ? c.category.toLowerCase() : "");

function span(c: Located): [number, number] | null {
    const start = line(c.start_line);
    if (start === null) return null;
    const end = line(c.end_line);
    return [start, end !== null && end >= start ? end : start];
}

/** Lines between two findings (0 when they overlap), or null when either has none. */
function lineGap(a: Located, b: Located): number | null {
    const x = span(a);
    const y = span(b);
    if (!x || !y) return null;
    return Math.max(0, Math.max(x[0], y[0]) - Math.min(x[1], y[1]));
}

/** How far apart two findings are (0 when their lines overlap), or null when they aren't at the same place. */
export function distance(a: Located, b: Located): number | null {
    if (a.path !== b.path || categoryOf(a) !== categoryOf(b)) return null;
    if (!span(a) || !span(b)) return !span(a) && !span(b) ? 0 : null;
    const gap = lineGap(a, b) as number;
    return gap <= LINE_SLACK ? gap : null;
}

/** Each model's findings, in the review's order: null for a model without a report. */
export type PartFindings = readonly (readonly unknown[] | null)[];

/** Something in a model's list that isn't a finding at all can't spoil the others' findings. */
const finding = (c: unknown): Located | null =>
    c && typeof c === "object" && typeof (c as Located).path === "string" ? (c as Located) : null;

const at = (parts: PartFindings, ref: FindingRef): Located | null => finding(parts[ref.part]?.[ref.index]);

/**
 * The findings grouped by place: those from different models in the same file and category, their lines
 * overlapping or within a few of each other (or both without lines), are one group, the first model's
 * leading. One model's own findings are never grouped with each other.
 */
export function groupFindings(parts: PartFindings): FindingRef[][] {
    const groups: FindingRef[][] = [];
    const byPath = new Map<string, FindingRef[][]>();
    for (const [part, comments] of parts.entries()) {
        for (const [index, raw] of (Array.isArray(comments) ? comments : []).entries()) {
            const c = finding(raw);
            if (!c) continue;
            let best: FindingRef[] | null = null;
            let bestGap = Number.POSITIVE_INFINITY;
            for (const g of byPath.get(c.path) ?? []) {
                if (g.some((r) => r.part === part)) continue;
                const gap = distance(at(parts, g[0] as FindingRef) as Located, c);
                if (gap !== null && gap < bestGap) {
                    best = g;
                    bestGap = gap;
                }
            }
            if (best) {
                best.push({ part, index });
                continue;
            }
            const g = [{ part, index }];
            groups.push(g);
            const same = byPath.get(c.path);
            if (same) same.push(g);
            else byPath.set(c.path, [g]);
        }
    }
    return groups;
}

/**
 * The pairs worth asking a model about: two groups in the same file that no model is in both of, each
 * stood for by its leading finding. The closest in lines first; past `max`, the rest aren't asked
 * (`total` says how many there were).
 */
export function candidatePairs(parts: PartFindings, max = MAX_JUDGE_PAIRS): { pairs: FindingPair[]; total: number } {
    const byPath = new Map<string, FindingRef[][]>();
    for (const g of groupFindings(parts)) {
        const path = (at(parts, g[0] as FindingRef) as Located).path;
        byPath.set(path, [...(byPath.get(path) ?? []), g]);
    }
    const found: { pair: FindingPair; gap: number }[] = [];
    for (const groups of byPath.values()) {
        for (const [i, x] of groups.entries()) {
            const a = at(parts, x[0] as FindingRef) as Located;
            for (const y of groups.slice(i + 1)) {
                if (x.some((r) => y.some((s) => s.part === r.part))) continue;
                const b = at(parts, y[0] as FindingRef) as Located;
                // Findings without lines are about the file as a whole: asked about after those with lines to compare.
                found.push({ pair: { a: x[0] as FindingRef, b: y[0] as FindingRef }, gap: lineGap(a, b) ?? Number.MAX_SAFE_INTEGER });
            }
        }
    }
    // A stable sort: pairs as far apart as each other stay in the review's order.
    found.sort((p, q) => p.gap - q.gap);
    return { pairs: found.slice(0, max).map((f) => f.pair), total: found.length };
}

const keyOf = (r: FindingRef) => `${r.part}:${r.index}`;

/** Whether two pairs name the same two findings. */
export const samePair = (p: FindingPair, q: FindingPair) => keyOf(p.a) === keyOf(q.a) && keyOf(p.b) === keyOf(q.b);

/**
 * The groups with those a model said are the same problem (`same`) joined, in the order given. Two
 * groups that have a model in common by then stay apart: one model's findings are never one finding.
 */
export function joinGroups(groups: readonly FindingRef[][], same: readonly FindingPair[]): FindingRef[][] {
    const out = groups.map((g) => [...g]);
    const groupOf = new Map<string, FindingRef[]>();
    for (const g of out) for (const r of g) groupOf.set(keyOf(r), g);
    for (const pair of same) {
        const x = groupOf.get(keyOf(pair.a));
        const y = groupOf.get(keyOf(pair.b));
        if (!x || !y || x === y || x.some((r) => y.some((s) => s.part === r.part))) continue;
        // The earlier group keeps its place and its lead; the other's findings join it, in the review's order.
        const [to, from] = out.indexOf(x) < out.indexOf(y) ? [x, y] : [y, x];
        const lead = to[0] as FindingRef;
        const rest = [...to.slice(1), ...from].sort((p, q) => p.part - q.part || p.index - q.index);
        to.splice(0, to.length, lead, ...rest);
        for (const r of from) groupOf.set(keyOf(r), to);
        out.splice(out.indexOf(from), 1);
    }
    return out;
}
