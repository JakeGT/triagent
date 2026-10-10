// A comparison of models: what a review started with "Compare models only" found. Each model's own
// figures, how much they found in common, and the findings with who found each. Nothing here is the
// branch's report: that, and its triage, are as they were.

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Field, NativeSelect } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { InlineCode, Markdown } from "@/components/markdown";
import { SeverityMark } from "@/components/marks";
import { ModelChips } from "@/components/model-choice";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isApiError } from "@/lib/api";
import { CATEGORY_LABEL, lines, plural } from "@/lib/format";
import { usd } from "@/lib/insights-format";
import { modelComparisonQuery } from "@/lib/queries";
import { useProject } from "@/lib/session";
import type { ComparedFinding, ModelComparison } from "@/lib/types";
import { duration, RunStatusBadge } from "./run-bits";

/** Which findings to list: all, those more than one model found, those only one did, or one model's (its place in the comparison). */
type Show = "all" | "agreed" | "single" | `model:${number}`;

function shown(c: ModelComparison, show: Show): ComparedFinding[] {
    if (show === "agreed") return c.findings.filter((f) => f.foundBy.length > 1);
    if (show === "single") return c.findings.filter((f) => f.foundBy.length === 1);
    if (show.startsWith("model:")) {
        const label = c.models[Number(show.slice(6))]?.label ?? "";
        return c.findings.filter((f) => f.foundBy.includes(label));
    }
    return c.findings;
}

export function ComparisonPage() {
    const { runId } = useParams({ from: "/authed/w/$ws/p/$project/comparisons/$runId" });
    const { ws, slug, project } = useProject();
    const query = useQuery(modelComparisonQuery(ws, runId));
    const [show, setShow] = useState<Show>("all");
    const back = (
        <Button variant="outline" size="sm" asChild>
            <Link to="/w/$ws/p/$project/runs/$runId" params={{ ws, project: slug, runId }}>
                <ArrowLeft /> The run
            </Link>
        </Button>
    );
    if (query.isPending)
        return (
            <Page>
                <PageMeta title={`Comparison · ${project.name}`} />
                <LoadingRows rows={5} />
            </Page>
        );
    if (query.isError) {
        // Not finished, or it failed: the server says which, and the run's page has the rest.
        const waiting = isApiError(query.error, 409);
        return (
            <Page>
                <PageMeta title={`Comparison · ${project.name}`} />
                <PageHeader title="Comparison" actions={back} />
                {waiting ? (
                    <EmptyState title="Nothing to compare yet">{query.error.message} The run's page shows how it's going.</EmptyState>
                ) : (
                    <LoadError
                        error={query.error}
                        title={isApiError(query.error, 404) ? "No such comparison" : "Couldn't load the comparison"}
                        onRetry={isApiError(query.error, 404) ? undefined : () => query.refetch()}
                    />
                )}
            </Page>
        );
    }
    const c = query.data;
    const finished = c.models.filter((m) => m.total !== null);
    const list = shown(c, show);
    return (
        <Page>
            <PageMeta title={`${c.run.title} · ${project.name}`} />
            <PageHeader
                title={c.run.title}
                description={
                    <>
                        What each model found reviewing <span className="font-mono text-xs">{c.run.branch}</span>
                        {c.run.headSha ? ` at ${c.run.headSha.slice(0, 10)}` : ""}. The branch's report and its triage are as they were, and
                        nothing was posted on GitHub.
                    </>
                }
                actions={back}
            />
            <section aria-labelledby="comparison-models" className="grid gap-3">
                <h2 id="comparison-models" className="section-title">
                    Models
                </h2>
                <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="comparison-summary">
                    <RunStatusBadge status={c.run.status} />
                    {plural(c.total, "finding")} between them, {c.agreed} found by more than one model.
                </p>
                <TableFrame>
                    <Table data-testid="comparison-models">
                        <TableHeader>
                            <TableRow>
                                <TableHead scope="col">Model</TableHead>
                                <TableHead scope="col" className="text-end">
                                    Findings
                                </TableHead>
                                <TableHead scope="col" className="text-end">
                                    Only it found
                                </TableHead>
                                <TableHead scope="col" className="text-end">
                                    Another found too
                                </TableHead>
                                <TableHead scope="col" className="text-end">
                                    Tokens
                                </TableHead>
                                <TableHead scope="col" className="text-end">
                                    Cost
                                </TableHead>
                                <TableHead scope="col" className="text-end">
                                    Time
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {c.models.map((m) => (
                                <TableRow key={m.label}>
                                    <TableHead scope="row" className="font-normal whitespace-normal">
                                        <span className="font-mono text-xs break-all">{m.label}</span>
                                        {m.total === null && (
                                            <span className="block text-xs text-muted-foreground">
                                                {m.status === "cancelled" ? "Cancelled" : `Didn't finish${m.error ? `: ${m.error}` : ""}`}
                                            </span>
                                        )}
                                    </TableHead>
                                    <TableCell className="text-end tabular-nums">{m.total ?? "—"}</TableCell>
                                    <TableCell className="text-end tabular-nums">{m.unique ?? "—"}</TableCell>
                                    <TableCell className="text-end tabular-nums">{m.shared ?? "—"}</TableCell>
                                    <TableCell className="text-end tabular-nums">
                                        {m.tokens ? m.tokens.total.toLocaleString("en-GB") : "—"}
                                    </TableCell>
                                    <TableCell className="text-end tabular-nums">{m.tokens ? usd(m.cost) : "—"}</TableCell>
                                    <TableCell className="text-end tabular-nums">
                                        {m.seconds === null ? "—" : duration(m.seconds)}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableFrame>
            </section>
            {finished.length > 1 && (
                <section aria-labelledby="comparison-overlap" className="grid gap-3">
                    <h2 id="comparison-overlap" className="section-title">
                        Found in common
                    </h2>
                    <p className="text-sm text-muted-foreground">
                        How many findings each pair of models both made. Where a model meets itself: all it found.
                    </p>
                    <TableFrame>
                        <Table data-testid="comparison-overlap">
                            <TableHeader>
                                <TableRow>
                                    <TableHead scope="col">
                                        <span className="sr-only">Model</span>
                                    </TableHead>
                                    {c.models.map(
                                        (m) =>
                                            m.total !== null && (
                                                <TableHead key={m.label} scope="col" className="text-end font-mono whitespace-normal">
                                                    {m.label}
                                                </TableHead>
                                            ),
                                    )}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {c.models.map(
                                    (m, i) =>
                                        m.total !== null && (
                                            <TableRow key={m.label}>
                                                <TableHead scope="row" className="font-mono text-xs font-normal whitespace-normal">
                                                    {m.label}
                                                </TableHead>
                                                {c.models.map(
                                                    (other, j) =>
                                                        other.total !== null && (
                                                            <TableCell
                                                                key={other.label}
                                                                className={`text-end tabular-nums ${i === j ? "text-muted-foreground" : ""}`}
                                                            >
                                                                {c.overlap[i]?.[j] ?? 0}
                                                            </TableCell>
                                                        ),
                                                )}
                                            </TableRow>
                                        ),
                                )}
                            </TableBody>
                        </Table>
                    </TableFrame>
                </section>
            )}
            <section aria-labelledby="comparison-findings" className="grid gap-3">
                <h2 id="comparison-findings" className="section-title">
                    Findings
                </h2>
                <Field label="Show" width="md">
                    {(p) => (
                        <NativeSelect {...p} value={show} onChange={(e) => setShow(e.target.value as Show)}>
                            <option value="all">Every finding</option>
                            <option value="agreed">Found by more than one model</option>
                            <option value="single">Found by one model only</option>
                            {c.models.map(
                                (m, i) =>
                                    m.total !== null && (
                                        <option key={m.label} value={`model:${i}`}>
                                            Found by {m.label}
                                        </option>
                                    ),
                            )}
                        </NativeSelect>
                    )}
                </Field>
                {c.truncated && (
                    <p className="text-sm text-muted-foreground">
                        The {c.findings.length.toLocaleString("en-GB")} findings most models agree on are listed, of{" "}
                        {c.total.toLocaleString("en-GB")}; the figures above count them all.
                    </p>
                )}
                {list.length === 0 ? (
                    <p className="text-sm text-muted-foreground" data-testid="comparison-none">
                        {c.findings.length === 0 ? "No model found anything." : "No findings like that."}
                    </p>
                ) : (
                    <ul className="grid gap-2" data-testid="comparison-findings">
                        {list.map((f, i) => (
                            // The list is as the server sent it and never reorders, so a finding's place is what it is.
                            // biome-ignore lint/suspicious/noArrayIndexKey: see above
                            <li key={`${show}-${i}`} className="grid gap-1 rounded-md border bg-card p-3">
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                    <SeverityMark severity={f.severity} />
                                    <span className="text-muted-foreground">
                                        {CATEGORY_LABEL[f.category as keyof typeof CATEGORY_LABEL] ?? f.category}
                                    </span>
                                    <span className="font-mono text-muted-foreground break-all">
                                        {f.path}
                                        {f.startLine ? `:${lines(f.startLine, f.endLine)}` : ""}
                                    </span>
                                </div>
                                <details className="group">
                                    <summary className="cursor-pointer text-sm font-medium">
                                        <InlineCode text={f.title} />
                                    </summary>
                                    <div className="pt-2">
                                        <Markdown>{f.content}</Markdown>
                                    </div>
                                </details>
                                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                    {f.foundBy.length === finished.length && finished.length > 1
                                        ? `Found by all ${finished.length} models`
                                        : f.foundBy.length === 1
                                          ? "Found by one model"
                                          : `Found by ${f.foundBy.length} of ${finished.length}`}
                                    <ModelChips labels={f.foundBy} />
                                </p>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </Page>
    );
}
