// Analytics → Models: each model side by side (how its reviews went and what they cost, then what it
// found and what became of that), how far the models of a review agree, and both over time. A rate from
// few findings says so, and is greyed out: it isn't yet worth acting on.

import { BarList, ChartFrame, ColumnChart, type Series } from "@/components/charts";
import { plural } from "@/lib/format";
import { compactCount, count, percent, seconds, usd } from "@/lib/insights-format";
import type { Analytics, ModelRow } from "@/lib/insights-types";
import { Disagreements } from "./disagreements";
import { Card, DataTable, per, pointsOf, Section, SeriesTable } from "./sections";

/** A model as people know it: its name in reviews first, the provider's id under it when that's something else. */
function ModelName({ row }: { row: ModelRow }) {
    const name = row.labels[0] ?? row.key;
    return (
        <span>
            {name}
            {(name !== row.key || row.provider) && (
                <span className="block font-mono text-xs text-muted-foreground">
                    {[name !== row.key ? row.key : null, row.provider].filter(Boolean).join(" · ")}
                </span>
            )}
        </span>
    );
}

/** A rate with what it's out of; greyed, and saying so, when that's too few to rely on. */
function Rate({ rate, of, small }: { rate: number | null; of: number; small: number }) {
    if (rate === null) return <span className="text-muted-foreground">—</span>;
    const few = of < small;
    return (
        <span
            className={few ? "text-muted-foreground" : undefined}
            title={few ? `From only ${plural(of, "finding")}: too few to rely on` : undefined}
        >
            {percent(rate)} <span className="text-xs text-muted-foreground">of {count(of)}</span>
        </span>
    );
}

const COLOURS = ["chart-1", "chart-2", "chart-3"] as const;

export function ModelsTab({ a }: { a: Analytics }) {
    const m = a.models;
    if (!m) return null;
    const unit = per(a);
    const name = (key: string) => m.rows.find((r) => r.key === key)?.labels[0] ?? key;
    const anyFindings = m.rows.some((r) => r.findings > 0);
    // Charts have three colours: the three models with the most reviews. The table views have every model.
    const charted = m.rows.slice(0, COLOURS.length);
    const series: Series[] = charted.map((r, i) => ({ key: r.key, label: name(r.key), colour: COLOURS[i] as (typeof COLOURS)[number] }));
    const everyone: Series[] = m.rows.map((r, i) => ({
        key: r.key,
        label: name(r.key),
        colour: COLOURS[i % COLOURS.length] as (typeof COLOURS)[number],
    }));
    const costs = pointsOf(a, m.series, (d) => Object.fromEntries(m.rows.map((r) => [r.key, d.models[r.key]?.cost ?? 0])));
    const accepted = pointsOf(a, m.series, (d) => Object.fromEntries(m.rows.map((r) => [r.key, d.models[r.key]?.accepted ?? 0])));
    const anyCost = m.rows.some((r) => (r.cost ?? 0) > 0);
    const anyAccepted = m.rows.some((r) => r.accepted > 0);
    const more =
        m.rows.length > charted.length
            ? ` The chart shows the ${charted.length} models with the most reviews; the table has all ${m.rows.length}.`
            : "";

    return (
        <Section
            id="models"
            title="Models"
            description="Each model side by side: how its reviews went, what it found, and what became of its findings once they were triaged."
        >
            {!m.rows.length ? (
                <p className="text-sm text-muted-foreground" data-testid="models-empty">
                    No review in this range said which model it used.
                    {m.withoutModel > 0 && ` ${plural(m.withoutModel, "review")} didn't say (uploaded reports often don't).`}
                </p>
            ) : (
                <>
                    <Card title="Reviews and cost">
                        <DataTable
                            caption="Each model's reviews: how many, how they went, how long they took and what they cost"
                            columns={[
                                { label: "Model" },
                                { label: "Reviews", numeric: true },
                                { label: "Failed", numeric: true },
                                { label: "Stalled", numeric: true },
                                { label: "Median time", numeric: true },
                                { label: "Tokens", numeric: true },
                                { label: "Cost", numeric: true },
                            ]}
                            rows={m.rows.map((r) => ({
                                key: r.key,
                                cells: [
                                    <ModelName key="m" row={r} />,
                                    count(r.reviews),
                                    r.failed ? `${count(r.failed)} (${percent(r.failureRate)})` : "0",
                                    count(r.stalled),
                                    seconds(r.medianRunSeconds),
                                    compactCount(r.tokens),
                                    usd(r.cost),
                                ],
                            }))}
                        />
                        {m.withoutModel > 0 && (
                            <p className="text-xs text-muted-foreground">
                                {plural(m.withoutModel, "review")} in this range didn't say which model{" "}
                                {m.withoutModel === 1 ? "it" : "they"} used (uploaded reports often don't), so{" "}
                                {m.withoutModel === 1 ? "isn't" : "aren't"} here.
                            </p>
                        )}
                    </Card>
                    <Card title="Findings and accuracy">
                        {anyFindings ? (
                            <DataTable
                                caption="Each model's findings: how many, how many only it found, and how many were accepted or rejected in triage"
                                columns={[
                                    { label: "Model" },
                                    { label: "Findings", numeric: true },
                                    { label: "Only it found", numeric: true },
                                    { label: "Accepted", numeric: true },
                                    { label: "Rejected", numeric: true },
                                    { label: "Acceptance rate", numeric: true },
                                    { label: "Cost per finding", numeric: true },
                                    { label: "Cost per accepted", numeric: true },
                                ]}
                                rows={m.rows.map((r) => ({
                                    key: r.key,
                                    cells: [
                                        <ModelName key="m" row={r} />,
                                        count(r.findings),
                                        count(r.unique),
                                        count(r.accepted),
                                        count(r.rejected),
                                        <Rate key="r" rate={r.acceptanceRate} of={r.accepted + r.rejected} small={m.smallSample} />,
                                        r.costPerFinding === null ? "—" : usd(r.costPerFinding),
                                        r.costPerAccepted === null ? "—" : usd(r.costPerAccepted),
                                    ],
                                }))}
                            />
                        ) : (
                            <p className="text-sm text-muted-foreground">
                                No findings to count yet: who found what is kept from reviews saved since this was added.
                            </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                            Accepted: resolved. Rejected: marked won't fix (not as a duplicate). Findings still open count for neither. A
                            rate from fewer than {m.smallSample} decided findings is greyed out: too few to rely on.
                        </p>
                    </Card>
                    {m.agreement.findings > 0 && <Agreement a={a} name={name} />}
                    {m.rows.some((r) => r.without.reviews > 0) && <Without a={a} />}
                    {(anyCost || anyAccepted) && (
                        <div className="grid gap-4 lg:grid-cols-2">
                            {anyCost && (
                                <ChartFrame
                                    title={`Cost a ${unit}, by model`}
                                    summary={`What each model's reviews cost a ${unit}.${more}`}
                                    series={series}
                                    table={
                                        <SeriesTable caption={`Cost a ${unit}, by model`} points={costs} series={everyone} format={usd} />
                                    }
                                >
                                    <ColumnChart points={costs} series={series} format={usd} />
                                </ChartFrame>
                            )}
                            {anyAccepted && (
                                <ChartFrame
                                    title={`Accepted findings a ${unit}, by model`}
                                    summary={`Findings later resolved, by the ${unit} a review first reported them and the model that found them.${more}`}
                                    series={series}
                                    table={
                                        <SeriesTable
                                            caption={`Accepted findings a ${unit}, by model`}
                                            points={accepted}
                                            series={everyone}
                                            format={count}
                                        />
                                    }
                                >
                                    <ColumnChart points={accepted} series={series} />
                                </ChartFrame>
                            )}
                        </div>
                    )}
                </>
            )}
            {/* Last, and whatever the range holds: it's about one branch's report as it stands. */}
            <Disagreements project={a.scope.project} branch={a.scope.branch} />
        </Section>
    );
}

/** What the reviews each model shared with others would have been without it: what would be missing, and what it would save. */
function Without({ a }: { a: Analytics }) {
    const rows = (a.models as NonNullable<Analytics["models"]>).rows.filter((r) => r.without.reviews > 0);
    const dash = <span className="text-muted-foreground">—</span>;
    return (
        <Card title="Without each model">
            <DataTable
                caption="For each model, over the reviews it ran alongside others: the findings that would be missing without it, and the time and cost it would save"
                columns={[
                    { label: "Model" },
                    { label: "Reviews with others", numeric: true },
                    { label: "Only it found", numeric: true },
                    { label: "Critical or high", numeric: true },
                    { label: "Since accepted", numeric: true },
                    { label: "Sooner by", numeric: true },
                    { label: "Its cost", numeric: true },
                ]}
                rows={rows.map((r) => ({
                    key: r.key,
                    cells: [
                        <ModelName key="m" row={r} />,
                        count(r.without.reviews),
                        count(r.unique),
                        count(r.without.serious),
                        count(r.without.accepted),
                        r.without.slowestIn ? (
                            <span key="t">
                                {seconds(r.without.secondsSaved)}{" "}
                                <span className="text-xs text-muted-foreground">in {count(r.without.slowestIn)}</span>
                            </span>
                        ) : (
                            <span key="t" title="It was never the last model to finish">
                                {dash}
                            </span>
                        ),
                        usd(r.without.cost),
                    ],
                }))}
            />
            <p className="text-xs text-muted-foreground">
                What dropping a model would lose and save. A review's models run at once, so it ends when the slowest does: "Sooner by" is
                how much earlier the reviews it finished last in would have ended. Findings only it found may still be wrong: see its
                acceptance rate above.
            </p>
        </Card>
    );
}

/** Of the findings from reviews run with several models: how many found each, and model by model. */
function Agreement({ a, name }: { a: Analytics; name(key: string): string }) {
    const g = (a.models as NonNullable<Analytics["models"]>).agreement;
    const small = (a.models as NonNullable<Analytics["models"]>).smallSample;
    const keys = [...new Set(g.overlap.flatMap((o) => [o.a, o.b]))].sort();
    return (
        <div className="grid gap-4 lg:grid-cols-2" data-testid="agreement">
            <Card title="How far models agree">
                <BarList
                    label="Findings from reviews with several models, by how many of the models found them"
                    rows={[
                        { key: "all", label: "Every model found it", value: g.all, barClass: "bg-chart-1" },
                        { key: "several", label: "Several did", value: g.several, barClass: "bg-chart-1" },
                        { key: "one", label: "Only one did", value: g.one, barClass: "bg-chart-1" },
                    ]}
                />
                <p className="text-xs text-muted-foreground">
                    Of {plural(g.findings, "finding")} from reviews run with several models. Two models' findings are the same when they're
                    about the same place and kind of problem.
                </p>
            </Card>
            <Card title="Model by model">
                {keys.length > 3 ? (
                    // With four or more, a row for every pair runs long: a grid instead, a row for each model.
                    <DataTable
                        caption="Of each model's findings (rows), the share each other model of the same review also found (columns)"
                        columns={[
                            { label: "Of the findings of" },
                            ...keys.map((k) => ({ label: `${String(name(k))} also found`, numeric: true })),
                        ]}
                        rows={keys.map((row) => ({
                            key: row,
                            cells: [
                                name(row),
                                ...keys.map((col) => {
                                    const o = g.overlap.find((x) => x.a === row && x.b === col);
                                    return o ? (
                                        <Rate key={col} rate={o.share} of={o.of} small={small} />
                                    ) : (
                                        <span key={col} className="text-muted-foreground">
                                            —
                                        </span>
                                    );
                                }),
                            ],
                        }))}
                    />
                ) : (
                    <DataTable
                        caption="Of one model's findings, the share another model of the same review also found"
                        columns={[{ label: "Of the findings of" }, { label: "Also found by" }, { label: "Share", numeric: true }]}
                        rows={g.overlap.map((o) => ({
                            key: `${o.a}\n${o.b}`,
                            cells: [name(o.a), name(o.b), <Rate key="r" rate={o.share} of={o.of} small={small} />],
                        }))}
                        empty="No two models have reviewed the same change in this range."
                    />
                )}
            </Card>
        </div>
    );
}
