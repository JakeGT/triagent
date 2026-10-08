// One run: what it reviews, how it's going or how it ended, and its log. The log is fetched from where
// the last fetch left off whenever a live update says the run moved on, so only new lines travel.

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Button } from "@/components/ui/button";
import { api, isApiError, paths } from "@/lib/api";
import { formatDateTime, plural } from "@/lib/format";
import { keys } from "@/lib/queries";
import { safeHref } from "@/lib/safe-href";
import { useCan, useProject } from "@/lib/session";
import type { LogLine, RunDetail } from "@/lib/types";
import { CancelRun, duration, findingsText, kindText, progressText, RunStatusBadge } from "./run-bits";

const KEEP_LINES = 5000;

export function RunPanel() {
    const { runId } = useParams({ from: "/authed/w/$ws/p/$project/runs/$runId" });
    // A fresh panel (and log) for each run.
    return <RunDetailView key={runId} runId={runId} />;
}

function RunDetailView({ runId }: { runId: string }) {
    const { ws, slug } = useProject();
    const can = useCan();
    const lines = useRef<LogLine[]>([]);
    const cursor = useRef(0);
    const heading = useRef<HTMLHeadingElement>(null);
    const logBox = useRef<HTMLElement>(null);
    const stick = useRef(true);
    const run = useQuery({
        queryKey: keys.run(ws, runId),
        queryFn: async ({ signal }) => {
            const r = await api.get<RunDetail>(
                `${paths.workspace(ws)}/runs/${encodeURIComponent(runId)}`,
                { after: cursor.current },
                { signal },
            );
            if (r.logLines.length) {
                lines.current = [...lines.current, ...r.logLines].slice(-KEEP_LINES);
                cursor.current = r.logLines.at(-1)?.seq ?? cursor.current;
            }
            return { ...r, all: lines.current };
        },
        staleTime: 0,
    });

    useEffect(() => {
        heading.current?.focus();
    }, []);
    // Follow the end of the log, unless the person has scrolled up to read.
    useLayoutEffect(() => {
        const box = logBox.current;
        if (box && stick.current) box.scrollTop = box.scrollHeight;
    });

    const close = (
        <Button variant="ghost" size="icon" asChild>
            <Link to="/w/$ws/p/$project/runs" params={{ ws, project: slug }} aria-label="Close the run">
                <X />
            </Link>
        </Button>
    );
    if (run.isPending) return <LoadingRows rows={4} />;
    if (run.isError)
        return (
            <div className="flex items-start gap-2">
                <LoadError
                    error={run.error}
                    title={isApiError(run.error, 404) ? "No such run" : "Couldn't load the run"}
                    onRetry={isApiError(run.error, 404) ? undefined : () => run.refetch()}
                />
                {close}
            </div>
        );
    const r = run.data;
    const prUrl = safeHref(r.pr?.url ?? null);
    const active = r.status === "queued" || r.status === "running";
    return (
        <section aria-labelledby="run-heading" className="grid gap-3 rounded-lg border p-4" data-testid="run-panel">
            <div className="flex flex-wrap items-start gap-2">
                <div className="grid min-w-0 flex-1 gap-1">
                    <h2 id="run-heading" ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
                        {r.title}
                    </h2>
                    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <RunStatusBadge status={r.status} />
                        {kindText(r)}
                        {prUrl && (
                            <a href={prUrl} target="_blank" rel="noopener noreferrer" className="underline">
                                on GitHub<span className="sr-only"> (opens in a new tab)</span>
                            </a>
                        )}
                    </p>
                </div>
                {can("operate") && active && <CancelRun ws={ws} run={r} />}
                {close}
            </div>
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">Branch</dt>
                <dd className="font-mono text-xs">
                    {r.status === "done" || r.status === "partial" ? (
                        <Link
                            to="/w/$ws/p/$project/issues"
                            params={{ ws, project: slug }}
                            search={{ branch: r.branch }}
                            className="underline"
                        >
                            {r.branch}
                        </Link>
                    ) : (
                        r.branch
                    )}
                    {r.headSha && ` at ${r.headSha.slice(0, 10)}`}
                </dd>
                <dt className="text-muted-foreground">Requested</dt>
                <dd>
                    {r.source === "automation" ? "Automatically" : `By ${r.requestedBy.name}`}, {formatDateTime(r.queuedAt)}
                </dd>
                {r.model && (
                    <>
                        <dt className="text-muted-foreground">Model</dt>
                        <dd>
                            {r.model.model} (
                            {r.model.keySource === "instance" ? "the instance's key" : `the workspace's ${r.model.provider} key`})
                        </dd>
                    </>
                )}
                {r.status === "running" && (
                    <>
                        <dt className="text-muted-foreground">Progress</dt>
                        <dd data-testid="run-progress">{progressText(r)}</dd>
                    </>
                )}
                {r.status === "queued" && r.waiting && (
                    <>
                        <dt className="text-muted-foreground">Waiting for</dt>
                        <dd>{r.waiting}</dd>
                    </>
                )}
                {r.startedAt && (
                    <>
                        <dt className="text-muted-foreground">{active ? "Running for" : "Took"}</dt>
                        <dd>{duration(r.elapsedSeconds)}</dd>
                    </>
                )}
                {(r.status === "done" || r.status === "partial") && r.result && (
                    <>
                        <dt className="text-muted-foreground">Found</dt>
                        <dd>
                            {findingsText(r)}
                            {r.result.counts &&
                                `: ${plural(r.result.counts.added, "new finding")}, ${r.result.counts.carriedOver} carried over, ${r.result.counts.removed} gone`}
                            {r.result.tokens && `. ${r.result.tokens.total.toLocaleString("en-GB")} model tokens.`}
                        </dd>
                    </>
                )}
                {r.error && (
                    <>
                        <dt className="text-muted-foreground">{r.status === "cancelled" ? "Why" : "What went wrong"}</dt>
                        <dd className="whitespace-pre-wrap">{r.error}</dd>
                    </>
                )}
                {r.result?.gaps && (
                    <>
                        <dt className="text-muted-foreground">Not finished</dt>
                        <dd>{r.result.gaps.note}</dd>
                    </>
                )}
            </dl>
            <div className="grid gap-1">
                <h3 className="text-sm font-medium" id="run-log-heading">
                    Log{r.log.dropped ? ` (the first ${plural(r.log.dropped, "line")} were dropped to save space)` : ""}
                </h3>
                {r.all.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {r.status === "queued" ? "Nothing yet: it hasn't started." : "No log lines."}
                    </p>
                ) : (
                    // A scrollable section the keyboard can reach; not a live region, which would read every line out.
                    <section
                        ref={logBox}
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable by keyboard
                        tabIndex={0}
                        aria-labelledby="run-log-heading"
                        className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs"
                        onScroll={(e) => {
                            const el = e.currentTarget;
                            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                        }}
                        data-testid="run-log"
                    >
                        {r.all.map((l) => (
                            <div key={l.seq} className="break-all whitespace-pre-wrap">
                                {l.line}
                            </div>
                        ))}
                    </section>
                )}
            </div>
        </section>
    );
}
