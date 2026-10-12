// What the Analytics page's tabs are made of (the Overview and Models tabs have files of their own). Each
// leads with a few headline figures, then charts (each with a table view), then tables. Figures a review
// didn't record say so instead of showing zero.

import { Link } from "@tanstack/react-router";
import { SEVERITIES, type Severity } from "@triagent/shared";
import type { ReactNode } from "react";
import { BarList, ChartFrame, ColumnChart, LineChart, type Point, type Series, Stat, Stats } from "@/components/charts";
import { SeverityMark } from "@/components/marks";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CATEGORY_LABEL, formatDateTime, plural, SEVERITY_LABEL, timeAgo } from "@/lib/format";
import {
    bucketLabel,
    bucketLong,
    compactCount,
    count,
    hours,
    KIND_LABEL,
    NOT_RECORDED,
    percent,
    STATUS_LABEL,
    seconds,
    usd,
    VIA_LABEL,
} from "@/lib/insights-format";
import type { Analytics, HotspotRow, PerfRow, ReviewGroup } from "@/lib/insights-types";
import { useWorkspace } from "@/lib/session";

const SEV_BG: Record<Severity, string> = { critical: "bg-sev-critical", high: "bg-sev-high", medium: "bg-sev-medium", low: "bg-sev-low" };

export function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
    return (
        <section aria-labelledby={`${id}-title`} id={id} className="grid scroll-mt-16 gap-4">
            <div className="space-y-0.5">
                <h2 id={`${id}-title`} className="text-lg font-semibold">
                    {title}
                </h2>
                <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            {children}
        </section>
    );
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="grid min-w-0 content-start gap-3 rounded-lg border bg-card p-4">
            <h3 className="section-title">{title}</h3>
            {children}
        </div>
    );
}

/** A plain table: headings, then rows of cells; numbers right-aligned. */
export function DataTable({
    caption,
    columns,
    rows,
    empty = "Nothing in this range.",
}: {
    caption: string;
    columns: { label: string; numeric?: boolean }[];
    rows: { key: string; cells: ReactNode[] }[];
    empty?: string;
}) {
    if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
    return (
        <Table>
            <caption className="sr-only">{caption}</caption>
            <TableHeader>
                <TableRow>
                    {columns.map((c) => (
                        <TableHead key={c.label} scope="col" className={c.numeric ? "text-end" : undefined}>
                            {c.label}
                        </TableHead>
                    ))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map((r) => (
                    <TableRow key={r.key}>
                        {columns.map((c, i) => (
                            <TableCell
                                key={c.label}
                                className={c.numeric ? "text-end tabular-nums" : i === 0 ? "min-w-32 whitespace-normal" : undefined}
                            >
                                {r.cells[i]}
                            </TableCell>
                        ))}
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

/** The series' values per bucket, as a table. */
export function SeriesTable({
    caption,
    points,
    series,
    format,
}: {
    caption: string;
    points: Point[];
    series: Series[];
    format(v: number): string;
}) {
    return (
        <DataTable
            caption={caption}
            columns={[{ label: "Period" }, ...series.map((s) => ({ label: s.label, numeric: true }))]}
            rows={points.map((p) => ({ key: p.long, cells: [p.long, ...series.map((s) => format(p.values[s.key] ?? 0))] }))}
        />
    );
}

export function pointsOf<T extends { date: string }>(a: Analytics, rows: T[], values: (row: T) => Record<string, number>): Point[] {
    return rows.map((r) => ({ label: bucketLabel(r.date, a.range.unit), long: bucketLong(r.date, a.range.unit), values: values(r) }));
}

export const per = (a: Analytics) => (a.range.unit === "week" ? "week" : "day");

// ---- reviews -----------------------------------------------------------------------------------

export const OUTCOMES: Series[] = [
    { key: "done", label: "Done", colour: "chart-1" },
    { key: "partial", label: "Partial", colour: "chart-2" },
    { key: "failed", label: "Failed or cancelled", colour: "chart-3" },
];

function groupRows(groups: ReviewGroup[], label: (key: string) => ReactNode) {
    return groups.map((g) => ({
        key: g.key,
        cells: [
            label(g.key),
            count(g.reviews),
            count(g.partial),
            count(g.failed + g.cancelled),
            seconds(g.medianRunSeconds),
            compactCount(g.tokens),
            usd(g.cost),
            count(g.findings),
            g.costPerFinding === null ? "—" : usd(g.costPerFinding),
        ],
    }));
}

const GROUP_COLUMNS = [
    { label: "Reviews", numeric: true },
    { label: "Partial", numeric: true },
    { label: "Failed", numeric: true },
    { label: "Median run time", numeric: true },
    { label: "Tokens", numeric: true },
    { label: "Cost", numeric: true },
    { label: "Findings", numeric: true },
    { label: "Cost per finding", numeric: true },
];

/** What one review cost: nothing to price without its tokens; "at least" when some of its models have no price. */
function ReviewCost({ review }: { review: { tokens: number | null; cost: number | null; costPartial: boolean } }) {
    if (review.tokens === null) return "—";
    if (review.cost === null || !review.costPartial) return usd(review.cost);
    return <span title="Some of its models have no price, so it cost more than this">at least {usd(review.cost)}</span>;
}

export function ReviewsSection({ a }: { a: Analytics }) {
    const { ws } = useWorkspace();
    const r = a.reviews;
    if (!r) return null;
    const outcomes = pointsOf(a, r.series, (d) => ({ done: d.done, partial: d.partial, failed: d.failed + d.cancelled }));
    const tokens = pointsOf(a, r.series, (d) => ({ tokens: d.tokens }));
    const tokenSeries: Series[] = [{ key: "tokens", label: "Tokens", colour: "chart-1" }];
    const unit = per(a);
    return (
        <Section
            id="reviews"
            title="Reviews and cost"
            description="Every review that finished: run on the server, or uploaded by people, agents or CI. Each model's own figures are under Models."
        >
            <Stats>
                <Stat label="Reviews" value={count(r.total)} note={`${count(r.runs)} run here, ${count(r.uploads)} uploaded`} />
                <Stat
                    label="Done"
                    value={count(r.byStatus.done)}
                    note={`${count(r.byStatus.partial)} partial, ${count(r.byStatus.failed)} failed, ${count(r.byStatus.cancelled)} cancelled`}
                />
                <Stat
                    label="Run time (median)"
                    value={seconds(r.runSeconds.median)}
                    note={r.runSeconds.recorded ? `90th percentile ${seconds(r.runSeconds.p90)}` : undefined}
                />
                <Stat
                    label="Queue time (median)"
                    value={seconds(r.queueSeconds.median)}
                    note={r.queueSeconds.recorded ? `90th percentile ${seconds(r.queueSeconds.p90)}` : "Only server runs wait"}
                />
                <Stat
                    label="Tokens"
                    value={compactCount(r.tokens.total)}
                    note={
                        !r.tokens.recorded
                            ? NOT_RECORDED
                            : r.tokens.estimated
                              ? `${compactCount(r.tokens.cacheRead)} cache reads. Includes an estimate of ${compactCount(r.tokens.estimatedTotal)} for ${r.tokens.estimated === 1 ? "a review" : `${count(r.tokens.estimated)} reviews`} that stopped without saying (counted at ${r.tokens.estimated === 1 ? "its" : "their"} token budget)`
                              : `${compactCount(r.tokens.cacheRead)} cache reads`
                    }
                />
                <Stat
                    label="Cost"
                    value={r.cost.total !== null && r.cost.partlyPriced ? `At least ${usd(r.cost.total)}` : usd(r.cost.total)}
                    note={
                        r.cost.total === null
                            ? "Set model prices to see costs"
                            : [
                                  r.cost.perReview !== null && `${usd(r.cost.perReview)} a review`,
                                  r.cost.perPr !== null && `${usd(r.cost.perPr)} a pull request`,
                                  r.cost.perFinding !== null && `${usd(r.cost.perFinding)} a finding`,
                                  // A review that used a model with no price cost more than is known: no average counts it.
                                  r.cost.partlyPriced > 0 &&
                                      `${plural(r.cost.partlyPriced, "review")} used a model with no price, so ${r.cost.partlyPriced === 1 ? "isn't" : "aren't"} in the averages`,
                              ]
                                  .filter(Boolean)
                                  .join(" · ")
                    }
                />
            </Stats>
            {a.unpriced.length > 0 && (
                <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="unpriced">
                    No price for {a.unpriced.map((u) => `${u.model} (${compactCount(u.tokens)} tokens)`).join(", ")}: their tokens are left
                    out of the costs. Add prices in Settings → Model prices.
                </p>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
                <ChartFrame
                    title={`Reviews a ${unit}`}
                    summary={`Reviews a ${unit}, by outcome: ${count(r.byStatus.done)} done, ${count(r.byStatus.partial)} partial and ${count(r.byStatus.failed + r.byStatus.cancelled)} failed or cancelled in all.`}
                    series={OUTCOMES}
                    table={<SeriesTable caption={`Reviews a ${unit}, by outcome`} points={outcomes} series={OUTCOMES} format={count} />}
                >
                    <ColumnChart points={outcomes} series={OUTCOMES} />
                </ChartFrame>
                <ChartFrame
                    title={`Tokens a ${unit}`}
                    summary={`Model tokens a ${unit}: ${compactCount(r.tokens.total)} in all.`}
                    series={tokenSeries}
                    table={<SeriesTable caption={`Tokens a ${unit}`} points={tokens} series={tokenSeries} format={count} />}
                >
                    <ColumnChart points={tokens} series={tokenSeries} format={compactCount} />
                </ChartFrame>
            </div>
            <Card title="By kind">
                <DataTable
                    caption="Reviews by kind"
                    columns={[{ label: "Kind" }, ...GROUP_COLUMNS]}
                    rows={groupRows(r.byKind, (k) => KIND_LABEL[k] ?? k)}
                />
            </Card>
            <Card title="Latest reviews">
                <DataTable
                    caption="The latest reviews"
                    columns={[
                        { label: "When" },
                        { label: "Where" },
                        { label: "Kind" },
                        { label: "Outcome" },
                        { label: "Model" },
                        { label: "Run time", numeric: true },
                        { label: "Tokens", numeric: true },
                        { label: "Cost", numeric: true },
                        { label: "Findings", numeric: true },
                    ]}
                    rows={r.latest.map((x) => ({
                        key: x.id,
                        cells: [
                            // A review run here opens its own page, where its models are side by side.
                            x.runId && x.project ? (
                                <Link
                                    key="t"
                                    to="/w/$ws/p/$project/runs/$runId"
                                    params={{ ws, project: x.project, runId: x.runId }}
                                    className="link"
                                >
                                    <time dateTime={x.at} title={formatDateTime(x.at)}>
                                        {timeAgo(x.at)}
                                    </time>
                                </Link>
                            ) : (
                                <time key="t" dateTime={x.at} title={formatDateTime(x.at)}>
                                    {timeAgo(x.at)}
                                </time>
                            ),
                            <span key="w">
                                {x.project ?? "(deleted project)"}{" "}
                                <span className="font-mono text-xs text-muted-foreground">{x.branch}</span>
                            </span>,
                            `${KIND_LABEL[x.kind] ?? x.kind}${x.prNumber ? ` #${x.prNumber}` : ""}${x.requestedBy ? `, by ${x.requestedBy}` : ""}`,
                            STATUS_LABEL[x.status] ?? x.status,
                            // A review with several: how many, with their names a hover (or its own page) away.
                            x.model?.includes(" + ") ? (
                                <span key="m" title={x.model}>
                                    {x.model.split(" + ").length} models
                                </span>
                            ) : (
                                <span key="m" className="font-mono text-xs">
                                    {x.model ?? NOT_RECORDED}
                                </span>
                            ),
                            seconds(x.runSeconds),
                            x.tokens === null
                                ? NOT_RECORDED
                                : x.tokensEstimated
                                  ? `about ${compactCount(x.tokens)} (estimate)`
                                  : compactCount(x.tokens),
                            <ReviewCost key="c" review={x} />,
                            x.findings === null ? "—" : count(x.findings),
                        ],
                    }))}
                    empty="No reviews in this range."
                />
            </Card>
        </Section>
    );
}

// ---- findings and backlog ----------------------------------------------------------------------

export const FLOW: Series[] = [
    { key: "added", label: "New", colour: "chart-1" },
    { key: "closed", label: "Closed", colour: "chart-2" },
    { key: "reopened", label: "Reopened", colour: "chart-3" },
];

function HotspotTable({ caption, rows, label }: { caption: string; rows: HotspotRow[]; label(key: string): ReactNode }) {
    return (
        <DataTable
            caption={caption}
            columns={[
                { label: "Where" },
                { label: "Open", numeric: true },
                ...SEVERITIES.map((s) => ({ label: SEVERITY_LABEL[s], numeric: true })),
            ]}
            rows={rows.map((h) => ({ key: h.key, cells: [label(h.key), count(h.open), ...SEVERITIES.map((s) => count(h[s]))] }))}
            empty="Nothing open."
        />
    );
}

export function FindingsSection({ a }: { a: Analytics }) {
    const f = a.findings;
    if (!f) return null;
    const flow = pointsOf(a, f.series, (d) => ({ added: d.added, closed: d.closed, reopened: d.reopened }));
    const ages: [string, number][] = [
        ["Under a week", f.age.under7],
        ["1 to 4 weeks", f.age.under30],
        ["1 to 3 months", f.age.under90],
        ["Over 3 months", f.age.older],
        ["Age not recorded", f.age.notRecorded],
    ];
    return (
        <Section
            id="findings"
            title="Findings and backlog"
            description="What's open now on the branches in scope, and how findings came and went over the range."
        >
            <Stats>
                <Stat
                    label="Open now"
                    value={count(f.open)}
                    note={`${count(f.inProgress)} in progress, ${count(f.unassigned)} unassigned`}
                />
                <Stat
                    label="New"
                    value={count(f.added)}
                    note={`${count(f.removed)} no longer reported, ${count(f.reopenedByReview + f.reopenedByPeople)} reopened`}
                />
                <Stat label="Closed" value={count(f.closed)} note={`${count(f.resolved)} resolved, ${count(f.wontFix)} won't fix`} />
                <Stat
                    label="Won't-fix rate"
                    value={percent(f.wontFixRate)}
                    note={`${count(f.duplicates)} marked as ${f.duplicates === 1 ? "a duplicate" : "duplicates"}`}
                />
            </Stats>
            <div className="grid gap-4 lg:grid-cols-2">
                <ChartFrame
                    title={`New and closed findings a ${per(a)}`}
                    summary={`${count(f.added)} new findings, ${count(f.closed)} closed and ${count(f.reopenedByReview + f.reopenedByPeople)} reopened over the range.`}
                    series={FLOW}
                    table={<SeriesTable caption="New, closed and reopened findings" points={flow} series={FLOW} format={count} />}
                >
                    <LineChart points={flow} series={FLOW} />
                </ChartFrame>
                <Card title="Open now by severity">
                    <BarList
                        label="Open findings by severity"
                        rows={SEVERITIES.map((s) => ({
                            key: s,
                            label: <SeverityMark severity={s} />,
                            value: f.openBySeverity[s],
                            barClass: SEV_BG[s],
                        }))}
                    />
                    <h4 className="mt-2 text-sm font-medium">How long they've been open</h4>
                    <BarList
                        label="Open findings by age"
                        rows={ages.map(([label, value]) => ({ key: label, label, value, barClass: "bg-chart-1" }))}
                    />
                    {f.age.notRecorded > 0 && (
                        <p className="text-xs text-muted-foreground">
                            Ages are known for findings first reported by a review recorded here.
                        </p>
                    )}
                </Card>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
                <Card title="Hotspot folders">
                    <HotspotTable
                        caption="Folders with the most open findings"
                        rows={f.hotspots.folders}
                        label={(k) => <span className="font-mono text-xs break-all">{k}</span>}
                    />
                </Card>
                <Card title="Categories">
                    <HotspotTable
                        caption="Open findings by category"
                        rows={f.hotspots.categories}
                        label={(k) => CATEGORY_LABEL[k as keyof typeof CATEGORY_LABEL] ?? k}
                    />
                </Card>
            </div>
            <Card title="Hotspot files">
                <HotspotTable
                    caption="Files with the most open findings"
                    rows={f.hotspots.files}
                    label={(k) => <span className="font-mono text-xs break-all">{k}</span>}
                />
            </Card>
            {f.corrections.severityChanges.length > 0 && (
                <Card
                    title={`Severity corrections (${count(f.corrections.severity)}${f.corrections.category ? `, and ${plural(f.corrections.category, "category correction")}` : ""})`}
                >
                    <DataTable
                        caption="How people corrected the reviewer's severity"
                        columns={[{ label: "From" }, { label: "To" }, { label: "Times", numeric: true }]}
                        rows={f.corrections.severityChanges.map((c) => ({
                            key: `${c.from}-${c.to}`,
                            cells: [
                                c.from === "reviewer" ? "The reviewer's rating" : (SEVERITY_LABEL[c.from as Severity] ?? c.from),
                                SEVERITY_LABEL[c.to as Severity] ?? c.to,
                                count(c.n),
                            ],
                        }))}
                    />
                </Card>
            )}
        </Section>
    );
}

// ---- triage --------------------------------------------------------------------------------------

const CLOSERS: Series[] = [
    { key: "people", label: "By people", colour: "chart-1" },
    { key: "agents", label: "By agents", colour: "chart-2" },
];

export function TriageSection({ a }: { a: Analytics }) {
    const t = a.triage;
    if (!t) return null;
    const closed = pointsOf(a, t.series, (d) => ({ people: d.closed - d.byAgents, agents: d.byAgents }));
    return (
        <Section
            id="triage"
            title="Triage and people"
            description="Findings closed, by people and by agents (through MCP or API tokens), and how long they took."
        >
            <Stats>
                <Stat
                    label="Closed"
                    value={count(t.closed)}
                    note={`${t.closedPerWeek.toLocaleString("en-GB", { maximumFractionDigits: 1 })} a week`}
                />
                <Stat label="Closed by agents" value={percent(t.agentShare)} note={plural(t.byAgents, "finding")} />
                <Stat
                    label="Time to resolve (median)"
                    value={hours(t.timeToResolve.medianHours)}
                    note={`90th percentile ${hours(t.timeToResolve.p90Hours)}`}
                />
                <Stat label="People and agents" value={count(t.people.length)} />
            </Stats>
            <div className="grid gap-4 lg:grid-cols-2">
                <ChartFrame
                    title={`Findings closed a ${per(a)}`}
                    summary={`${plural(t.closed, "finding")} closed over the range, ${count(t.byAgents)} of them by agents.`}
                    series={CLOSERS}
                    table={<SeriesTable caption="Findings closed, by people and agents" points={closed} series={CLOSERS} format={count} />}
                >
                    <ColumnChart points={closed} series={CLOSERS} />
                </ChartFrame>
                <Card title="Time to resolve, by severity">
                    <DataTable
                        caption="Time from when a review first reported a finding to when it was resolved"
                        columns={[
                            { label: "Severity" },
                            { label: "Resolved", numeric: true },
                            { label: "Median", numeric: true },
                            { label: "90th percentile", numeric: true },
                        ]}
                        rows={t.timeToResolve.bySeverity.map((s) => ({
                            key: s.severity,
                            cells: [
                                <SeverityMark key="s" severity={s.severity} />,
                                count(s.resolved),
                                hours(s.medianHours),
                                hours(s.p90Hours),
                            ],
                        }))}
                    />
                    <p className="text-xs text-muted-foreground">
                        Measured from when a review recorded here first reported the finding.
                        {t.timeToResolve.notRecorded > 0 &&
                            ` ${plural(t.timeToResolve.notRecorded, "resolved finding was", "resolved findings were")} first reported before that, so ${t.timeToResolve.notRecorded === 1 ? "isn't" : "aren't"} timed.`}
                    </p>
                </Card>
            </div>
            <Card title="People and agents">
                <DataTable
                    caption="What each person and agent did"
                    columns={[
                        { label: "Who" },
                        { label: "Resolved", numeric: true },
                        { label: "Won't fix", numeric: true },
                        { label: "Reopened", numeric: true },
                        { label: "Notes", numeric: true },
                        { label: "Corrections", numeric: true },
                        { label: "Claimed", numeric: true },
                        { label: "Released", numeric: true },
                        { label: "Flagged", numeric: true },
                        { label: "Last active" },
                    ]}
                    rows={t.people.map((p) => ({
                        key: `${p.agent}-${p.actor}`,
                        cells: [
                            <span key="w">
                                {p.actor}
                                <span className="block text-xs text-muted-foreground">
                                    {[p.agent ? "Agent" : "Person", p.via.map((v) => VIA_LABEL[v] ?? v).join(", ")]
                                        .filter(Boolean)
                                        .join(" · ")}
                                </span>
                            </span>,
                            count(p.resolved),
                            count(p.wontFix),
                            count(p.reopened),
                            count(p.notes),
                            count(p.corrections),
                            count(p.claims),
                            count(p.releases),
                            count(p.flags),
                            <time key="t" dateTime={p.lastAt} title={formatDateTime(p.lastAt)}>
                                {timeAgo(p.lastAt)}
                            </time>,
                        ],
                    }))}
                    empty="No triage in this range."
                />
            </Card>
        </Section>
    );
}

// ---- model and OCR performance -----------------------------------------------------------------

function perfRows(rows: PerfRow[], label: (k: string) => ReactNode) {
    return rows.map((p) => ({
        key: p.key,
        cells: [
            label(p.key),
            count(p.reviews),
            percent(p.partialRate),
            count(p.failed),
            seconds(p.medianRunSeconds),
            p.tokensPerMinute === null ? NOT_RECORDED : compactCount(p.tokensPerMinute),
            count(p.retries),
            count(p.llmFailures),
        ],
    }));
}

const PERF_COLUMNS = [
    { label: "Reviews", numeric: true },
    { label: "Partial", numeric: true },
    { label: "Failed", numeric: true },
    { label: "Median run time", numeric: true },
    { label: "Tokens a minute", numeric: true },
    { label: "Retries", numeric: true },
    { label: "Model failures", numeric: true },
];

export function PerformanceSection({ a }: { a: Analytics }) {
    const p = a.performance;
    if (!p) return null;
    const recorded = (n: number, text: string) => (n ? text : NOT_RECORDED);
    return (
        // For looking into a problem, not for every visit: closed until asked for.
        <details className="group rounded-lg border" data-testid="ocr-figures">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium select-none">
                How Open Code Review behaved: partial reviews, model requests, tool calls, versions
            </summary>
            <div className="grid gap-4 border-t p-4">
                <p className="text-sm text-muted-foreground">
                    From what each review recorded. Uploaded reports carry less than server runs.
                </p>
                <Stats>
                    <Stat label="Partial reviews" value={count(p.partial)} note={`${percent(p.partialRate)} of finished reviews`} />
                    <Stat
                        label="Failed file groups"
                        value={recorded(p.groups.recorded, count(p.groups.failed))}
                        note={p.groups.recorded ? `of ${count(p.groups.total)} groups` : undefined}
                    />
                    <Stat
                        label="Model requests"
                        value={recorded(p.llm.recorded, compactCount(p.llm.requests))}
                        note={p.llm.recorded ? `${count(p.llm.retries)} retried, ${count(p.llm.failures)} failed` : undefined}
                    />
                    <Stat
                        label="Tokens a minute"
                        value={p.tokensPerMinute.value === null ? NOT_RECORDED : compactCount(p.tokensPerMinute.value)}
                    />
                    <Stat
                        label="Tokens a file"
                        value={p.tokensPerFile.value === null ? NOT_RECORDED : compactCount(p.tokensPerFile.value)}
                    />
                    <Stat
                        label="Tool calls"
                        value={recorded(p.tools.recorded, compactCount(p.tools.calls))}
                        note={p.tools.recorded ? `${percent(p.tools.failureRate)} failed` : undefined}
                    />
                </Stats>
                <div className="grid gap-4">
                    <Card title="Tools the model used">
                        <DataTable
                            caption="Tool calls and failures"
                            columns={[
                                { label: "Tool" },
                                { label: "Calls", numeric: true },
                                { label: "Failed", numeric: true },
                                { label: "Failure rate", numeric: true },
                            ]}
                            rows={p.tools.byTool.map((t) => ({
                                key: t.tool,
                                cells: [
                                    <span key="t" className="font-mono text-xs">
                                        {t.tool}
                                    </span>,
                                    count(t.calls),
                                    count(t.failures),
                                    percent(t.failureRate),
                                ],
                            }))}
                            empty="No review in this range recorded its tool calls."
                        />
                    </Card>
                    <Card title="Open Code Review versions">
                        <DataTable
                            caption="Reviews by Open Code Review version"
                            columns={[{ label: "Version" }, ...PERF_COLUMNS]}
                            rows={perfRows(p.ocrVersions, (k) => k)}
                        />
                    </Card>
                </div>
                <Card title="By model">
                    <DataTable
                        caption="Model performance"
                        columns={[{ label: "Model" }, ...PERF_COLUMNS]}
                        rows={perfRows(p.byModel, (k) => <span className="font-mono text-xs">{k}</span>)}
                    />
                </Card>
            </div>
        </details>
    );
}
