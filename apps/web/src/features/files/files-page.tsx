// Files with findings on the branch, the most open (weighted by severity) first.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SEVERITIES, STATUSES } from "@triagent/shared";
import { useDeferredValue, useState } from "react";
import { Field } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { SeverityBar } from "@/components/marks";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FirstReviewActions, useNoReportYet } from "@/features/runs/first-review";
import { plural, SEVERITY_LABEL, STATUS_LABEL } from "@/lib/format";
import { filesQuery } from "@/lib/queries";
import { useProject } from "@/lib/session";

export function FilesPage() {
    const { ws, slug, project, branch, branchParam } = useProject();
    const [filter, setFilter] = useState("");
    const deferred = useDeferredValue(filter.trim().toLowerCase());
    const query = useQuery(filesQuery(ws, slug, branch));
    const all = query.data?.items ?? [];
    const items = deferred ? all.filter((f) => f.path.toLowerCase().includes(deferred)) : all;
    const noReport = useNoReportYet();

    return (
        <Page>
            <PageMeta title={`Files · ${project.name}`} />
            <PageHeader
                title="Files"
                description={
                    <>
                        Files with findings on <span className="font-mono">{branch}</span>, those with the most still to do first (critical
                        counts most).
                    </>
                }
            />
            <Field label="Show files whose path contains" width="lg">
                {(p) => <Input {...p} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} className="font-mono" />}
            </Field>
            {query.isPending ? (
                <LoadingRows rows={8} />
            ) : query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} title="Couldn't load the files" />
            ) : all.length === 0 ? (
                noReport ? (
                    <EmptyState title="No files with findings on this branch yet" action={<FirstReviewActions />}>
                        Files shows which files a review found the most in, and how much of it is still open. It fills in when the branch
                        has a report.
                    </EmptyState>
                ) : (
                    <EmptyState title="No files with findings on this branch">The branch's report has no findings.</EmptyState>
                )
            ) : (
                <>
                    <p className="text-sm text-muted-foreground" aria-live="polite">
                        {deferred ? `${items.length} of ${plural(all.length, "file")}` : plural(all.length, "file")}
                    </p>
                    <TableFrame>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead scope="col">File</TableHead>
                                    {/* Open and in progress together; each has its own column further along. */}
                                    <TableHead scope="col" className="text-end">
                                        Still to do
                                    </TableHead>
                                    <TableHead scope="col" className="hidden text-end sm:table-cell">
                                        Findings
                                    </TableHead>
                                    <TableHead scope="col">Severity</TableHead>
                                    {STATUSES.map((s) => (
                                        <TableHead key={s} scope="col" className="hidden text-end sm:table-cell">
                                            {STATUS_LABEL[s]}
                                        </TableHead>
                                    ))}
                                    <TableHead scope="col" className="hidden text-end sm:table-cell">
                                        Tasks
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {items.map((f) => (
                                    <TableRow key={f.path}>
                                        <TableCell className="max-w-40 truncate sm:max-w-md">
                                            <Link
                                                to="/w/$ws/p/$project/issues"
                                                params={{ ws, project: slug }}
                                                search={{ branch: branchParam, path: f.path } as never}
                                                className="font-mono text-xs hover:underline"
                                                title={f.path}
                                            >
                                                {f.path}
                                            </Link>
                                        </TableCell>
                                        <TableCell className="text-end tabular-nums">{f.open}</TableCell>
                                        <TableCell className="hidden text-end tabular-nums sm:table-cell">{f.total}</TableCell>
                                        <TableCell>
                                            <span className="flex items-center gap-2">
                                                <SeverityBar counts={f.severity} className="w-16" />
                                                <span
                                                    className="hidden text-xs text-muted-foreground tabular-nums sm:inline"
                                                    aria-hidden="true"
                                                >
                                                    {SEVERITIES.filter((s) => f.severity[s])
                                                        .map((s) => `${f.severity[s]} ${SEVERITY_LABEL[s].toLowerCase()}`)
                                                        .join(", ")}
                                                </span>
                                            </span>
                                        </TableCell>
                                        {STATUSES.map((s) => (
                                            <TableCell key={s} className="hidden text-end text-xs tabular-nums sm:table-cell">
                                                {f.status[s] || <span className="text-muted-foreground">0</span>}
                                            </TableCell>
                                        ))}
                                        <TableCell className="hidden text-end tabular-nums sm:table-cell">{f.tasks.length}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableFrame>
                </>
            )}
        </Page>
    );
}
