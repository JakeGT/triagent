// What changed in the project, newest first, on one branch or all of them.

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useState } from "react";
import { NativeSelect } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api, paths } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { branchesQuery } from "@/lib/queries";
import { useProject } from "@/lib/session";
import type { ActivityRow } from "@/lib/types";
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
    const selectId = useId();
    const filter = search.branch ?? "";
    const [choice, setChoice] = useState(filter);
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
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                    e.preventDefault();
                    void navigate({ to: ".", search: { branch: choice || undefined } });
                }}
            >
                <div className="grid gap-1.5">
                    <Label htmlFor={selectId}>Branch</Label>
                    <NativeSelect id={selectId} value={choice} onChange={(e) => setChoice(e.target.value)} className="w-60">
                        <option value="">All branches</option>
                        {(branches.data?.items ?? []).map((b) => (
                            <option key={b.name} value={b.name}>
                                {b.name}
                            </option>
                        ))}
                    </NativeSelect>
                </div>
                <Button type="submit" variant="outline">
                    Show
                </Button>
            </form>

            {activity.isPending ? (
                <LoadingRows rows={8} />
            ) : activity.isError ? (
                <LoadError error={activity.error} onRetry={() => activity.refetch()} title="Couldn't load the activity" />
            ) : rows.length === 0 ? (
                <EmptyState title="Nothing has changed yet">Uploads, triage and notes will appear here.</EmptyState>
            ) : (
                <>
                    <ol className="divide-y rounded-lg border bg-card">
                        {rows.map((row) => (
                            <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm">
                                <time
                                    dateTime={row.at}
                                    title={formatDateTime(row.at)}
                                    className="w-28 shrink-0 text-xs text-muted-foreground"
                                >
                                    {timeAgo(row.at)}
                                </time>
                                <span className="min-w-0 flex-1">
                                    <span className="font-medium">{row.actor}</span> {describeActivity(row)}
                                    {VIA[row.via] ? <span className="text-muted-foreground"> {VIA[row.via]}</span> : null}
                                </span>
                                <ItemLink row={row} ws={ws} slug={slug} defaultBranch={project.defaultBranch} />
                                {row.branch && <span className="font-mono text-xs text-muted-foreground">{row.branch}</span>}
                            </li>
                        ))}
                    </ol>
                    {activity.hasNextPage && (
                        <div>
                            <Button variant="outline" onClick={() => activity.fetchNextPage()} disabled={activity.isFetchingNextPage}>
                                {activity.isFetchingNextPage ? "Loading…" : "Show older changes"}
                            </Button>
                        </div>
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
                className="font-mono text-xs underline"
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
                className="font-mono text-xs underline"
            >
                {row.itemId}
            </Link>
        );
    return null;
}
