// Analytics → Overview: the four figures worth a glance, how reviews and findings moved over the range,
// and what needs someone's attention. Everything else is one tab away.

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ChartFrame, ColumnChart, LineChart, Stat, Stats } from "@/components/charts";
import { plural } from "@/lib/format";
import { compactCount, count, hours, usd } from "@/lib/insights-format";
import type { Analytics } from "@/lib/insights-types";
import { useWorkspace } from "@/lib/session";
import type { AnalyticsSearch, AnalyticsTab } from "./search";
import { FLOW, OUTCOMES, per, pointsOf, Section, SeriesTable } from "./sections";

/** What needs attention, most pressing first: each a sentence, with where to go about it. */
function attention(a: Analytics, tab: (t: AnalyticsTab, text: string) => ReactNode, prices: ReactNode): { key: string; text: ReactNode }[] {
    const out: { key: string; text: ReactNode }[] = [];
    const r = a.reviews;
    const f = a.findings;
    const failed = r ? r.byStatus.failed : 0;
    if (r && failed)
        out.push({
            key: "failed",
            text: (
                <>
                    {plural(failed, "review")} of {count(r.total)} failed. {tab("reviews", "See the latest reviews")}
                </>
            ),
        });
    if (f?.openBySeverity.critical)
        out.push({
            key: "critical",
            text: (
                <>
                    {plural(f.openBySeverity.critical, "critical finding is", "critical findings are")} open.{" "}
                    {tab("findings", "See where they are")}
                </>
            ),
        });
    if (f?.needsDiscussion)
        out.push({
            key: "discussion",
            text: `${plural(f.needsDiscussion, "open finding is", "open findings are")} waiting for a person to decide (flagged for discussion).`,
        });
    if (a.unpriced.length)
        out.push({
            key: "unpriced",
            text: (
                <span data-testid="unpriced">
                    No price for {a.unpriced.map((u) => `${u.model} (${compactCount(u.tokens)} tokens)`).join(", ")}, so{" "}
                    {a.unpriced.length === 1 ? "its" : "their"} tokens are left out of the costs. {prices}
                </span>
            ),
        });
    return out;
}

export function OverviewTab({ a, search }: { a: Analytics; search: AnalyticsSearch }) {
    const { ws } = useWorkspace();
    const r = a.reviews;
    const f = a.findings;
    const t = a.triage;
    if (!r || !f || !t) return null;
    const unit = per(a);
    const outcomes = pointsOf(a, r.series, (d) => ({ done: d.done, partial: d.partial, failed: d.failed + d.cancelled }));
    const flow = pointsOf(a, f.series, (d) => ({ added: d.added, closed: d.closed, reopened: d.reopened }));
    const urgent = f.openBySeverity.critical + f.openBySeverity.high;
    const needs = attention(
        a,
        (tab, text) => (
            <Link to="/w/$ws/analytics/$tab" params={{ ws, tab }} search={search as never} className="link">
                {text}
            </Link>
        ),
        <Link to="/w/$ws/settings/model-prices" params={{ ws }} className="link">
            Set model prices
        </Link>,
    );
    return (
        <Section id="overview" title="Overview" description="The range at a glance. Each figure has a tab with what's behind it.">
            <Stats>
                <Stat
                    label="Reviews"
                    value={count(r.total)}
                    note={r.total ? `${count(r.byStatus.failed)} failed, ${count(r.byStatus.partial)} partial` : "None in this range"}
                />
                <Stat
                    label="Spend"
                    value={usd(r.cost.total)}
                    note={
                        r.cost.total === null
                            ? "Set model prices to see costs"
                            : r.cost.perReview !== null
                              ? `${usd(r.cost.perReview)} a review`
                              : undefined
                    }
                />
                <Stat
                    label="Open findings"
                    value={count(f.open)}
                    note={urgent ? `${count(urgent)} critical or high` : f.open ? "None critical or high" : undefined}
                />
                <Stat
                    label="Time to resolve (median)"
                    value={hours(t.timeToResolve.medianHours)}
                    note={`${plural(t.closed, "finding")} closed`}
                />
            </Stats>
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
                    title={`Findings opened and closed a ${unit}`}
                    summary={`${count(f.added)} new findings, ${count(f.closed)} closed and ${count(f.reopenedByReview + f.reopenedByPeople)} reopened over the range.`}
                    series={FLOW}
                    table={<SeriesTable caption="New, closed and reopened findings" points={flow} series={FLOW} format={count} />}
                >
                    <LineChart points={flow} series={FLOW} />
                </ChartFrame>
            </div>
            <section aria-labelledby="attention-title" className="grid gap-2" data-testid="needs-attention">
                <h3 id="attention-title" className="section-title">
                    Needs attention
                </h3>
                {needs.length ? (
                    <ul className="grid gap-1.5 text-sm">
                        {needs.map((n) => (
                            <li key={n.key} className="flex gap-2">
                                <span aria-hidden="true" className="text-muted-foreground">
                                    –
                                </span>
                                <span>{n.text}</span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        Nothing does: no failed reviews, no critical findings open, and every model has a price.
                    </p>
                )}
            </section>
        </Section>
    );
}
