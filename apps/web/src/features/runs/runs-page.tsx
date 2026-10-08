// Runs: the reviews running now (with their progress), the queue (and why it's waiting), and recent
// runs. Everything refreshes from live updates; nothing polls. Choosing a run opens its log above.

import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useSearch } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { ExampleBadge } from "@/components/example-badge";
import { LoadError, LoadingRows } from "@/components/load-state";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, timeAgo } from "@/lib/format";
import { runListQuery } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import type { Run, RunList } from "@/lib/types";
import { CancelRun, duration, findingsText, kindText, progressText, RunStatusBadge } from "./run-bits";
import { StartReview } from "./start-review";

export function WaitingBanner({ list, ws }: { list: Pick<RunList, "ready" | "waiting">; ws: string }) {
    if (list.ready || !list.waiting) return null;
    return (
        <Alert data-testid="reviews-waiting">
            <AlertTriangle />
            <AlertTitle>Reviews are waiting</AlertTitle>
            <AlertDescription>
                <p>{list.waiting}</p>
                {/Review model/.test(list.waiting) && (
                    <Link to="/w/$ws/settings/review-model" params={{ ws }} className="underline">
                        Open Review model &amp; keys
                    </Link>
                )}
            </AlertDescription>
        </Alert>
    );
}

function RunLink({ run, ws, project }: { run: Run; ws: string; project: string }) {
    return (
        <>
            <Link
                to="/w/$ws/p/$project/runs/$runId"
                params={{ ws, project: run.project ?? project, runId: run.id }}
                className="font-medium hover:underline"
            >
                {run.title}
            </Link>
            {run.result?.example && <ExampleBadge className="ms-2" />}
        </>
    );
}

export function RunsPage() {
    const { ws, slug, project } = useProject();
    const can = useCan();
    const search = useSearch({ from: "/authed/w/$ws/p/$project/runs" });
    const all = search.all === "1";
    const list = useQuery(runListQuery(ws, all ? null : slug));
    const data = list.data;

    return (
        <Page>
            <PageMeta title={`Runs · ${project.name}`} />
            <PageHeader
                title="Runs"
                description={
                    <>
                        Open Code Review runs for {all ? "every project in this workspace" : project.name}.{" "}
                        <Link
                            to="/w/$ws/p/$project/runs"
                            params={{ ws, project: slug }}
                            search={all ? {} : { all: "1" }}
                            className="underline"
                        >
                            {all ? `Only ${project.name}` : "Show every project"}
                        </Link>
                    </>
                }
                actions={<StartReview />}
            />
            <Outlet />
            {list.isPending ? (
                <LoadingRows rows={6} />
            ) : list.isError ? (
                <LoadError error={list.error} onRetry={() => list.refetch()} title="Couldn't load the runs" />
            ) : data ? (
                <>
                    <WaitingBanner list={data} ws={ws} />
                    {data.recent.some((r) => r.result?.example) && (
                        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                            Runs marked Example are made up for the tutorial: nothing was fetched or reviewed, and no model was used.
                        </p>
                    )}
                    <section aria-labelledby="running-heading" className="grid gap-2">
                        <h2 id="running-heading" className="section-title">
                            Running now
                        </h2>
                        {data.running.length === 0 ? (
                            <p className="text-sm text-muted-foreground">Nothing is running.</p>
                        ) : (
                            <ul className="grid gap-2">
                                {data.running.map((r) => (
                                    <li key={r.id} className="grid gap-1 rounded-md border p-3" data-testid={`running-${r.id}`}>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <RunStatusBadge status={r.status} />
                                            <RunLink run={r} ws={ws} project={slug} />
                                            <span className="ms-auto flex items-center gap-2 text-xs text-muted-foreground">
                                                {duration(r.elapsedSeconds)}
                                                {can("operate") && <CancelRun ws={ws} run={r} compact />}
                                            </span>
                                        </div>
                                        <p className="text-sm" aria-live="off">
                                            {progressText(r)}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {kindText(r)} ·{" "}
                                            {r.model
                                                ? `${r.model.model} (${r.model.keySource === "instance" ? "instance key" : r.model.provider})`
                                                : ""}{" "}
                                            · requested by {r.source === "automation" ? "automatic reviews" : r.requestedBy.name}
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    <section aria-labelledby="queue-heading" className="grid gap-2">
                        <h2 id="queue-heading" className="section-title">
                            Queue
                        </h2>
                        {data.queued.length === 0 ? (
                            <p className="text-sm text-muted-foreground">Nothing is waiting.</p>
                        ) : (
                            <TableFrame>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead scope="col">Review</TableHead>
                                            <TableHead scope="col">Requested</TableHead>
                                            <TableHead scope="col">Waiting for</TableHead>
                                            <TableHead scope="col">
                                                <span className="sr-only">Actions</span>
                                            </TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {data.queued.map((r) => (
                                            <TableRow key={r.id}>
                                                <TableCell>
                                                    <RunLink run={r} ws={ws} project={slug} />
                                                    {kindText(r) !== r.title && (
                                                        <span className="block text-xs text-muted-foreground">{kindText(r)}</span>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-xs">
                                                    {r.source === "automation" ? "Automatically" : `By ${r.requestedBy.name}`},{" "}
                                                    <time dateTime={r.queuedAt} title={formatDateTime(r.queuedAt)}>
                                                        {timeAgo(r.queuedAt)}
                                                    </time>
                                                </TableCell>
                                                <TableCell className="max-w-md text-xs whitespace-normal">{r.waiting}</TableCell>
                                                <TableCell className="text-end">
                                                    {can("operate") && <CancelRun ws={ws} run={r} compact />}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </TableFrame>
                        )}
                    </section>

                    <section aria-labelledby="recent-heading" className="grid gap-2" data-tour="runs-recent">
                        <h2 id="recent-heading" className="section-title">
                            Recent
                        </h2>
                        {data.recent.length === 0 ? (
                            <EmptyState title="No reviews yet">
                                {can("operate")
                                    ? "Start one above, or switch on automatic reviews in the project's Automation settings."
                                    : "Reviews appear here once someone starts one, or automatic reviews are switched on."}
                            </EmptyState>
                        ) : (
                            <TableFrame>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead scope="col">Status</TableHead>
                                            <TableHead scope="col">Review</TableHead>
                                            <TableHead scope="col">Branch</TableHead>
                                            <TableHead scope="col">Result</TableHead>
                                            <TableHead scope="col">Finished</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {data.recent.map((r) => (
                                            <TableRow key={r.id} data-testid={`recent-${r.id}`}>
                                                <TableCell>
                                                    <RunStatusBadge status={r.status} />
                                                </TableCell>
                                                <TableCell className="whitespace-normal">
                                                    <RunLink run={r} ws={ws} project={slug} />
                                                    {all && r.project && (
                                                        <span className="block text-xs text-muted-foreground">{r.project}</span>
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    {r.project && (r.status === "done" || r.status === "partial") ? (
                                                        <Link
                                                            to="/w/$ws/p/$project/issues"
                                                            params={{ ws, project: r.project }}
                                                            search={{ branch: r.branch }}
                                                            className="font-mono text-xs hover:underline"
                                                        >
                                                            {r.branch}
                                                        </Link>
                                                    ) : (
                                                        <span className="font-mono text-xs">{r.branch}</span>
                                                    )}
                                                </TableCell>
                                                <TableCell className="max-w-sm text-xs whitespace-normal">
                                                    {r.status === "done" || r.status === "partial" ? findingsText(r) : (r.error ?? "")}
                                                </TableCell>
                                                <TableCell className="text-xs">
                                                    {r.finishedAt && (
                                                        <time dateTime={r.finishedAt} title={formatDateTime(r.finishedAt)}>
                                                            {timeAgo(r.finishedAt)}
                                                        </time>
                                                    )}
                                                    {r.elapsedSeconds !== null && r.startedAt && (
                                                        <span className="block text-muted-foreground">
                                                            took {duration(r.elapsedSeconds)}
                                                        </span>
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </TableFrame>
                        )}
                    </section>
                    <p className="text-xs text-muted-foreground">
                        {data.runners.length
                            ? `Runners connected: ${data.runners.map((r) => (r.version ? `${r.name} (${r.version})` : r.name)).join(", ")}.`
                            : data.runnersConnected
                              ? `${data.runnersConnected} runner${data.runnersConnected === 1 ? "" : "s"} connected.`
                              : "No runner is connected."}{" "}
                        At most {data.concurrency.instance} review{data.concurrency.instance === 1 ? "" : "s"} at once on this instance,{" "}
                        {data.concurrency.workspace} per workspace.
                    </p>
                </>
            ) : null}
        </Page>
    );
}
