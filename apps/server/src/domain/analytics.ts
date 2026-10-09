// Analytics: what the reviews did (runs and uploads: outcomes, time, tokens, cost, how the model behaved)
// and what people and agents did with the findings (backlog, throughput, ratings).
//
// Pure: the service reads the rows (review history, the activity log and the current reports) and this
// works through each list once. Figures a review didn't record are counted as "not recorded" rather than
// as zero, so a missing measurement never looks like a good one.

import { DONE_STATUSES, SEVERITIES, type Severity, type Status, type Via } from "@triagent/shared";
import type { ActivityRow, ReviewRecord } from "../store/types.ts";

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
    price(model: string): PricedModel | null;
    projectSlug(projectId: string | null): string | null;
}

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

    const { section: reviewSection, unpriced } = reviewsSection(reviews, range, input);
    return {
        range: { days: range.days, from: range.from, to: range.to, unit: range.unit, buckets: range.buckets },
        reviews: reviewSection,
        findings: findingsSection(events, input.current, range, firstSeen, now),
        triage: triageSection(events, range, firstSeen, severityOf, now),
        performance: performanceSection(reviews),
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
    const out: { r: ReviewRecord; cost: number | null }[] = [];
    const byScan = new Map<string, ReviewRecord[]>();
    for (const r of recs) {
        const id = r.details.scan?.id;
        if (!id) out.push({ r, cost: costs.get(r.id) ?? null });
        else byScan.set(id, [...(byScan.get(id) ?? []), r]);
    }
    for (const [id, group] of byScan) {
        const lead = group.find((r) => r.details.scan?.lead) ?? (group[0] as ReviewRecord);
        const scan = lead.details.scan as NonNullable<ReviewRecord["details"]["scan"]>;
        const known = group.map((r) => r.tokens).filter((t): t is NonNullable<ReviewRecord["tokens"]> => t !== null);
        const priced = group.map((r) => costs.get(r.id) ?? null).filter((c): c is number => c !== null);
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
                        ? { runSeconds: group.reduce((n, r) => n + (r.details.runSeconds ?? 0), 0) }
                        : {}),
                    ...(scan.findings !== null
                        ? { findings: { ...(lead.details.findings ?? { bySeverity: zeroes() }), total: scan.findings } }
                        : {}),
                },
            },
            cost: priced.length ? priced.reduce((a, b) => a + b, 0) : null,
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
    let priced = 0;
    let pricedFindings = 0;
    let findings = 0;
    const costs = new Map<string, number | null>();

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
        const key = r.model ?? UNKNOWN_MODEL;
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
    for (const { r, cost: c } of merged) {
        const found = r.status === "done" || r.status === "partial" ? (r.details.findings?.total ?? 0) : 0;
        byStatus[r.status]++;
        if (r.source === "run") runs++;
        findings += found;
        if (c !== null) {
            cost += c;
            priced++;
            pricedFindings += found;
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

    const finish = (which: "model" | "kind") =>
        [...groups[which].values()]
            .map((g) => ({
                ...g,
                medianRunSeconds: median(runTimes[which].get(g.key) ?? []),
                costPerFinding: g.cost !== null && g.findings ? g.cost / g.findings : null,
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
            findings: r.details.findings?.total ?? null,
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
                total: priced ? cost : null,
                pricedReviews: priced,
                perReview: priced ? cost / priced : null,
                perPr: prCosts.length ? prCosts.reduce((a, b) => a + b, 0) / prCosts.length : null,
                prs: prCosts.length,
                perFinding: pricedFindings ? cost / pricedFindings : null,
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
