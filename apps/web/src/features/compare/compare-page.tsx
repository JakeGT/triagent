// What one branch's findings add to another's, and which no longer appear.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Field, FieldError, FieldRow, FieldRowActions, NativeSelect } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { InlineCode } from "@/components/markdown";
import { SeverityBar, SeverityMark, StatusMark } from "@/components/marks";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Button } from "@/components/ui/button";
import { lines, plural } from "@/lib/format";
import { branchesQuery, compareQuery } from "@/lib/queries";
import { useProject } from "@/lib/session";
import type { IssueSummary } from "@/lib/types";

export function ComparePage() {
    const { ws, slug, project } = useProject();
    const search = useSearch({ from: "/authed/w/$ws/p/$project/compare" });
    const navigate = useNavigate();
    const branches = useQuery(branchesQuery(ws, slug));
    const names = (branches.data?.items ?? []).map((b) => b.name);
    const defaultBase = project.defaultBranch;
    const defaultHead = names.find((n) => n !== defaultBase) ?? "";
    const base = search.base ?? defaultBase;
    const head = search.head ?? defaultHead;
    const [draft, setDraft] = useState<{ base?: string; head?: string }>({});
    const chosenBase = draft.base ?? base;
    const chosenHead = draft.head ?? head;
    const ready = Boolean(base && head && base !== head);
    const result = useQuery({ ...compareQuery(ws, slug, base, head), enabled: ready });

    return (
        <Page>
            <PageMeta title={`Compare · ${project.name}`} />
            <PageHeader title="Compare" description="The findings a branch adds compared with another, and those it no longer has." />
            {branches.isError && <LoadError error={branches.error} onRetry={() => branches.refetch()} title="Couldn't load the branches" />}
            {branches.data && names.length < 2 ? (
                <EmptyState title="Only one branch has a report">
                    Upload a report to another branch on{" "}
                    <Link to="/w/$ws/p/$project/branches" params={{ ws, project: slug }} className="underline">
                        Branches &amp; reports
                    </Link>{" "}
                    to compare them.
                </EmptyState>
            ) : (
                <form
                    className="grid gap-field"
                    onSubmit={(e) => {
                        e.preventDefault();
                        setDraft({});
                        void navigate({ to: ".", search: { base: chosenBase, head: chosenHead } });
                    }}
                >
                    <FieldRow columns="auto">
                        <Field label="Compare with" width="md">
                            {(p) => (
                                <NativeSelect {...p} value={chosenBase} onChange={(e) => setDraft({ ...draft, base: e.target.value })}>
                                    {names.map((n) => (
                                        <option key={n} value={n}>
                                            {n}
                                        </option>
                                    ))}
                                </NativeSelect>
                            )}
                        </Field>
                        <Field label="Branch" width="md">
                            {(p) => (
                                <NativeSelect {...p} value={chosenHead} onChange={(e) => setDraft({ ...draft, head: e.target.value })}>
                                    {names.map((n) => (
                                        <option key={n} value={n}>
                                            {n}
                                        </option>
                                    ))}
                                </NativeSelect>
                            )}
                        </Field>
                        <FieldRowActions>
                            <Button type="submit" disabled={!chosenBase || !chosenHead || chosenBase === chosenHead}>
                                Compare
                            </Button>
                        </FieldRowActions>
                    </FieldRow>
                    <FieldError message={chosenBase && chosenBase === chosenHead ? "Pick two different branches." : null} />
                </form>
            )}

            {ready &&
                (result.isPending ? (
                    <LoadingRows rows={6} />
                ) : result.isError ? (
                    <LoadError error={result.error} onRetry={() => result.refetch()} title="Couldn't compare the branches" />
                ) : (
                    <>
                        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-tour="compare-summary">
                            <div className="rounded-lg border bg-card p-3">
                                <dt className="text-xs text-muted-foreground">
                                    New on <span className="font-mono">{result.data.head}</span>
                                </dt>
                                <dd className="flex items-center gap-2 text-2xl font-semibold tabular-nums">
                                    {result.data.added.total}
                                    <SeverityBar counts={result.data.added.severity} />
                                </dd>
                            </div>
                            <div className="rounded-lg border bg-card p-3">
                                <dt className="text-xs text-muted-foreground">
                                    No longer on <span className="font-mono">{result.data.head}</span>
                                </dt>
                                <dd className="flex items-center gap-2 text-2xl font-semibold tabular-nums">
                                    {result.data.gone.total}
                                    <SeverityBar counts={result.data.gone.severity} />
                                </dd>
                            </div>
                            <div className="rounded-lg border bg-card p-3">
                                <dt className="text-xs text-muted-foreground">On both</dt>
                                <dd className="text-2xl font-semibold tabular-nums">{result.data.shared.total}</dd>
                                <dd className="text-xs text-muted-foreground">
                                    {result.data.shared.doneOnBase} dealt with on {result.data.base}, {result.data.shared.doneOnHead} on{" "}
                                    {result.data.head}
                                </dd>
                            </div>
                        </dl>
                        {result.data.headScope === "diff" && (
                            <p className="rounded-md border bg-muted/40 p-3 text-sm">
                                The report on <span className="font-mono">{result.data.head}</span> reviewed only that branch's changes, so
                                findings it no longer has weren't necessarily fixed: they may just not have been looked at.
                            </p>
                        )}
                        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
                            <IssueList
                                title={`New on ${result.data.head}`}
                                items={result.data.added.items}
                                branch={result.data.head}
                                defaultBranch={project.defaultBranch}
                                ws={ws}
                                slug={slug}
                            />
                            <IssueList
                                title={`No longer on ${result.data.head}`}
                                items={result.data.gone.items}
                                branch={result.data.base}
                                defaultBranch={project.defaultBranch}
                                ws={ws}
                                slug={slug}
                            />
                        </div>
                    </>
                ))}
        </Page>
    );
}

function IssueList({
    title,
    items,
    branch,
    defaultBranch,
    ws,
    slug,
}: {
    title: string;
    items: IssueSummary[];
    /** The branch these issues are on (the links open them there). */
    branch: string;
    defaultBranch: string;
    ws: string;
    slug: string;
}) {
    const headingId = useId();
    return (
        <section aria-labelledby={headingId} className="grid content-start gap-2">
            <h2 id={headingId} className="section-title">
                {title} <span className="font-normal text-muted-foreground">({plural(items.length, "finding")})</span>
            </h2>
            {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
            ) : (
                <ul className="grid gap-1.5 text-sm">
                    {items.map((x) => (
                        <li key={x.id} className="grid gap-0.5 rounded-md border bg-card px-3 py-2">
                            <span className="flex flex-wrap items-center gap-x-3">
                                <SeverityMark severity={x.severity} className="text-xs" />
                                <StatusMark status={x.status} className="text-xs" />
                            </span>
                            <Link
                                to="/w/$ws/p/$project/issues/$issueId"
                                params={{ ws, project: slug, issueId: x.id }}
                                search={{ branch: branch === defaultBranch ? undefined : branch } as never}
                                className="font-medium hover:underline"
                            >
                                <InlineCode text={x.title} />
                            </Link>
                            <span className="truncate font-mono text-xs text-muted-foreground">
                                {x.path}
                                {x.startLine ? `:${lines(x.startLine, x.endLine)}` : ""}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
