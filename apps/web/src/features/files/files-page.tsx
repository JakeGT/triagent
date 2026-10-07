// Files with findings on the branch, the most open (weighted by severity) first.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SEVERITIES, STATUSES } from "@triagent/shared";
import { useDeferredValue, useId, useState } from "react";
import { LoadError, LoadingRows } from "@/components/load-state";
import { SeverityBar } from "@/components/marks";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { plural, SEVERITY_LABEL, STATUS_LABEL } from "@/lib/format";
import { filesQuery } from "@/lib/queries";
import { useProject } from "@/lib/session";

export function FilesPage() {
    const { ws, slug, project, branch, branchParam } = useProject();
    const filterId = useId();
    const [filter, setFilter] = useState("");
    const deferred = useDeferredValue(filter.trim().toLowerCase());
    const query = useQuery(filesQuery(ws, slug, branch));
    const all = query.data?.items ?? [];
    const items = deferred ? all.filter((f) => f.path.toLowerCase().includes(deferred)) : all;

    return (
        <Page>
            <PageMeta title={`Files · ${project.name}`} />
            <PageHeader
                title="Files"
                description={
                    <>
                        Files with findings on <span className="font-mono">{branch}</span>, the most open first (critical counts most).
                    </>
                }
            />
            <div className="grid max-w-sm gap-1.5">
                <Label htmlFor={filterId}>Show files whose path contains</Label>
                <Input id={filterId} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} className="font-mono" />
            </div>
            {query.isPending ? (
                <LoadingRows rows={8} />
            ) : query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} title="Couldn't load the files" />
            ) : all.length === 0 ? (
                <EmptyState title="No files with findings on this branch" />
            ) : (
                <>
                    <p className="text-sm text-muted-foreground" aria-live="polite">
                        {deferred ? `${items.length} of ${plural(all.length, "file")}` : plural(all.length, "file")}
                    </p>
                    <div className="rounded-md border">
                        <Table>
                            <TableHeader className="bg-muted/50 text-xs">
                                <TableRow>
                                    <TableHead scope="col">File</TableHead>
                                    <TableHead scope="col" className="text-end">
                                        Open
                                    </TableHead>
                                    <TableHead scope="col" className="text-end">
                                        Total
                                    </TableHead>
                                    <TableHead scope="col">Severity</TableHead>
                                    {STATUSES.map((s) => (
                                        <TableHead key={s} scope="col" className="text-end">
                                            {STATUS_LABEL[s]}
                                        </TableHead>
                                    ))}
                                    <TableHead scope="col" className="text-end">
                                        Tasks
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {items.map((f) => (
                                    <TableRow key={f.path}>
                                        <TableCell className="max-w-md truncate">
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
                                        <TableCell className="text-end tabular-nums">{f.total}</TableCell>
                                        <TableCell>
                                            <span className="flex items-center gap-2">
                                                <SeverityBar counts={f.severity} className="w-16" />
                                                <span className="text-xs text-muted-foreground tabular-nums" aria-hidden="true">
                                                    {SEVERITIES.filter((s) => f.severity[s])
                                                        .map((s) => `${f.severity[s]} ${SEVERITY_LABEL[s].toLowerCase()}`)
                                                        .join(", ")}
                                                </span>
                                            </span>
                                        </TableCell>
                                        {STATUSES.map((s) => (
                                            <TableCell key={s} className="text-end text-xs tabular-nums">
                                                {f.status[s] || <span className="text-muted-foreground">0</span>}
                                            </TableCell>
                                        ))}
                                        <TableCell className="text-end tabular-nums">{f.tasks.length}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </>
            )}
        </Page>
    );
}
