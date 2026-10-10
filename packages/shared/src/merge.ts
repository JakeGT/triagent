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

/** Lines between two findings' lines (0 when they overlap). */
const between = (x: readonly [number, number], y: readonly [number, number]) => Math.max(0, Math.max(x[0], y[0]) - Math.min(x[1], y[1]));

/** How far apart two findings are (0 when their lines overlap), or null when they aren't at the same place. */
export function distance(a: Located, b: Located): number | null {
    if (a.path !== b.path || categoryOf(a) !== categoryOf(b)) return null;
    const x = span(a);
    const y = span(b);
    if (!x || !y) return !x && !y ? 0 : null;
    const gap = between(x, y);
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

/** A group as pairing sees it: its leading finding, that finding's lines, and the models in it. */
interface Lead {
    ref: FindingRef;
    span: [number, number] | null;
    models: number[];
}

const share = (x: Lead, y: Lead) => x.models.some((m) => y.models.includes(m));

/** How many pairs of `groups` have no model in both: counted from how many groups each set of models has, not pair by pair. */
function pairsIn(groups: readonly Lead[]): number {
    const sets = new Map<string, { of: Lead; count: number }>();
    for (const g of groups) {
        const key = [...g.models].sort((p, q) => p - q).join(",");
        const set = sets.get(key);
        if (set) set.count++;
        else sets.set(key, { of: g, count: 1 });
    }
    const all = [...sets.values()];
    let n = 0;
    for (const [i, x] of all.entries()) for (const y of all.slice(i + 1)) if (!share(x.of, y.of)) n += x.count * y.count;
    return n;
}

/**
 * The pairs worth asking a model about: two groups in the same file that no model is in both of, each
 * stood for by its leading finding. The closest in lines first; past `max`, the rest aren't asked
 * (`total` says how many there were).
 *
 * A file can have thousands of findings, so the pairs are never all held: only the closest `max` so
 * far (up to twice that between sorts), and a pair no closer than the furthest of those is passed over.
 */
export function candidatePairs(parts: PartFindings, max = MAX_JUDGE_PAIRS): { pairs: FindingPair[]; total: number } {
    const byPath = new Map<string, Lead[]>();
    for (const g of groupFindings(parts)) {
        const first = g[0] as FindingRef;
        const c = at(parts, first) as Located;
        const lead = { ref: first, span: span(c), models: g.map((r) => r.part) };
        const list = byPath.get(c.path);
        if (list) list.push(lead);
        else byPath.set(c.path, [lead]);
    }
    let total = 0;
    let found: { pair: FindingPair; gap: number; nth: number }[] = [];
    // Once `max` are held, the gap of the furthest: a later pair must be closer than that to be asked about.
    let furthest = Number.POSITIVE_INFINITY;
    let nth = 0;
    const closest = () => {
        // Pairs as far apart as each other stay in the review's order.
        found.sort((p, q) => p.gap - q.gap || p.nth - q.nth);
        found = found.slice(0, max);
        if (found.length >= max) furthest = found.at(-1)?.gap ?? 0;
    };
    for (const groups of byPath.values()) {
        total += pairsIn(groups);
        for (const [i, x] of groups.entries()) {
            // Nothing is closer than overlapping.
            if (furthest === 0) break;
            for (let j = i + 1; j < groups.length; j++) {
                const y = groups[j] as Lead;
                // Findings without lines are about the file as a whole: asked about after those with lines to compare.
                const gap = x.span && y.span ? between(x.span, y.span) : Number.MAX_SAFE_INTEGER;
                if (gap >= furthest || share(x, y)) continue;
                found.push({ pair: { a: x.ref, b: y.ref }, gap, nth: nth++ });
                if (found.length >= max * 2) closest();
            }
        }
    }
    closest();
    return { pairs: found.map((f) => f.pair), total };
}

const keyOf = (r: FindingRef) => `${r.part}:${r.index}`;

/**
 * Whether two pairs name the same two findings the same way round. A pair is always written as
 * `candidatePairs` gives it (the runner sends back the ones it was given), so the other way round is
 * not the same pair: the server refuses it like any other it didn't ask about.
 */
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
