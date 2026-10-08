// Small charts drawn with HTML and SVG: no chart library, nothing injected into the page's styles (the
// Content Security Policy refuses that). Every chart sits in a ChartFrame, which names it, gives a short
// text summary to screen readers and offers the same figures as a table. Series always have a legend, so
// colour is never the only way to tell them apart; hovering a column shows its values.

import { type ReactNode, useId, useState } from "react";
import { cn } from "@/lib/utils";

export type SeriesColour = "chart-1" | "chart-2" | "chart-3";

export interface Series {
    key: string;
    label: string;
    colour: SeriesColour;
}

const BG: Record<SeriesColour, string> = { "chart-1": "bg-chart-1", "chart-2": "bg-chart-2", "chart-3": "bg-chart-3" };
const STROKE: Record<SeriesColour, string> = { "chart-1": "stroke-chart-1", "chart-2": "stroke-chart-2", "chart-3": "stroke-chart-3" };

export interface Point {
    /** The bucket's label under the axis and in the tooltip. */
    label: string;
    /** The bucket spelt out, for the tooltip's heading. */
    long: string;
    values: Record<string, number>;
}

/** A round number at or above `max`, with the ticks below it: 0, half and the top. */
export function niceMax(max: number): number {
    if (max <= 0) return 1;
    const power = 10 ** Math.floor(Math.log10(max));
    for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return step * power;
    return 10 * power;
}

export function Legend({ series }: { series: Series[] }) {
    if (series.length < 2) return null;
    return (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
            {series.map((s) => (
                <li key={s.key} className="inline-flex items-center gap-1.5">
                    <span className={cn("inline-block size-2.5 rounded-sm", BG[s.colour])} aria-hidden="true" />
                    {s.label}
                </li>
            ))}
        </ul>
    );
}

/** A chart with its title, legend and a switch to the same figures as a table. */
export function ChartFrame({
    title,
    summary,
    series = [],
    table,
    children,
    className,
}: {
    title: string;
    /** What the chart shows, in a sentence, for people who can't see it. */
    summary: string;
    series?: Series[];
    table: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    const [view, setView] = useState<"chart" | "table">("chart");
    const id = useId();
    const button = (v: "chart" | "table", text: string) => (
        <button
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
            className={cn(
                "rounded px-2 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                view === v ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground",
            )}
        >
            {text}
        </button>
    );
    return (
        <figure aria-labelledby={`${id}-title`} className={cn("grid min-w-0 content-start gap-3 rounded-lg border bg-card p-4", className)}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <figcaption id={`${id}-title`} className="font-medium">
                    {title}
                </figcaption>
                <fieldset className="inline-flex gap-0.5 rounded-md border p-0.5 text-xs">
                    <legend className="sr-only">Show {title.toLowerCase()} as</legend>
                    {button("chart", "Chart")}
                    {button("table", "Table")}
                </fieldset>
            </div>
            {view === "chart" ? (
                <>
                    <Legend series={series} />
                    <div role="img" aria-label={summary}>
                        {children}
                    </div>
                </>
            ) : (
                <div className="max-h-80 overflow-auto">{table}</div>
            )}
        </figure>
    );
}

/** Which of `count` equal columns the pointer is over. */
function columnAt(e: React.PointerEvent<HTMLElement>, count: number): number {
    const box = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(count - 1, Math.floor(((e.clientX - box.left) / Math.max(1, box.width)) * count)));
}

function Axis({ max, format }: { max: number; format(v: number): string }) {
    return (
        <>
            {[1, 0.5, 0].map((f) => (
                <div key={f} className="absolute inset-x-0 flex items-center gap-2" style={{ bottom: `${f * 100}%` }}>
                    <span className="w-10 shrink-0 translate-y-1/2 text-end text-[0.6875rem] text-muted-foreground tabular-nums">
                        {format(max * f)}
                    </span>
                    <span className="h-px flex-1 translate-y-1/2 bg-chart-grid" />
                </div>
            ))}
        </>
    );
}

function XLabels({ points }: { points: Point[] }) {
    if (!points.length) return null;
    const last = points.length - 1;
    const shown = last >= 2 ? [0, Math.floor(last / 2), last] : points.map((_, i) => i);
    return (
        <div className="relative ms-12 h-4 text-[0.6875rem] text-muted-foreground" aria-hidden="true">
            {shown.map((i) => (
                <span
                    key={i}
                    className={cn("absolute whitespace-nowrap", i === 0 ? "" : i === last ? "-translate-x-full" : "-translate-x-1/2")}
                    style={{ left: i === 0 ? 0 : i === last ? "100%" : `${((i + 0.5) / points.length) * 100}%` }}
                >
                    {points[i]?.label}
                </span>
            ))}
        </div>
    );
}

function Tooltip({
    point,
    series,
    index,
    count,
    format,
}: {
    point: Point;
    series: Series[];
    index: number;
    count: number;
    format(v: number): string;
}) {
    const left = ((index + 0.5) / count) * 100;
    const align = left < 25 ? "" : left > 75 ? "-translate-x-full" : "-translate-x-1/2";
    return (
        <div
            className={cn(
                "pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md",
                align,
            )}
            style={{ left: `${left}%` }}
            data-testid="chart-tooltip"
        >
            <p className="font-medium">{point.long}</p>
            <ul className="mt-1 grid gap-0.5">
                {series.map((s) => (
                    <li key={s.key} className="flex items-center gap-1.5">
                        {series.length > 1 && <span className={cn("inline-block size-2 rounded-sm", BG[s.colour])} />}
                        <span className="text-muted-foreground">{s.label}</span>
                        <span className="ms-auto ps-3 font-medium tabular-nums">{format(point.values[s.key] ?? 0)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Columns over time, stacked when there's more than one series. */
export function ColumnChart({
    points,
    series,
    format = (v) => v.toLocaleString("en-GB"),
}: {
    points: Point[];
    series: Series[];
    format?(v: number): string;
}) {
    const [hover, setHover] = useState<number | null>(null);
    const totals = points.map((p) => series.reduce((n, s) => n + (p.values[s.key] ?? 0), 0));
    const max = niceMax(Math.max(0, ...totals));
    const hovered = hover === null ? null : points[hover];
    return (
        <div className="grid gap-1">
            <div className="relative h-40">
                <Axis max={max} format={format} />
                <div
                    className="absolute inset-y-0 end-0 start-12 flex items-stretch"
                    onPointerMove={(e) => setHover(columnAt(e, points.length))}
                    onPointerLeave={() => setHover(null)}
                >
                    {points.map((p, i) => (
                        <div
                            key={p.long}
                            className={cn("flex h-full flex-1 items-end justify-center px-px", hover === i && "bg-accent/60")}
                        >
                            <div
                                className="flex w-full max-w-6 flex-col-reverse gap-[2px]"
                                style={{ height: `${((totals[i] ?? 0) / max) * 100}%` }}
                            >
                                {series.map((s) => {
                                    const v = p.values[s.key] ?? 0;
                                    if (!v) return null;
                                    return (
                                        <div
                                            key={s.key}
                                            className={cn("min-h-[2px] w-full last:rounded-t-sm", BG[s.colour])}
                                            style={{ flexGrow: v, flexBasis: 0 }}
                                        />
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
                {hovered && hover !== null && (
                    <div className="pointer-events-none absolute inset-y-0 end-0 start-12">
                        <Tooltip point={hovered} series={series} index={hover} count={points.length} format={format} />
                    </div>
                )}
            </div>
            <XLabels points={points} />
        </div>
    );
}

/** Lines over time, with a crosshair and the values where it points. */
export function LineChart({
    points,
    series,
    format = (v) => v.toLocaleString("en-GB"),
}: {
    points: Point[];
    series: Series[];
    format?(v: number): string;
}) {
    const [hover, setHover] = useState<number | null>(null);
    const max = niceMax(Math.max(0, ...points.flatMap((p) => series.map((s) => p.values[s.key] ?? 0))));
    const x = (i: number) => ((i + 0.5) / points.length) * 100;
    const y = (v: number) => 100 - (v / max) * 100;
    const last = points.length - 1;
    return (
        <div className="grid gap-1">
            <div className="relative h-40">
                <Axis max={max} format={format} />
                <div className="absolute inset-y-0 end-0 start-12">
                    <svg
                        className="absolute inset-0 size-full overflow-visible"
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                    >
                        {series.map((s) => (
                            <polyline
                                key={s.key}
                                className={cn("fill-none", STROKE[s.colour])}
                                strokeWidth={2}
                                strokeLinejoin="round"
                                strokeLinecap="round"
                                vectorEffect="non-scaling-stroke"
                                points={points.map((p, i) => `${x(i)},${y(p.values[s.key] ?? 0)}`).join(" ")}
                            />
                        ))}
                    </svg>
                    {/* End dots, and the hovered column's dots, ringed in the card's colour. */}
                    {series.flatMap((s) =>
                        [last, ...(hover !== null && hover !== last ? [hover] : [])]
                            .filter((i) => i >= 0)
                            .map((i) => (
                                <span
                                    key={`${s.key}-${i}`}
                                    className={cn(
                                        "absolute size-2.5 -translate-x-1/2 translate-y-1/2 rounded-full ring-2 ring-card",
                                        BG[s.colour],
                                    )}
                                    style={{ left: `${x(i)}%`, bottom: `${100 - y(points[i]?.values[s.key] ?? 0)}%` }}
                                />
                            )),
                    )}
                    {hover !== null && <span className="absolute inset-y-0 w-px bg-border" style={{ left: `${x(hover)}%` }} />}
                    <div
                        className="absolute inset-0"
                        onPointerMove={(e) => setHover(columnAt(e, points.length))}
                        onPointerLeave={() => setHover(null)}
                    />
                    {hover !== null && points[hover] && (
                        <Tooltip point={points[hover]} series={series} index={hover} count={points.length} format={format} />
                    )}
                </div>
            </div>
            <XLabels points={points} />
        </div>
    );
}

export interface BarRow {
    key: string;
    label: ReactNode;
    value: number;
    /** The value as shown; the number itself if left out. */
    display?: string;
    /** A Tailwind background class for the bar (default: the first series colour). */
    barClass?: string;
}

/** Labelled horizontal bars: each row names itself, so colour only reinforces. */
export function BarList({ rows, max, label }: { rows: BarRow[]; max?: number; label: string }) {
    const top = max ?? Math.max(1, ...rows.map((r) => r.value));
    return (
        <ul className="grid gap-1.5 text-sm" aria-label={label}>
            {rows.map((r) => (
                <li key={r.key} className="grid grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)_auto] items-center gap-3">
                    <span className="min-w-0 truncate">{r.label}</span>
                    <span className="h-2 rounded-full bg-muted" aria-hidden="true">
                        <span
                            className={cn("block h-full rounded-full", r.barClass ?? "bg-chart-1")}
                            style={{ width: `${(r.value / top) * 100}%` }}
                        />
                    </span>
                    <span className="text-end tabular-nums">{r.display ?? r.value.toLocaleString("en-GB")}</span>
                </li>
            ))}
        </ul>
    );
}

/** How much of an allowance is used, as a bar and in words. */
export function UsageBar({ used, total, label }: { used: number; total: number; label: string }) {
    const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    return (
        <div
            className="h-2.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={Math.min(used, total)}
            aria-valuetext={`${used.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} tokens used`}
        >
            <div
                className={cn("h-full rounded-full", pct >= 100 ? "bg-sev-critical" : pct >= 80 ? "bg-sev-medium" : "bg-chart-1")}
                style={{ width: `${pct}%` }}
            />
        </div>
    );
}

/** A headline figure. */
export function Stat({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
    return (
        <div className="rounded-lg border bg-card p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-xl font-semibold">{value}</dd>
            {note && <dd className="text-xs text-muted-foreground">{note}</dd>}
        </div>
    );
}
