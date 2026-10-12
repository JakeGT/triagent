// Analytics: what the reviews did (runs and uploads: outcomes, time, tokens, cost, how the model behaved)
// and what people and agents did with the findings (backlog, throughput, ratings).
//
// Pure: the service reads the rows (review history, the activity log and the current reports) and this
// works through each list once. Figures a review didn't record are counted as "not recorded" rather than
// as zero, so a missing measurement never looks like a good one.

import { DONE_STATUSES, SEVERITIES, type Severity, type Status, type Via } from "@triagent/shared";
import type { ActivityRow, FindingSource, ReviewRecord } from "../store/types.ts";

export const ANALYTICS_DAYS = [7, 30, 90, 365, 0] as const;
export type AnalyticsDays = (typeof ANALYTICS_DAYS)[number];

const DAY = 86_400_000;
const HOUR = 3_600_000;
const AGENT_VIAS: ReadonlySet<Via> = new Set(["token", "mcp"]);
const UNKNOWN_MODEL = "(model not recorded)";

/** US$ per million tokens. */
export interface Price {
    input: number;
    output: number;
    /** Cache reads; charged at the input price when not set. */
    cacheRead: number | null;
}

export interface PricedModel extends Price {
    source: "workspace" | "instance" | "openrouter";
}

/** A finding in a current report, with its triage. */
export interface CurrentFinding {
    projectId: string;
    branch: string;
    id: string;
    path: string;
    severity: Severity;
    category: string;
    status: Status;
    assignee: string | null;
    needsDiscussion: boolean;
}

export interface AnalyticsInput {
    now: number;
    days: AnalyticsDays;
    /** Only this branch, or every branch. */
    branch: string | null;
    /** Every review recorded for the projects in scope (all branches, all time, so first sightings are known). */
    history: readonly ReviewRecord[];
    /** The activity log for the scope, from the start of the range. */
    activity: readonly ActivityRow[];
    /** Findings in the current reports of the branches in scope. */
    current: readonly CurrentFinding[];
    /** Which model reported which finding, and what became of it (every one for the projects in scope). */
    sources?: readonly FindingSource[];
    /** Only these parts of the answer are worked out (all of them, when absent). */
    sections?: ReadonlySet<AnalyticsSection>;
    price(model: string): PricedModel | null;
    projectSlug(projectId: string | null): string | null;
}

export const ANALYTICS_SECTIONS = ["reviews", "findings", "triage", "performance", "models"] as const;
export type AnalyticsSection = (typeof ANALYTICS_SECTIONS)[number];

// ---- small helpers ------------------------------------------------------------------------

export function quantile(values: readonly number[], q: number): number | null {
    const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!xs.length) return null;
    const i = (xs.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return (xs[lo] as number) + ((xs[hi] as number) - (xs[lo] as number)) * (i - lo);
}

const median = (xs: readonly number[]) => quantile(xs, 0.5);
const ratio = (a: number, b: number) => (b ? a / b : null);
const zeroes = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
const isSeverity = (v: unknown): v is Severity => (SEVERITIES as readonly unknown[]).includes(v);

/**
 * US$ for a review's tokens. Input tokens include cache reads (as OpenAI-compatible APIs count them), so
 * cache reads are charged at their own price and the rest of the input at the input price.
 */
export function costOf(tokens: ReviewRecord["tokens"], price: Price | null): number | null {
    if (!tokens || !price) return null;
    const cache = Math.min(tokens.cacheRead, tokens.input);
    return ((tokens.input - cache) * price.input + cache * (price.cacheRead ?? price.input) + tokens.output * price.output) / 1e6;
}

/** "src/server/" for src/server/a/b.ts: the first two folders. */
export function folderOf(path: string): string {
    const parts = path.split("/");
    if (parts.length > 2) return `${parts.slice(0, 2).join("/")}/`;
    if (parts.length === 2) return `${parts[0]}/`;
    return "(top level)";
}

export interface Range {
    days: AnalyticsDays;
    from: string;
    to: string;
    unit: "day" | "week";
    /** The start of each bucket (YYYY-MM-DD, UTC). */
    buckets: string[];
}

const startOfDay = (t: number) => Math.floor(t / DAY) * DAY;
/** Monday of the week (UTC). */
const startOfWeek = (t: number) => {
    const d = startOfDay(t);
    return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY;
};

/** Where the range starts, before the data is read: null for all time. */
export function rangeStart(days: AnalyticsDays, now: number): number | null {
    return days > 0 ? startOfDay(now - (days - 1) * DAY) : null;
}

/** Days for ranges up to a month, weeks beyond. */
export function rangeOf(
    days: AnalyticsDays,
    now: number,
    earliest: number | null,
): Range & { start: number; key(at: string): string | null } {
    const start = rangeStart(days, now) ?? startOfDay(Math.min(now, earliest ?? now));
    const unit = now - start > 31 * DAY ? "week" : "day";
    const floor = unit === "week" ? startOfWeek : startOfDay;
    const step = unit === "week" ? 7 * DAY : DAY;
    const buckets: string[] = [];
    for (let t = floor(start); t <= now; t += step) buckets.push(new Date(t).toISOString().slice(0, 10));
    return {
        days,
        from: new Date(start).toISOString(),
        to: new Date(now).toISOString(),
        unit,
        buckets,
        start,
        key: (at) => {
            const t = Date.parse(at);
            return Number.isFinite(t) ? new Date(floor(t)).toISOString().slice(0, 10) : null;
        },
    };
}

// ---- the result --------------------------------------------------------------------------

export interface ReviewGroup {
    key: string;
    reviews: number;
    done: number;
    partial: number;
    failed: number;
    cancelled: number;
    tokens: number;
    /** Null when none of the group's reviews has a price. */
    cost: number | null;
    findings: number;
    medianRunSeconds: number | null;
    costPerFinding: number | null;
}

export interface HotspotRow extends Record<Severity, number> {
    key: string;
    open: number;
}

export interface PersonRow {
    actor: string;
    /** Acting through an API token or MCP. */
    agent: boolean;
    via: Via[];
    resolved: number;
    wontFix: number;
    reopened: number;
    notes: number;
    corrections: number;
    claims: number;
    releases: number;
    flags: number;
    lastAt: string;
}

export function analyse(input: AnalyticsInput) {
    const { now, branch } = input;
    const inBranch = (b: string | null) => !branch || b === branch;

    // When OCR first reported each finding (on any branch of its project), and the severity it gave it.
    const firstSeen = new Map<string, number>();
    const reportedSeverity = new Map<string, Severity>();
    let earliest: number | null = null;
    for (const r of input.history) {
        const t = Date.parse(r.at);
        if (!Number.isFinite(t)) continue;
        if (inBranch(r.branch) && (earliest === null || t < earliest)) earliest = t;
        for (const [sev, ids] of Object.entries(r.details.addedIds ?? {})) {
            if (!isSeverity(sev) || !Array.isArray(ids)) continue;
            for (const id of ids) {
                const k = `${r.projectId}:${id}`;
                const seen = firstSeen.get(k);
                if (seen === undefined || t < seen) {
                    firstSeen.set(k, t);
                    reportedSeverity.set(k, sev);
                }
            }
        }
    }
    for (const e of input.activity) {
        if (!inBranch(e.branch)) continue;
        const t = Date.parse(e.at);
        if (Number.isFinite(t) && (earliest === null || t < earliest)) earliest = t;
    }
    const range = rangeOf(input.days, now, earliest);
    const inRange = (at: string) => {
        const t = Date.parse(at);
        return Number.isFinite(t) && t >= range.start && t <= now;
    };
    const reviews = input.history.filter((r) => inBranch(r.branch) && inRange(r.at));
    const events = input.activity.filter((e) => inBranch(e.branch) && inRange(e.at));

    const currentSeverity = new Map<string, Severity>();
    for (const x of input.current) currentSeverity.set(`${x.projectId}:${x.id}`, x.severity);
    const severityOf = (k: string) => currentSeverity.get(k) ?? reportedSeverity.get(k) ?? null;

    const wanted = (s: AnalyticsSection) => !input.sections || input.sections.has(s);
    // Worked out whichever parts are asked for: which models have no price comes from it, and every part says so.
    const { section: reviewSection, unpriced } = reviewsSection(reviews, range, input);
    return {
        range: { days: range.days, from: range.from, to: range.to, unit: range.unit, buckets: range.buckets },
        ...(wanted("reviews") ? { reviews: reviewSection } : {}),
        ...(wanted("findings") ? { findings: findingsSection(events, input.current, range, firstSeen, now) } : {}),
        ...(wanted("triage") ? { triage: triageSection(events, range, firstSeen, severityOf, now) } : {}),
        // How reviews went: not the model a review asked about its findings afterwards.
        ...(wanted("performance") ? { performance: performanceSection(reviews.filter((r) => !r.details.merging)) } : {}),
        ...(wanted("models")
            ? {
                  models: modelsSection(
                      reviews.filter((r) => !r.details.merging),
                      input.history,
                      (input.sources ?? []).filter((s) => inBranch(s.branch)),
                      range,
                      input,
                  ),
              }
            : {}),
        unpriced,
    };
}

export type AnalyticsResult = ReturnType<typeof analyse>;

// ---- reviews -------------------------------------------------------------------------------

/**
 * Reviews as people count them: a review run with several models (records sharing `details.scan`) as
 * one, with the scan's outcome and merged findings, its models' tokens, costs and time added up.
 */
export function scans(recs: readonly ReviewRecord[], costs: ReadonlyMap<string, number | null>) {
    /** `complete`: every model of it that used tokens has a price, so its cost is all of what it cost. */
    const out: { r: ReviewRecord; cost: number | null; complete: boolean }[] = [];
    const byScan = new Map<string, ReviewRecord[]>();
    for (const r of recs) {
        const id = r.details.scan?.id;
        if (!id) out.push({ r, cost: costs.get(r.id) ?? null, complete: (costs.get(r.id) ?? null) !== null });
        else byScan.set(id, [...(byScan.get(id) ?? []), r]);
    }
    for (const [id, group] of byScan) {
        const lead = group.find((r) => r.details.scan?.lead) ?? (group[0] as ReviewRecord);
        const scan = lead.details.scan as NonNullable<ReviewRecord["details"]["scan"]>;
        const known = group.map((r) => r.tokens).filter((t): t is NonNullable<ReviewRecord["tokens"]> => t !== null);
        const priced = group.map((r) => costs.get(r.id) ?? null).filter((c): c is number => c !== null);
        // Its models ran at once, so the review took from its start to its end, not their times added up. A model
        // run again later (an attempt) took its own time on top. A record from before reviews said when they started
        // has only the models' own times to add.
        // Every model's record carries the review's own start and end. A model run again carries its own, so
        // it's never the one read, even where the range holds no record of the review but that.
        const whole = lead.details.attempt ? group.find((r) => !r.details.attempt) : lead;
        const began = Date.parse(whole?.details.startedAt ?? "");
        const ended = Date.parse(whole?.at ?? "");
        const again = group.filter((r) => r.details.attempt).reduce((n, r) => n + (r.details.runSeconds ?? 0), 0);
        const wall = Number.isFinite(began) && Number.isFinite(ended) && ended >= began ? Math.round((ended - began) / 1000) + again : null;
        out.push({
            r: {
                ...lead,
                id,
                status: scan.status,
                model: scan.models.join(" + "),
                tokens: known.length
                    ? known.reduce((a, t) => ({
                          input: a.input + t.input,
                          output: a.output + t.output,
                          cacheRead: a.cacheRead + t.cacheRead,
                          total: a.total + t.total,
                      }))
                    : null,
                details: {
                    ...lead.details,
                    // Only a time some model recorded: none at all isn't a run of 0 seconds.
                    ...(group.some((r) => r.details.runSeconds !== undefined)
                        ? { runSeconds: wall ?? group.reduce((n, r) => n + (r.details.runSeconds ?? 0), 0) }
                        : {}),
                    ...(scan.findings !== null
                        ? { findings: { ...(lead.details.findings ?? { bySeverity: zeroes() }), total: scan.findings } }
                        : {}),
                },
            },
            cost: priced.length ? priced.reduce((a, b) => a + b, 0) : null,
            complete: priced.length > 0 && group.every((r) => !r.tokens?.total || (costs.get(r.id) ?? null) !== null),
        });
    }
    return out;
}

function reviewsSection(recs: readonly ReviewRecord[], range: ReturnType<typeof rangeOf>, input: AnalyticsInput) {
    const series = range.buckets.map((date) => ({ date, done: 0, partial: 0, failed: 0, cancelled: 0, tokens: 0, cost: 0 }));
    const byDate = new Map(series.map((d) => [d.date, d]));
    const byStatus = { done: 0, partial: 0, failed: 0, cancelled: 0 };
    // `estimated`: reviews whose tokens are the budget they were given, not a figure from OCR (they ended without one).
    const tokens = { total: 0, input: 0, output: 0, cacheRead: 0, recorded: 0, estimated: 0, estimatedTotal: 0 };
    const runSeconds: number[] = [];
    const queueSeconds: number[] = [];
    const unpriced = new Map<string, { model: string; reviews: number; tokens: number }>();
    const groups = { model: new Map<string, ReviewGroup>(), kind: new Map<string, ReviewGroup>() };
    const runTimes = { model: new Map<string, number[]>(), kind: new Map<string, number[]>() };
    const prs = new Map<string, number>();
    let runs = 0;
    let cost = 0;
    // Averages (a review, a pull request, a finding) are over the reviews whose whole cost is known: one with
    // a model that has no price cost more than its figure says, so it would pull them down.
    let wholeCost = 0;
    let priced = 0;
    let pricedFindings = 0;
    let findings = 0;
    const costs = new Map<string, number | null>();
    const partly = new Set<string>();
    const kindWhole = new Map<string, { cost: number; findings: number }>();

    const group = (which: "model" | "kind", key: string): ReviewGroup => {
        let g = groups[which].get(key);
        if (!g) {
            g = {
                key,
                reviews: 0,
                done: 0,
                partial: 0,
                failed: 0,
                cancelled: 0,
                tokens: 0,
                cost: null,
                findings: 0,
                medianRunSeconds: null,
                costPerFinding: null,
            };
            groups[which].set(key, g);
        }
        return g;
    };

    // Each model's own record: tokens, cost and the by-model comparison.
    for (const r of recs) {
        const price = r.model ? input.price(r.model) : null;
        const c = costOf(r.tokens, price);
        costs.set(r.id, c);
        const found = r.status === "done" || r.status === "partial" ? (r.details.findings?.total ?? 0) : 0;
        if (r.tokens) {
            tokens.total += r.tokens.total;
            tokens.input += r.tokens.input;
            tokens.output += r.tokens.output;
            tokens.cacheRead += r.tokens.cacheRead;
            tokens.recorded++;
            if (r.details.estimatedTokens) {
                tokens.estimated++;
                tokens.estimatedTotal += r.tokens.total;
            }
        }
        if (c === null && r.tokens?.total) {
            const model = r.model ?? UNKNOWN_MODEL;
            const u = unpriced.get(model) ?? { model, reviews: 0, tokens: 0 };
            u.reviews++;
            u.tokens += r.tokens.total;
            unpriced.set(model, u);
        }
        // A model asked which findings are the same problem isn't a review by that model: it's counted as merging.
        const key = r.details.merging ? `merging (${r.model ?? UNKNOWN_MODEL})` : (r.model ?? UNKNOWN_MODEL);
        const g = group("model", key);
        g.reviews++;
        g[r.status]++;
        g.tokens += r.tokens?.total ?? 0;
        g.findings += found;
        if (c !== null) g.cost = (g.cost ?? 0) + c;
        if ((r.status === "done" || r.status === "partial") && r.details.runSeconds !== undefined) {
            const list = runTimes.model.get(key) ?? [];
            list.push(r.details.runSeconds);
            runTimes.model.set(key, list);
        }
    }

    // Each review once: a review run with several models is one scan, however many records it has.
    // Reviews as people count them (a run with several models is one), merged once.
    const merged = scans(recs, costs);
    for (const { r, cost: c, complete } of merged) {
        const found = r.status === "done" || r.status === "partial" ? (r.details.findings?.total ?? 0) : 0;
        byStatus[r.status]++;
        if (r.source === "run") runs++;
        findings += found;
        if (c !== null) cost += c;
        if (c !== null && !complete) partly.add(r.id);
        if (c !== null && complete) {
            wholeCost += c;
            priced++;
            pricedFindings += found;
            const ofKind = kindWhole.get(r.kind) ?? { cost: 0, findings: 0 };
            ofKind.cost += c;
            ofKind.findings += found;
            kindWhole.set(r.kind, ofKind);
            if (r.kind === "pr" && r.details.prNumber !== undefined) {
                const k = `${r.projectId}:${r.details.prNumber}`;
                prs.set(k, (prs.get(k) ?? 0) + c);
            }
        }
        const finished = r.status === "done" || r.status === "partial";
        if (finished && r.details.runSeconds !== undefined) runSeconds.push(r.details.runSeconds);
        if (r.details.queueSeconds !== undefined) queueSeconds.push(r.details.queueSeconds);

        const g = group("kind", r.kind);
        g.reviews++;
        g[r.status]++;
        g.tokens += r.tokens?.total ?? 0;
        g.findings += found;
        if (c !== null) g.cost = (g.cost ?? 0) + c;
        if (finished && r.details.runSeconds !== undefined) {
            const list = runTimes.kind.get(r.kind) ?? [];
            list.push(r.details.runSeconds);
            runTimes.kind.set(r.kind, list);
        }

        const d = byDate.get(range.key(r.at) ?? "");
        if (d) {
            d[r.status]++;
            d.tokens += r.tokens?.total ?? 0;
            d.cost += c ?? 0;
        }
        costs.set(r.id, c);
    }

    const perFinding = (which: "model" | "kind", g: ReviewGroup) => {
        if (which === "model") return g.cost !== null && g.findings ? g.cost / g.findings : null;
        const whole = kindWhole.get(g.key);
        return whole?.findings ? whole.cost / whole.findings : null;
    };
    const finish = (which: "model" | "kind") =>
        [...groups[which].values()]
            .map((g) => ({
                ...g,
                medianRunSeconds: median(runTimes[which].get(g.key) ?? []),
                costPerFinding: perFinding(which, g),
            }))
            .sort((a, b) => b.reviews - a.reviews || a.key.localeCompare(b.key));

    const prCosts = [...prs.values()];
    const latest = merged
        .map((x) => x.r)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 15)
        .map((r) => ({
            id: r.id,
            at: r.at,
            project: input.projectSlug(r.projectId),
            branch: r.branch,
            kind: r.kind,
            source: r.source,
            status: r.status,
            model: r.model,
            prNumber: r.details.prNumber ?? null,
            requestedBy: r.details.requestedBy ?? null,
            runSeconds: r.details.runSeconds ?? null,
            tokens: r.tokens?.total ?? null,
            tokensEstimated: Boolean(r.details.estimatedTokens),
            cost: costs.get(r.id) ?? null,
            /** Some of its models have no price: it cost more than `cost`. */
            costPartial: partly.has(r.id),
            findings: r.details.findings?.total ?? null,
            /** The run it was, for one run on the server since runs said (its page has each model side by side). */
            runId: r.source === "run" ? (r.details.scan?.id ?? r.details.jobId ?? null) : null,
        }));

    return {
        section: {
            total: byStatus.done + byStatus.partial + byStatus.failed + byStatus.cancelled,
            byStatus,
            runs,
            uploads: byStatus.done + byStatus.partial + byStatus.failed + byStatus.cancelled - runs,
            runSeconds: { median: median(runSeconds), p90: quantile(runSeconds, 0.9), recorded: runSeconds.length },
            queueSeconds: { median: median(queueSeconds), p90: quantile(queueSeconds, 0.9), recorded: queueSeconds.length },
            tokens,
            findings,
            cost: {
                total: priced || partly.size ? cost : null,
                pricedReviews: priced,
                /** Reviews with a price for some of their models only: their known cost is in `total`, and in no average. */
                partlyPriced: partly.size,
                perReview: priced ? wholeCost / priced : null,
                perPr: prCosts.length ? prCosts.reduce((a, b) => a + b, 0) / prCosts.length : null,
                prs: prCosts.length,
                perFinding: pricedFindings ? wholeCost / pricedFindings : null,
            },
            series,
            byModel: finish("model"),
            byKind: finish("kind"),
            latest,
        },
        unpriced: [...unpriced.values()].sort((a, b) => b.tokens - a.tokens),
    };
}

// ---- findings and backlog ---------------------------------------------------------------------

interface Change<T> {
    from: T;
    to: T;
}
const changeOf = <T>(v: unknown): Change<T> | null => (v && typeof v === "object" && "to" in v ? (v as Change<T>) : null);
const isDone = (s: unknown) => DONE_STATUSES.has(s as Status);

function findingsSection(
    events: readonly ActivityRow[],
    current: readonly CurrentFinding[],
    range: ReturnType<typeof rangeOf>,
    firstSeen: ReadonlyMap<string, number>,
    now: number,
) {
    const series = range.buckets.map((date) => ({ date, added: 0, closed: 0, reopened: 0 }));
    const byDate = new Map(series.map((d) => [d.date, d]));
    const totals = { added: 0, removed: 0, resolved: 0, wontFix: 0, reopenedByReview: 0, reopenedByPeople: 0, duplicates: 0, flagged: 0 };
    const severityChanges = new Map<string, { from: string; to: string; n: number }>();
    let categoryCorrections = 0;

    for (const e of events) {
        const d = byDate.get(range.key(e.at) ?? "");
        const c = e.changes;
        if (e.kind === "report") {
            const up = c.uploaded as { added?: number; removed?: number } | undefined;
            if (!up) continue;
            totals.added += up.added ?? 0;
            totals.removed += up.removed ?? 0;
            if (d) d.added += up.added ?? 0;
            continue;
        }
        if (e.kind !== "issue") continue;
        const st = changeOf<Status>(c.status);
        if (st && !isDone(st.from) && isDone(st.to)) {
            if (st.to === "resolved") totals.resolved++;
            else totals.wontFix++;
            if (d) d.closed++;
        } else if (st && isDone(st.from) && !isDone(st.to)) {
            if (c.reopened) totals.reopenedByReview++;
            else totals.reopenedByPeople++;
            if (d) d.reopened++;
        }
        const sev = changeOf<Severity | null>(c.severity);
        if (sev?.to) {
            const k = `${sev.from ?? "reviewer"}→${sev.to}`;
            const row = severityChanges.get(k) ?? { from: sev.from ?? "reviewer", to: sev.to, n: 0 };
            row.n++;
            severityChanges.set(k, row);
        }
        if (changeOf(c.category)?.to) categoryCorrections++;
        if (changeOf(c.duplicateOf)?.to) totals.duplicates++;
        if (changeOf(c.needsDiscussion)?.to === true) totals.flagged++;
    }

    const open = current.filter((x) => !isDone(x.status));
    const openBySeverity = zeroes();
    const age = { under7: 0, under30: 0, under90: 0, older: 0, notRecorded: 0 };
    const tallies = {
        folders: new Map<string, HotspotRow>(),
        files: new Map<string, HotspotRow>(),
        categories: new Map<string, HotspotRow>(),
    };
    for (const x of open) {
        openBySeverity[x.severity]++;
        const seen = firstSeen.get(`${x.projectId}:${x.id}`);
        if (seen === undefined) age.notRecorded++;
        else {
            const days = (now - seen) / DAY;
            if (days < 7) age.under7++;
            else if (days < 30) age.under30++;
            else if (days < 90) age.under90++;
            else age.older++;
        }
        for (const [which, key] of [
            ["folders", folderOf(x.path)],
            ["files", x.path],
            ["categories", x.category],
        ] as const) {
            const row = tallies[which].get(key) ?? { key, open: 0, ...zeroes() };
            row.open++;
            row[x.severity]++;
            tallies[which].set(key, row);
        }
    }
    const top = (m: Map<string, HotspotRow>) =>
        [...m.values()]
            .sort((a, b) => b.critical - a.critical || b.high - a.high || b.open - a.open || a.key.localeCompare(b.key))
            .slice(0, 10);
    const closed = totals.resolved + totals.wontFix;
    const severityCorrections = [...severityChanges.values()].sort((a, b) => b.n - a.n);

    return {
        open: open.length,
        inProgress: open.filter((x) => x.status === "in_progress").length,
        unassigned: open.filter((x) => !x.assignee).length,
        needsDiscussion: open.filter((x) => x.needsDiscussion).length,
        openBySeverity,
        age,
        ...totals,
        closed,
        wontFixRate: ratio(totals.wontFix, closed),
        corrections: {
            severity: severityCorrections.reduce((n, r) => n + r.n, 0),
            category: categoryCorrections,
            severityChanges: severityCorrections,
        },
        series,
        hotspots: { folders: top(tallies.folders), files: top(tallies.files), categories: top(tallies.categories) },
    };
}

// ---- triage throughput ---------------------------------------------------------------------

function triageSection(
    events: readonly ActivityRow[],
    range: ReturnType<typeof rangeOf>,
    firstSeen: ReadonlyMap<string, number>,
    severityOf: (key: string) => Severity | null,
    now: number,
) {
    const series = range.buckets.map((date) => ({ date, closed: 0, byAgents: 0 }));
    const byDate = new Map(series.map((d) => [d.date, d]));
    const people = new Map<string, PersonRow & { vias: Set<Via> }>();
    const hours = Object.fromEntries(SEVERITIES.map((s) => [s, [] as number[]])) as Record<Severity, number[]>;
    let resolvedUntimed = 0;
    let closed = 0;
    let byAgents = 0;

    for (const e of events) {
        if (e.kind !== "issue") continue;
        const agent = AGENT_VIAS.has(e.via);
        const key = `${agent ? "agent" : "person"}:${e.actor}`;
        let p = people.get(key);
        if (!p) {
            p = {
                actor: e.actor,
                agent,
                via: [],
                vias: new Set(),
                resolved: 0,
                wontFix: 0,
                reopened: 0,
                notes: 0,
                corrections: 0,
                claims: 0,
                releases: 0,
                flags: 0,
                lastAt: e.at,
            };
            people.set(key, p);
        }
        p.vias.add(e.via);
        if (e.at > p.lastAt) p.lastAt = e.at;
        const c = e.changes;
        const st = changeOf<Status>(c.status);
        const assignee = changeOf<string | null>(c.assignee);
        if (st && !isDone(st.from) && isDone(st.to)) {
            closed++;
            if (agent) byAgents++;
            const d = byDate.get(range.key(e.at) ?? "");
            if (d) {
                d.closed++;
                if (agent) d.byAgents++;
            }
            if (st.to === "resolved") {
                p.resolved++;
                const k = `${e.projectId}:${e.itemId}`;
                const seen = firstSeen.get(k);
                const sev = severityOf(k);
                const t = Date.parse(e.at);
                if (seen !== undefined && sev && t >= seen) hours[sev].push((t - seen) / HOUR);
                else resolvedUntimed++;
            } else p.wontFix++;
        } else if (st && isDone(st.from) && !isDone(st.to) && !c.reopened) p.reopened++;
        if (typeof c.note === "string") p.notes++;
        if (changeOf(c.severity) || changeOf(c.category)) p.corrections++;
        if (st?.to === "in_progress" && assignee?.to && !assignee.from) p.claims++;
        if (assignee?.from && !assignee.to) p.releases++;
        if (changeOf(c.needsDiscussion)?.to === true) p.flags++;
    }

    const all = Object.values(hours).flat();
    const weeks = Math.max(1, (now - range.start) / DAY) / 7;
    return {
        closed,
        byAgents,
        agentShare: ratio(byAgents, closed),
        closedPerWeek: closed / weeks,
        series,
        timeToResolve: {
            medianHours: median(all),
            p90Hours: quantile(all, 0.9),
            notRecorded: resolvedUntimed,
            bySeverity: SEVERITIES.map((s) => ({
                severity: s,
                resolved: hours[s].length,
                medianHours: median(hours[s]),
                p90Hours: quantile(hours[s], 0.9),
            })),
        },
        people: [...people.values()]
            .map(({ vias, ...p }) => ({ ...p, via: [...vias].sort() }))
            .filter((p) => p.resolved + p.wontFix + p.reopened + p.notes + p.corrections + p.claims + p.releases + p.flags > 0)
            .sort((a, b) => b.resolved + b.wontFix - (a.resolved + a.wontFix) || b.notes - a.notes || a.actor.localeCompare(b.actor)),
    };
}

// ---- model and OCR performance -------------------------------------------------------------

function performanceSection(recs: readonly ReviewRecord[]) {
    const finished = recs.filter((r) => r.status === "done" || r.status === "partial");
    const groups = { total: 0, failed: 0, recorded: 0 };
    const llm = { requests: 0, retries: 0, failures: 0, recorded: 0 };
    const tools = new Map<string, { tool: string; calls: number; failures: number }>();
    const toolTotals = { calls: 0, failures: 0, recorded: 0 };
    const pace = { tokens: 0, seconds: 0, recorded: 0 };
    const perFile = { tokens: 0, files: 0, recorded: 0 };
    type Perf = {
        key: string;
        reviews: number;
        failed: number;
        partial: number;
        finished: number;
        times: number[];
        tokens: number;
        seconds: number;
        retries: number;
        llmFailures: number;
    };
    const byModel = new Map<string, Perf>();
    const byVersion = new Map<string, Perf>();
    const perf = (m: Map<string, Perf>, key: string): Perf => {
        let p = m.get(key);
        if (!p) {
            p = { key, reviews: 0, failed: 0, partial: 0, finished: 0, times: [], tokens: 0, seconds: 0, retries: 0, llmFailures: 0 };
            m.set(key, p);
        }
        return p;
    };

    for (const r of recs) {
        const d = r.details;
        const done = r.status === "done" || r.status === "partial";
        if (d.files?.groups !== undefined || d.files?.failedGroups !== undefined) {
            groups.total += d.files.groups ?? 0;
            groups.failed += d.files.failedGroups ?? 0;
            groups.recorded++;
        }
        if (d.llm) {
            llm.requests += d.llm.requests ?? 0;
            llm.retries += d.llm.retries ?? 0;
            llm.failures += d.llm.failures ?? 0;
            llm.recorded++;
        }
        if (d.toolCalls) {
            toolTotals.calls += d.toolCalls.total;
            toolTotals.failures += d.toolCalls.failed;
            toolTotals.recorded++;
            for (const [tool, n] of Object.entries(d.toolCalls.byTool ?? {})) {
                const t = tools.get(tool) ?? { tool, calls: 0, failures: 0 };
                t.calls += n;
                tools.set(tool, t);
            }
            for (const [tool, n] of Object.entries(d.toolCalls.failedByTool ?? {})) {
                const t = tools.get(tool) ?? { tool, calls: 0, failures: 0 };
                t.failures += n;
                tools.set(tool, t);
            }
        }
        const timed = done && r.tokens?.total && d.runSeconds ? { tokens: r.tokens.total, seconds: d.runSeconds } : null;
        if (timed) {
            pace.tokens += timed.tokens;
            pace.seconds += timed.seconds;
            pace.recorded++;
        }
        if (done && r.tokens?.total && d.files?.reviewed) {
            perFile.tokens += r.tokens.total;
            perFile.files += d.files.reviewed;
            perFile.recorded++;
        }
        for (const p of [perf(byModel, r.model ?? UNKNOWN_MODEL), perf(byVersion, d.ocrVersion ?? "(not recorded)")]) {
            p.reviews++;
            if (r.status === "failed") p.failed++;
            if (r.status === "partial") p.partial++;
            if (done) p.finished++;
            if (done && d.runSeconds !== undefined) p.times.push(d.runSeconds);
            if (timed) {
                p.tokens += timed.tokens;
                p.seconds += timed.seconds;
            }
            p.retries += d.llm?.retries ?? 0;
            p.llmFailures += d.llm?.failures ?? 0;
        }
    }

    const rows = (m: Map<string, Perf>) =>
        [...m.values()]
            .map((p) => ({
                key: p.key,
                reviews: p.reviews,
                failed: p.failed,
                partialRate: ratio(p.partial, p.finished),
                medianRunSeconds: median(p.times),
                tokensPerMinute: p.seconds ? p.tokens / (p.seconds / 60) : null,
                retries: p.retries,
                llmFailures: p.llmFailures,
            }))
            .sort((a, b) => b.reviews - a.reviews || a.key.localeCompare(b.key));
    const partial = recs.filter((r) => r.status === "partial").length;

    return {
        reviews: recs.length,
        partial,
        partialRate: ratio(partial, finished.length),
        groups,
        llm,
        tokensPerMinute: pace.seconds
            ? { value: pace.tokens / (pace.seconds / 60), recorded: pace.recorded }
            : { value: null, recorded: 0 },
        tokensPerFile: perFile.files ? { value: perFile.tokens / perFile.files, recorded: perFile.recorded } : { value: null, recorded: 0 },
        tools: {
            ...toolTotals,
            failureRate: ratio(toolTotals.failures, toolTotals.calls),
            byTool: [...tools.values()]
                .map((t) => ({ ...t, failureRate: ratio(t.failures, t.calls) }))
                .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
        },
        byModel: rows(byModel),
        ocrVersions: rows(byVersion),
    };
}

// ---- models --------------------------------------------------------------------------------

/** Fewer decided findings than this, and a rate is a guess: shown with its sample size, greyed out. */
export const SMALL_SAMPLE = 10;

export interface ModelRow {
    /** The provider's model id. */
    key: string;
    provider: string | null;
    /** What reviews called it, most used first (a nickname, when it has one). */
    labels: string[];
    reviews: number;
    failed: number;
    /** Stopped for going quiet. */
    stalled: number;
    failureRate: number | null;
    medianRunSeconds: number | null;
    tokens: number;
    /** Null when it has no price. */
    cost: number | null;
    /** Findings it reported for the first time in the range. */
    findings: number;
    /** Of those, from reviews with other models, the ones no other model found. */
    unique: number;
    /** Resolved, and dismissed as won't fix (not as duplicates). */
    accepted: number;
    rejected: number;
    /** accepted ÷ (accepted + rejected); null with none decided. */
    acceptanceRate: number | null;
    costPerFinding: number | null;
    costPerAccepted: number | null;
    /**
     * What its reviews with other models would have been without it: how many there were, the findings
     * only it found that were rated critical or high, those since accepted, and how much sooner those
     * reviews would have ended (it was the last to finish in `slowestIn` of them, by `secondsSaved` in all),
     * and what it cost in them (null without a price).
     */
    without: { reviews: number; serious: number; accepted: number; slowestIn: number; secondsSaved: number; cost: number | null };
}

/**
 * Each model's reviews and findings side by side, how far the models of a review agree, and both over
 * time. `recs` are the reviews in the range; `history` every review (to know which models a review ran,
 * even one that found nothing); `sources` who found what, for the branches in scope.
 */
function modelsSection(
    recs: readonly ReviewRecord[],
    history: readonly ReviewRecord[],
    sources: readonly FindingSource[],
    range: ReturnType<typeof rangeOf>,
    input: AnalyticsInput,
) {
    const now = Date.parse(range.to);
    const inRange = (at: string) => {
        const t = Date.parse(at);
        return Number.isFinite(t) && t >= range.start && t <= now;
    };
    interface Acc extends ModelRow {
        runTimes: number[];
        labelCounts: Map<string, number>;
    }
    const rows = new Map<string, Acc>();
    const row = (key: string, provider: string | null): Acc => {
        let r = rows.get(key);
        if (!r) {
            r = {
                key,
                provider: provider || null,
                labels: [],
                reviews: 0,
                failed: 0,
                stalled: 0,
                failureRate: null,
                medianRunSeconds: null,
                tokens: 0,
                cost: null,
                findings: 0,
                unique: 0,
                accepted: 0,
                rejected: 0,
                acceptanceRate: null,
                costPerFinding: null,
                costPerAccepted: null,
                without: { reviews: 0, serious: 0, accepted: 0, slowestIn: 0, secondsSaved: 0, cost: null },
                runTimes: [],
                labelCounts: new Map(),
            };
            rows.set(key, r);
        }
        if (!r.provider && provider) r.provider = provider;
        return r;
    };
    const series = range.buckets.map((date) => ({
        date,
        models: {} as Record<string, { cost: number; accepted: number; rejected: number }>,
    }));
    const byDate = new Map(series.map((d) => [d.date, d]));
    const point = (at: string, key: string) => {
        const bucket = byDate.get(range.key(at) ?? "");
        if (!bucket) return null;
        bucket.models[key] ??= { cost: 0, accepted: 0, rejected: 0 };
        return bucket.models[key];
    };

    let withoutModel = 0;
    for (const r of recs) {
        if (!r.model) {
            withoutModel++;
            continue;
        }
        const m = row(r.model, r.provider);
        m.reviews++;
        if (r.status === "failed") m.failed++;
        if (r.details.stopped === "stalled" || /^Stalled:/.test(r.details.error ?? "")) m.stalled++;
        m.tokens += r.tokens?.total ?? 0;
        const c = costOf(r.tokens, input.price(r.model));
        if (c !== null) {
            m.cost = (m.cost ?? 0) + c;
            const p = point(r.at, r.model);
            if (p) p.cost += c;
        }
        if ((r.status === "done" || r.status === "partial") && r.details.runSeconds !== undefined) m.runTimes.push(r.details.runSeconds);
    }

    // Each review with several models: who took part, and who it waited for. Its models run at once, so it
    // ends when the slowest does; without that one, it would have ended when the next slowest did.
    const together = new Map<string, { model: string; seconds: number | null; cost: number | null; again: boolean }[]>();
    for (const r of recs) {
        const id = r.details.scan?.id;
        if (!id || !r.model) continue;
        together.set(id, [
            ...(together.get(id) ?? []),
            {
                model: r.model,
                seconds: r.details.runSeconds ?? null,
                cost: costOf(r.tokens, input.price(r.model)),
                // A model run again later is the same model of the same review: its cost counts, its time doesn't.
                again: Boolean(r.details.attempt),
            },
        ]);
    }
    for (const all of together.values()) {
        const parts = all.filter((x) => !x.again);
        if (parts.length < 2) continue;
        for (const key of new Set(parts.map((x) => x.model))) row(key, null).without.reviews++;
        for (const x of all) {
            const w = row(x.model, null).without;
            if (x.cost !== null) w.cost = (w.cost ?? 0) + x.cost;
        }
        const timed = parts
            .flatMap((x) => (x.seconds === null ? [] : [{ model: x.model, seconds: x.seconds }]))
            .sort((a, b) => b.seconds - a.seconds);
        const [slowest, next] = timed;
        if (timed.length !== parts.length || !slowest || !next || slowest.seconds === next.seconds) continue;
        const w = row(slowest.model, null).without;
        w.slowestIn++;
        w.secondsSaved += slowest.seconds - next.seconds;
    }

    // Which models each review ran (by the provider's ids), including any that found nothing.
    const ran = new Map<string, Set<string>>();
    for (const r of history) {
        const id = r.details.scan?.id;
        if (!id || !r.model || r.details.merging) continue;
        ran.set(id, (ran.get(id) ?? new Set()).add(r.model));
    }
    // The models that reported each finding in the same review. One that found it in a later review didn't
    // agree with the first: it wasn't looking at the same thing at the same time.
    const finders = new Map<string, Set<string>>();
    const findingKey = (s: FindingSource) => `${s.projectId}\0${s.branch}\0${s.findingId}`;
    const inScan = (s: FindingSource) => `${findingKey(s)}\0${s.scanId ?? ""}`;
    for (const s of sources) finders.set(inScan(s), (finders.get(inScan(s)) ?? new Set()).add(s.model));

    const agreement = { findings: 0, all: 0, several: 0, one: 0 };
    const counted = new Set<string>();
    const pairs = new Map<string, { a: string; b: string; of: number; shared: number }>();
    for (const s of sources) {
        if (!inRange(s.firstSeenAt)) continue;
        const m = row(s.model, s.provider);
        m.labelCounts.set(s.label, (m.labelCounts.get(s.label) ?? 0) + 1);
        m.findings++;
        if (s.outcome === "accepted") m.accepted++;
        if (s.outcome === "rejected") m.rejected++;
        const p = s.outcome ? point(s.firstSeenAt, s.model) : null;
        if (p && s.outcome) p[s.outcome]++;
        if (s.scanModels < 2) continue;
        const found = finders.get(inScan(s)) ?? new Set([s.model]);
        if (found.size === 1) {
            m.unique++;
            if (s.severity === "critical" || s.severity === "high") m.without.serious++;
            if (s.outcome === "accepted") m.without.accepted++;
        }
        // Against each other model of the same review: did it find this one too?
        for (const other of (s.scanId ? ran.get(s.scanId) : null) ?? found) {
            if (other === s.model) continue;
            const k = `${s.model}\0${other}`;
            const pair = pairs.get(k) ?? { a: s.model, b: other, of: 0, shared: 0 };
            pair.of++;
            if (found.has(other)) pair.shared++;
            pairs.set(k, pair);
        }
        // The finding itself, once, however many models reported it.
        if (counted.has(inScan(s))) continue;
        counted.add(inScan(s));
        agreement.findings++;
        if (found.size === 1) agreement.one++;
        else if (found.size >= s.scanModels) agreement.all++;
        else agreement.several++;
    }

    const out: ModelRow[] = [...rows.values()]
        .map(({ runTimes, labelCounts, ...m }) => ({
            ...m,
            labels: [...labelCounts].sort((a, b) => b[1] - a[1]).map(([label]) => label),
            failureRate: ratio(m.failed, m.reviews),
            medianRunSeconds: median(runTimes),
            acceptanceRate: ratio(m.accepted, m.accepted + m.rejected),
            costPerFinding: m.cost !== null ? ratio(m.cost, m.findings) : null,
            costPerAccepted: m.cost !== null ? ratio(m.cost, m.accepted) : null,
        }))
        .sort((a, b) => b.reviews - a.reviews || b.findings - a.findings || a.key.localeCompare(b.key));
    return {
        rows: out,
        /** Reviews in the range that didn't say which model they used (uploads, mostly): not in the rows. */
        withoutModel,
        agreement: {
            ...agreement,
            /** Of `a`'s findings in reviews it shared with `b`, the share `b` found too. */
            overlap: [...pairs.values()]
                .map((p) => ({ ...p, share: ratio(p.shared, p.of) }))
                .sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b)),
        },
        series,
        smallSample: SMALL_SAMPLE,
    };
}
