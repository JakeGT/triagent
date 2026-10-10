// One run: what it reviews, how it's going or how it ended, and its log. The log is fetched from where
// the last fetch left off whenever a live update says the run moved on, so only new lines travel.

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoadError, LoadingRows } from "@/components/load-state";
import { ModelChips, modelLabels } from "@/components/model-choice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, isApiError, paths } from "@/lib/api";
import { formatDateTime, plural } from "@/lib/format";
import { keys, modelsQuery } from "@/lib/queries";
import { safeHref } from "@/lib/safe-href";
import { useCan, useProject } from "@/lib/session";
import type { LogLine, RunDetail } from "@/lib/types";
import {
    addedText,
    attemptText,
    CancelRun,
    duration,
    findingsText,
    judgeText,
    kindText,
    linesOf,
    modelProgressText,
    optionsText,
    progressText,
    RerunModel,
    RunStatusBadge,
    retryText,
    runModelLabels,
} from "./run-bits";

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
    /** The model whose log lines are shown, in a review with several; null for every line. */
    const [logModel, setLogModel] = useState<string | null>(null);
    const run = useQuery({
        queryKey: keys.run(ws, runId),
        queryFn: async ({ signal }) => {
            const r = await api.get<RunDetail>(
                `${paths.workspace(ws)}/runs/${encodeURIComponent(runId)}`,
                { after: cursor.current },
                { signal },
            );
            // Only lines past the cursor, in case two fetches from the same cursor both answered.
            const fresh = r.logLines.filter((l) => l.seq > cursor.current);
            if (fresh.length) lines.current = [...lines.current, ...fresh].slice(-KEEP_LINES);
            // `next` also moves past lines the server no longer keeps.
            cursor.current = Math.max(cursor.current, r.next, fresh.at(-1)?.seq ?? 0);
            return { ...r, all: lines.current };
        },
        staleTime: 0,
    });

    // A run that hasn't started says which models it was asked to use, by what they're called now.
    const asked = run.data?.model ? null : (run.data?.requestedModels ?? null);
    const choices = useQuery({ ...modelsQuery(ws), enabled: Boolean(asked) });

    // Focus the heading once it's there (the first render shows the loading rows).
    const loaded = run.data !== undefined;
    useEffect(() => {
        if (loaded) heading.current?.focus();
    }, [loaded]);
    // Follow the end of the log, unless the person has scrolled up to read.
    useLayoutEffect(() => {
        const box = logBox.current;
        if (box && stick.current) box.scrollTop = box.scrollHeight;
    });

    const close = (
        <Button variant="ghost" size="icon" asChild>
            <Link to="/w/$ws/p/$project/runs" params={{ ws, project: slug }} aria-label="Close the run" title="Close the run">
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
    const shown = linesOf(r.all, logModel);
    const options = optionsText(r);
    const canOperate = can("operate");
    const logChoice = (label: string | null) => (
        <Button
            key={label ?? ""}
            type="button"
            size="sm"
            variant={logModel === label ? "secondary" : "outline"}
            className={label === null ? "h-7" : "h-auto min-h-7 max-w-full font-mono text-xs break-all whitespace-normal"}
            aria-pressed={logModel === label}
            onClick={() => {
                stick.current = true;
                setLogModel(label);
            }}
        >
            {label ?? "All lines"}
        </Button>
    );
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
                            <a href={prUrl} target="_blank" rel="noopener noreferrer" className="link">
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
                    {(r.status === "done" || r.status === "partial") && !r.options?.bakeOff ? (
                        <Link to="/w/$ws/p/$project/issues" params={{ ws, project: slug }} search={{ branch: r.branch }} className="link">
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
                {r.rerunOf && (
                    <>
                        <dt className="text-muted-foreground">{attemptText(r.rerunOf.attempt)} of</dt>
                        <dd data-testid="run-rerun-of">
                            <Badge variant="outline" className="font-mono font-normal">
                                {r.rerunOf.label}
                            </Badge>{" "}
                            in{" "}
                            <Link to="/w/$ws/p/$project/runs/$runId" params={{ ws, project: slug, runId: r.rerunOf.id }} className="link">
                                the review it failed in
                            </Link>
                            {r.rerunOf.auto ? ", run again automatically" : ""}. {r.result?.rerun ? addedText(r.result.rerun) : ""}
                        </dd>
                    </>
                )}
                {asked && choices.data && (
                    <>
                        <dt className="text-muted-foreground">Asked to use</dt>
                        <dd data-testid="run-asked-models">
                            <ModelChips labels={modelLabels(choices.data, asked)} />
                        </dd>
                    </>
                )}
                {r.model && !r.model.models && (
                    <>
                        <dt className="text-muted-foreground">Model</dt>
                        <dd data-testid="run-models">
                            <ModelChips labels={runModelLabels(r)} />{" "}
                            {r.model.label && r.model.label !== r.model.model ? `${r.model.model}, ` : ""}
                            {r.model.keySource === "instance" ? "the instance's key" : `the workspace's ${r.model.provider} key`}
                            {r.requestedModels ? ", chosen for this review" : ""}
                        </dd>
                    </>
                )}
                {r.model?.models && (
                    <>
                        <dt className="text-muted-foreground">Models</dt>
                        <dd>
                            {r.result?.models ? (
                                <>
                                    <ul className="grid gap-0.5" data-testid="run-models">
                                        {r.result.models.map((m, i) => {
                                            const again = r.retries?.filter((x) => x.index === i) ?? [];
                                            const able = r.rerunnable?.find((x) => x.index === i);
                                            return (
                                                <li key={m.label}>
                                                    <Badge variant="outline" className="font-mono font-normal">
                                                        {m.label}
                                                    </Badge>{" "}
                                                    {m.status === "done" || m.status === "partial"
                                                        ? `${plural(m.total ?? 0, "finding")}${m.status === "partial" ? " (partly)" : ""}`
                                                        : m.status === "cancelled"
                                                          ? "cancelled"
                                                          : `failed${m.error ? ` (${m.error})` : ""}`}
                                                    {m.tokens !== null && `, ${m.tokens.toLocaleString("en-GB")} tokens`}
                                                    {m.seconds !== null && `, ${duration(m.seconds)}`}
                                                    {(again.length > 0 || able) && (
                                                        // The model run again by itself: each attempt, and the way to ask for another.
                                                        <ul
                                                            className="mt-0.5 ms-3 grid gap-0.5 border-s ps-3"
                                                            data-testid="run-model-retries"
                                                        >
                                                            {again.map((x) => (
                                                                <li key={x.id}>
                                                                    <Link
                                                                        to="/w/$ws/p/$project/runs/$runId"
                                                                        params={{ ws, project: slug, runId: x.id }}
                                                                        className="link"
                                                                    >
                                                                        {retryText(x)}
                                                                    </Link>
                                                                </li>
                                                            ))}
                                                            {able && able.reason === null && canOperate && (
                                                                <li>
                                                                    <RerunModel ws={ws} run={r} index={i} label={m.label} />
                                                                </li>
                                                            )}
                                                            {able?.reason &&
                                                                !again.some((x) => x.status === "queued" || x.status === "running") && (
                                                                    <li className="text-muted-foreground">{able.reason}</li>
                                                                )}
                                                        </ul>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                    {r.requestedModels && <p data-testid="run-models-chosen">Chosen for this review.</p>}
                                </>
                            ) : r.progress.models?.length ? (
                                // While it runs: a row for each model, with its own progress.
                                <>
                                    <ul className="grid gap-0.5" data-testid="run-models">
                                        {r.progress.models.map((m, i) => (
                                            <li key={r.model?.models?.[i]?.label ?? i} data-testid="run-model-row">
                                                <Badge variant="outline" className="font-mono font-normal">
                                                    {r.model?.models?.[i]?.label ?? m.label}
                                                </Badge>{" "}
                                                {modelProgressText(m)}
                                            </li>
                                        ))}
                                    </ul>
                                    {r.requestedModels && <p data-testid="run-models-chosen">Chosen for this review.</p>}
                                </>
                            ) : (
                                <span data-testid="run-models">
                                    <ModelChips labels={runModelLabels(r)} />
                                    {r.requestedModels ? " chosen for this review" : ""}
                                </span>
                            )}
                        </dd>
                    </>
                )}
                {options.length > 0 && (
                    <>
                        <dt className="text-muted-foreground">Options</dt>
                        <dd data-testid="run-options">
                            <ul className="grid gap-0.5">
                                {options.map((o) => (
                                    <li key={o}>{o}</li>
                                ))}
                            </ul>
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
                {r.result?.bakeOff && (
                    <>
                        <dt className="text-muted-foreground">Comparison</dt>
                        <dd data-testid="run-comparison">
                            {plural(r.result.bakeOff.total, "finding")} between them, {r.result.bakeOff.agreed} found by more than one
                            model.{" "}
                            <Link to="/w/$ws/p/$project/comparisons/$runId" params={{ ws, project: slug, runId: r.id }} className="link">
                                See the comparison
                            </Link>
                        </dd>
                    </>
                )}
                {(r.status === "done" || r.status === "partial") && r.result && !r.result.bakeOff && (
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
                {r.result?.judge && (
                    <>
                        <dt className="text-muted-foreground">Same problem?</dt>
                        <dd data-testid="run-judge">{judgeText(r.result.judge)}</dd>
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
                {r.model?.models && r.all.length > 0 && (
                    // Each model's lines start with its label: show them all, or one model's.
                    <fieldset className="flex min-w-0 flex-wrap gap-1" data-testid="run-log-filter">
                        <legend className="sr-only">Log lines to show</legend>
                        {logChoice(null)}
                        {r.model.models.map((m) => logChoice(m.label))}
                    </fieldset>
                )}
                {r.all.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {r.status === "queued" ? "Nothing yet: it hasn't started." : "No log lines."}
                    </p>
                ) : shown.length === 0 ? (
                    <p className="text-sm text-muted-foreground" data-testid="run-log-empty">
                        No lines from {logModel} yet.
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
                        {shown.map((l) => (
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
