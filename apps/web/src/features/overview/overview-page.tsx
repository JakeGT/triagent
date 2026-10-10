// A branch at a glance: how far triage has got, where the problems are and what changed lately.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SEVERITIES, type Severity, STATUSES, type Status } from "@triagent/shared";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { ExampleBadge } from "@/components/example-badge";
import { FormSection } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { InlineCode } from "@/components/markdown";
import { SeverityBar, SeverityMark, StatusMark } from "@/components/marks";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CATEGORY_LABEL, formatDateTime, plural, STATUS_LABEL, timeAgo } from "@/lib/format";
import { overviewQuery } from "@/lib/queries";
import { useMe, useProject } from "@/lib/session";
import { isExample } from "@/lib/tutorial";
import type { Overview } from "@/lib/types";
import { cn } from "@/lib/utils";
import { describeActivity } from "../activity/describe";
import { FirstReviewActions } from "../runs/first-review";

const SEV_BG: Record<Severity, string> = {
    critical: "bg-sev-critical",
    high: "bg-sev-high",
    medium: "bg-sev-medium",
    low: "bg-sev-low",
};

/** A table gets a frame; a short list sits on the page under its heading, with a hairline above. */
function Section({ title, children, action, plain }: { title: string; children: ReactNode; action?: ReactNode; plain?: boolean }) {
    return (
        <FormSection title={title} aside={action} level={2} plain={plain} className={plain ? "border-t pt-4" : undefined}>
            {children}
        </FormSection>
    );
}

export function OverviewPage() {
    const { ws, slug, project, branch, branchParam } = useProject();
    const query = useQuery(overviewQuery(ws, slug, branch));
    const example = isExample(useMe(), ws, slug);
    const params = { ws, project: slug };
    /** Search for a link to Issues on this branch. */
    const issues = (filters: Record<string, unknown> = {}) => ({ branch: branchParam, ...filters }) as never;
    const meta = (
        <PageMeta
            title={`Overview · ${project.name}`}
            markdown={`/api/v1/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(slug)}/overview.md?branch=${encodeURIComponent(branch)}`}
        />
    );
    const header = (
        <PageHeader
            title="Overview"
            description={
                <>
                    {project.name}, branch <span className="font-mono">{branch}</span>
                    {example && <ExampleBadge className="ms-2" />}
                </>
            }
        />
    );

    if (query.isPending)
        return (
            <Page>
                {meta}
                {header}
                <LoadingRows rows={8} />
            </Page>
        );
    if (query.isError)
        return (
            <Page>
                {meta}
                {header}
                <LoadError error={query.error} onRetry={() => query.refetch()} title="Couldn't load the overview" />
            </Page>
        );

    const o: Overview = query.data;
    if (!o.meta.loaded)
        return (
            <Page>
                {meta}
                {header}
                <EmptyState title="No report on this branch yet" action={<FirstReviewActions />}>
                    Overview shows how far triage has got on a branch: what's still to do, where the problems are and what changed lately.
                    Start a review, upload the JSON report Open Code Review wrote, or send one from CI (see{" "}
                    <Link to="/w/$ws/agents" params={{ ws }} search={{ project: slug }} className="link">
                        Agents &amp; API
                    </Link>
                    ).
                </EmptyState>
            </Page>
        );

    const upload = o.meta.upload;
    const pct = o.totals.issues ? Math.round((o.totals.done / o.totals.issues) * 100) : 0;
    const tiles: { label: string; value: number; link: ReactElement<{ className?: string }> }[] = [
        {
            label: "Issues",
            value: o.totals.issues,
            link: <Link to="/w/$ws/p/$project/issues" params={params} search={issues()} />,
        },
        {
            label: "Still to do",
            value: o.totals.remaining,
            link: <Link to="/w/$ws/p/$project/issues" params={params} search={issues({ status: ["open", "in_progress"] })} />,
        },
        {
            label: "Done",
            value: o.totals.done,
            link: <Link to="/w/$ws/p/$project/issues" params={params} search={issues({ status: ["resolved", "wont_fix"] })} />,
        },
        {
            label: "Files",
            value: o.totals.files,
            link: <Link to="/w/$ws/p/$project/files" params={params} search={{ branch: branchParam }} />,
        },
        {
            label: "Tasks",
            value: o.totals.tasks,
            link: <Link to="/w/$ws/p/$project/tasks" params={params} search={{ branch: branchParam }} />,
        },
    ];

    return (
        <Page>
            {meta}
            {header}

            {upload && (
                <p className="text-sm text-muted-foreground">
                    Report <span className="font-mono">{upload.fileName}</span> uploaded by {upload.uploadedBy}{" "}
                    <time dateTime={upload.uploadedAt} title={formatDateTime(upload.uploadedAt)}>
                        {timeAgo(upload.uploadedAt)}
                    </time>
                    {upload.commit && (
                        <>
                            {" "}
                            at commit <span className="font-mono">{upload.commit.slice(0, 10)}</span>
                        </>
                    )}
                    . {upload.scope === "diff" ? "It reviewed only the branch's changes." : "It reviewed the whole codebase."}
                </p>
            )}
            {o.meta.warnings.length > 0 && (
                <details className="rounded-md border border-sev-medium/40 bg-sev-medium/5 p-3 text-sm">
                    <summary className="cursor-pointer font-medium">{plural(o.meta.warnings.length, "warning")} from the review</summary>
                    <ul className="mt-2 grid gap-1">
                        {o.meta.warnings.map((w, i) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: warnings have no id
                            <li key={i}>
                                <span className="font-mono text-xs">{w.file}</span>: {w.message}
                            </li>
                        ))}
                    </ul>
                </details>
            )}

            {/* Plain figures, each a link to what it counts: the label is underlined, the whole figure is the target. */}
            <ul className="grid grid-cols-2 gap-x-8 gap-y-4 sm:flex sm:flex-wrap sm:gap-x-12" data-tour="overview-tiles">
                {tiles.map((t) => (
                    <li key={t.label} className="group relative grid content-start gap-0.5">
                        <p className="text-xs text-primary underline underline-offset-2 group-hover:decoration-2">{t.label}</p>
                        <p className="text-2xl leading-tight font-semibold tabular-nums">{t.value.toLocaleString("en-GB")}</p>
                        <TileLink link={t.link} label={`${t.label}: ${t.value}`} />
                    </li>
                ))}
            </ul>

            <div className="grid gap-1.5">
                <div className="flex justify-between text-sm">
                    <span>Progress</span>
                    <span className="tabular-nums">
                        {o.totals.done} of {o.totals.issues} dealt with ({pct}%)
                    </span>
                </div>
                <div
                    className="h-2.5 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label="Issues dealt with"
                    aria-valuemin={0}
                    aria-valuemax={o.totals.issues}
                    aria-valuenow={o.totals.done}
                >
                    <div className="h-full bg-st-resolved" style={{ width: `${pct}%` }} />
                </div>
                {(o.flags.needsDiscussion > 0 || o.flags.duplicates > 0) && (
                    <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground" data-testid="overview-flags">
                        {o.flags.needsDiscussion > 0 && (
                            <Link to="/w/$ws/p/$project/issues" params={params} search={issues({ needsDiscussion: true })} className="link">
                                {plural(o.flags.needsDiscussion, "issue needs", "issues need")} discussion
                            </Link>
                        )}
                        {o.flags.duplicates > 0 && (
                            <Link to="/w/$ws/p/$project/issues" params={params} search={issues({ duplicates: true })} className="link">
                                {plural(o.flags.duplicates, "issue is marked as a duplicate", "issues are marked as duplicates")}
                            </Link>
                        )}
                    </p>
                )}
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-6 lg:grid-cols-2">
                <Section title="By severity">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead scope="col">Severity</TableHead>
                                <TableHead scope="col" className="text-end">
                                    Total
                                </TableHead>
                                {STATUSES.map((s) => (
                                    <TableHead key={s} scope="col" className="text-end">
                                        {STATUS_LABEL[s]}
                                    </TableHead>
                                ))}
                                <TableHead scope="col">
                                    <span className="sr-only">Share</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {o.bySeverity.map((row) => {
                                const max = Math.max(1, ...o.bySeverity.map((r) => r.total));
                                return (
                                    <TableRow key={row.severity}>
                                        <TableCell>
                                            <Link
                                                to="/w/$ws/p/$project/issues"
                                                params={params}
                                                search={issues({ severity: [row.severity] })}
                                                className="hover:underline"
                                            >
                                                <SeverityMark severity={row.severity} />
                                            </Link>
                                        </TableCell>
                                        <TableCell className="text-end tabular-nums">{row.total}</TableCell>
                                        {STATUSES.map((s: Status) => (
                                            <TableCell key={s} className="text-end tabular-nums">
                                                {row[s] ? (
                                                    <Link
                                                        to="/w/$ws/p/$project/issues"
                                                        params={params}
                                                        search={issues({ severity: [row.severity], status: [s] })}
                                                        className="underline-offset-2 hover:underline"
                                                        aria-label={`${row[s]} ${row.severity} ${STATUS_LABEL[s].toLowerCase()}`}
                                                    >
                                                        {row[s]}
                                                    </Link>
                                                ) : (
                                                    <span className="text-muted-foreground">0</span>
                                                )}
                                            </TableCell>
                                        ))}
                                        <TableCell className="w-28">
                                            <span className="block h-2 rounded-full bg-muted" aria-hidden="true">
                                                <span
                                                    className={cn("block h-full rounded-full", SEV_BG[row.severity])}
                                                    style={{ width: `${(row.total / max) * 100}%` }}
                                                />
                                            </span>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </Section>

                <Section title="By category">
                    {o.byCategory.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No findings.</p>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead scope="col">Category</TableHead>
                                    <TableHead scope="col" className="text-end">
                                        Total
                                    </TableHead>
                                    <TableHead scope="col" className="text-end">
                                        Done
                                    </TableHead>
                                    <TableHead scope="col">Severity</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {o.byCategory.map((c) => (
                                    <TableRow key={c.category}>
                                        <TableCell>
                                            <Link
                                                to="/w/$ws/p/$project/issues"
                                                params={params}
                                                search={issues({ category: [c.category] })}
                                                className="hover:underline"
                                            >
                                                {CATEGORY_LABEL[c.category]}
                                            </Link>
                                        </TableCell>
                                        <TableCell className="text-end tabular-nums">{c.total}</TableCell>
                                        <TableCell className="text-end tabular-nums">{c.done}</TableCell>
                                        <TableCell>
                                            <SeverityBar
                                                counts={Object.fromEntries(SEVERITIES.map((s) => [s, c[s]])) as Record<Severity, number>}
                                            />
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </Section>

                <Section
                    plain
                    title="Hotspots"
                    action={
                        <Link to="/w/$ws/p/$project/files" params={params} search={{ branch: branchParam }} className="link text-sm">
                            All files
                        </Link>
                    }
                >
                    {o.hotspots.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No files with findings.</p>
                    ) : (
                        <ul className="grid grid-cols-[minmax(0,1fr)] text-sm">
                            {o.hotspots.map((f) => (
                                <li key={f.path} className="flex items-center gap-3">
                                    <Link
                                        to="/w/$ws/p/$project/issues"
                                        params={params}
                                        search={issues({ path: f.path })}
                                        className="min-w-0 flex-1 truncate py-1 font-mono text-xs hover:underline"
                                        title={f.path}
                                    >
                                        {f.path}
                                    </Link>
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                        {f.open} of {f.total} still to do
                                    </span>
                                    <SeverityBar counts={f.severity} className="w-20" />
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>

                <Section plain title={o.themesTitle ?? "Themes"}>
                    {o.themes.length === 0 ? (
                        <p className="text-sm text-muted-foreground">The reviewer's summary has no list of themes.</p>
                    ) : (
                        <ol className="grid grid-cols-[minmax(0,1fr)] gap-1.5 text-sm">
                            {o.themes.map((t) => (
                                <li key={t.id} className="flex items-start gap-3">
                                    <Link
                                        to="/w/$ws/p/$project/tasks/$taskId"
                                        params={{ ...params, taskId: t.id }}
                                        search={{ branch: branchParam }}
                                        className="min-w-0 flex-1 hover:underline"
                                    >
                                        <InlineCode text={t.title} />
                                    </Link>
                                    <StatusMark status={t.status} className="text-xs" />
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                        {t.issuesDone}/{t.issueCount}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    )}
                </Section>

                <Section
                    plain
                    title="Recent activity"
                    action={
                        <Link to="/w/$ws/p/$project/activity" params={params} className="link text-sm">
                            All activity
                        </Link>
                    }
                >
                    {o.recentActivity.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Nothing has changed yet.</p>
                    ) : (
                        <ol className="grid grid-cols-[minmax(0,1fr)] gap-1.5 text-sm">
                            {o.recentActivity.slice(0, 8).map((a) => (
                                <li key={a.id}>
                                    <span className="font-medium">{a.actor}</span> {describeActivity(a)}{" "}
                                    <time dateTime={a.at} title={formatDateTime(a.at)} className="text-xs text-muted-foreground">
                                        {timeAgo(a.at)}
                                    </time>
                                </li>
                            ))}
                        </ol>
                    )}
                </Section>
            </div>
        </Page>
    );
}

/** Stretch a router Link over its tile. */
function TileLink({ link, label }: { link: ReactElement<{ className?: string; "aria-label"?: string }>; label: string }) {
    return cloneElement(link, {
        className: "absolute -inset-1 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-label": label,
    });
}
