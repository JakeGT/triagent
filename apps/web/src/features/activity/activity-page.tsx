// What changed in the project, newest first, on one branch or all of them.

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Field, FieldRow, FieldRowActions, NativeSelect } from "@/components/field";
import { FormActions } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Button } from "@/components/ui/button";
import { api, paths } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { branchesQuery } from "@/lib/queries";
import { useProject } from "@/lib/session";
import type { ActivityRow } from "@/lib/types";
import { FirstReviewActions } from "../runs/first-review";
import { describeActivity } from "./describe";

const PAGE = 100;
const VIA: Record<string, string> = {
    web: "",
    token: "with an API token",
    mcp: "through MCP",
    link: "with an upload link",
    github: "from GitHub",
    system: "automatically",
    cli: "from the command line",
};

export function ActivityPage() {
    const { ws, slug, project } = useProject();
    const search = useSearch({ from: "/authed/w/$ws/p/$project/activity" });
    const navigate = useNavigate();
    const filter = search.branch ?? "";
    const [choice, setChoice] = useState(filter);
    // Follow the address when it changes under the form (back/forward, a link).
    const [shown, setShown] = useState(filter);
    if (shown !== filter) {
        setShown(filter);
        setChoice(filter);
    }
    const branches = useQuery(branchesQuery(ws, slug));

    const activity = useInfiniteQuery({
        // Under the project's "activity" key, so live updates refresh it.
        queryKey: ["ws", ws, "p", slug, "activity", filter, "pages"],
        queryFn: ({ pageParam, signal }) =>
            api.get<{ items: ActivityRow[] }>(
                `${paths.project(ws, slug)}/activity`,
                { branch: filter, limit: PAGE, before: pageParam },
                { signal },
            ),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => (last.items.length === PAGE ? last.items.at(-1)?.id : undefined),
    });
    const rows = activity.data?.pages.flatMap((p) => p.items) ?? [];

    return (
        <Page>
            <PageMeta title={`Activity · ${project.name}`} />
            <PageHeader title="Activity" description="Changes to issues, tasks, reports and branches, newest first." />
            <form
                className="grid"
                onSubmit={(e) => {
                    e.preventDefault();
                    void navigate({ to: ".", search: { branch: choice || undefined } });
                }}
            >
                <FieldRow columns="auto">
                    <Field label="Branch" width="md">
                        {(p) => (
                            <NativeSelect {...p} value={choice} onChange={(e) => setChoice(e.target.value)}>
                                <option value="">All branches</option>
                                {(branches.data?.items ?? []).map((b) => (
                                    <option key={b.name} value={b.name}>
                                        {b.name}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                    <FieldRowActions>
                        <Button type="submit" variant="outline">
                            Show
                        </Button>
                    </FieldRowActions>
                </FieldRow>
            </form>

            {activity.isPending ? (
                <LoadingRows rows={8} />
            ) : activity.isError ? (
                <LoadError error={activity.error} onRetry={() => activity.refetch()} title="Couldn't load the activity" />
            ) : rows.length === 0 ? (
                <EmptyState title="Nothing has changed yet" action={filter ? undefined : <FirstReviewActions />}>
                    Activity is the record of who did what in this project: reviews and uploads, changes of status and assignee, and notes.
                </EmptyState>
            ) : (
                <>
                    <ol className="divide-y rounded-lg border bg-card" data-tour="activity-list">
                        {rows.map((row) => (
                            // On a phone each part has a line of its own: when, what, then where.
                            <li key={row.id} className="grid gap-x-3 gap-y-0.5 px-3 py-2 text-sm sm:flex sm:items-baseline">
                                <time
                                    dateTime={row.at}
                                    title={formatDateTime(row.at)}
                                    className="shrink-0 text-xs text-muted-foreground sm:w-28"
                                >
                                    {timeAgo(row.at)}
                                </time>
                                <span className="min-w-0 flex-1">
                                    <span className="font-medium">{row.actor}</span> {describeActivity(row)}
                                    {/* A review's own row says what it reviewed; where the reviewer runs from adds nothing. */}
                                    {VIA[row.via] && row.kind !== "run" ? (
                                        <span className="text-muted-foreground"> {VIA[row.via]}</span>
                                    ) : null}
                                </span>
                                <span className="flex flex-wrap items-baseline gap-x-3 sm:max-w-[45%] sm:shrink-0 sm:justify-end">
                                    <ItemLink row={row} ws={ws} slug={slug} defaultBranch={project.defaultBranch} />
                                    {row.branch && <span className="font-mono text-xs break-all text-muted-foreground">{row.branch}</span>}
                                </span>
                            </li>
                        ))}
                    </ol>
                    {activity.hasNextPage && (
                        <FormActions>
                            <Button variant="outline" onClick={() => activity.fetchNextPage()} disabled={activity.isFetchingNextPage}>
                                {activity.isFetchingNextPage ? "Loading…" : "Show older changes"}
                            </Button>
                        </FormActions>
                    )}
                </>
            )}
        </Page>
    );
}

function ItemLink({ row, ws, slug, defaultBranch }: { row: ActivityRow; ws: string; slug: string; defaultBranch: string }) {
    const branch = row.branch && row.branch !== defaultBranch ? row.branch : undefined;
    if (row.kind === "issue")
        return (
            <Link
                to="/w/$ws/p/$project/issues/$issueId"
                params={{ ws, project: slug, issueId: row.itemId }}
                search={{ branch } as never}
                className="link font-mono text-xs"
            >
                {row.itemId}
            </Link>
        );
    if (row.kind === "task")
        return (
            <Link
                to="/w/$ws/p/$project/tasks/$taskId"
                params={{ ws, project: slug, taskId: row.itemId }}
                search={{ branch }}
                className="link font-mono text-xs"
            >
                {row.itemId}
            </Link>
        );
    if (row.kind === "run")
        return (
            <Link to="/w/$ws/p/$project/runs/$runId" params={{ ws, project: slug, runId: row.itemId }} className="link text-xs">
                View the run
            </Link>
        );
    return null;
}
