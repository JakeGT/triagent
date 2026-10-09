// Issues: the triage list, filtered and sorted from the URL, with the selected issue open beside it.
// Single-key shortcuts (j/k move, x select, / search; 1–4 set status in the open issue) can be turned
// off in Settings → Appearance.

import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type ColumnDef, flexRender, getCoreRowModel, type RowSelectionState, useReactTable } from "@tanstack/react-table";
import { SEVERITIES } from "@triagent/shared";
import { ChevronLeft, ChevronRight, Copy as Duplicate, Lightbulb, MessageSquare, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { announce } from "@/components/announcer";
import { LoadError, LoadingRows } from "@/components/load-state";
import { InlineCode } from "@/components/markdown";
import { CategoryMark, SeverityMark, StatusMark } from "@/components/marks";
import { EmptyState, PageMeta } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { lines, plural } from "@/lib/format";
import { useShortcutsEnabled } from "@/lib/prefs";
import { issuesQuery } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import type { IssueSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BulkBar } from "./bulk-bar";
import { IssueFilters } from "./issue-filters";
import { isTypingTarget } from "./keys";
import { activeFilters, type IssueSearch, issueApiQuery, PAGE_SIZE, withoutFilters } from "./search";

const ROUTE = "/authed/w/$ws/p/$project/issues" as const;
/** How many selected issues "Show selected" lists: their ids go in the request's address. */
const MAX_SHOWN = 500;

/** Columns that give way on narrow screens, and while an issue is open beside the list. */
function columnClass(id: string, panelOpen: boolean): string | false {
    if (id === "category" || id === "assignee") return panelOpen ? "hidden 2xl:table-cell" : "hidden md:table-cell";
    if (id === "flags") return panelOpen ? "hidden xl:table-cell" : "hidden sm:table-cell";
    return false;
}

function summaryText(total: number, counts: Record<string, number> | undefined): string {
    const parts = SEVERITIES.filter((s) => counts?.[s]).map((s) => `${counts?.[s]} ${s}`);
    return `${plural(total, "issue")}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

function Flags({ issue: x }: { issue: IssueSummary }) {
    return (
        <span className="flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
            {x.needsDiscussion && (
                <span title="Needs discussion">
                    <Users aria-hidden="true" />
                    <span className="sr-only">Needs discussion</span>
                </span>
            )}
            {x.duplicateOf && (
                <span title={`Duplicate of ${x.duplicateOf}`}>
                    <Duplicate aria-hidden="true" />
                    <span className="sr-only">Duplicate</span>
                </span>
            )}
            {x.hasSuggestion && (
                <span title="Has a suggested fix">
                    <Lightbulb aria-hidden="true" />
                    <span className="sr-only">Has a suggested fix</span>
                </span>
            )}
            {x.noteCount > 0 && (
                <span title={plural(x.noteCount, "note")} className="flex items-center gap-0.5 text-xs">
                    <MessageSquare aria-hidden="true" />
                    {x.noteCount}
                    <span className="sr-only"> {x.noteCount === 1 ? "note" : "notes"}</span>
                </span>
            )}
        </span>
    );
}

export function IssuesPage() {
    const { ws, slug, project, branch, branchParam } = useProject();
    const can = useCan();
    const canTriage = can("triage");
    const search = useSearch({ from: ROUTE });
    const { issueId } = useParams({ strict: false }) as { issueId?: string };
    const navigate = useNavigate();
    const shortcuts = useShortcutsEnabled();
    const searchRef = useRef<HTMLInputElement>(null);
    const [selection, setSelection] = useState<RowSelectionState>({});
    // "Show selected": the ids the list is narrowed to, in place of the filters. They're the selection as it
    // was when asked for, so an issue unticked there stays in view.
    const [shown, setShown] = useState<string[] | null>(null);
    const shownSet = useMemo(() => (shown ? new Set(shown) : null), [shown]);

    const apiQuery = useMemo(
        () =>
            shown
                ? {
                      ...issueApiQuery({ ...(search.sort ? { sort: search.sort } : {}), ...(search.page ? { page: search.page } : {}) }),
                      ids: shown.join(","),
                  }
                : issueApiQuery(search),
        [shown, search],
    );
    const query = useQuery(issuesQuery(ws, slug, branch, apiQuery));
    const data = query.data;
    const items = useMemo(() => data?.items ?? [], [data]);
    const modelCount = data?.models?.length ?? 0;
    const page = search.page ?? 1;
    const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

    // Moving to another branch starts a fresh selection.
    // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the branch changes
    useEffect(() => {
        setSelection({});
        setShown(null);
    }, [branch]);

    // Say what the filters found, once the list for them has arrived.
    const summary = data ? summaryText(data.total, data.counts.severity) : "";
    useEffect(() => {
        if (summary) announce(summary);
    }, [summary]);

    const setSearch = useCallback(
        (next: IssueSearch, options?: { replace?: boolean }) =>
            void navigate({ to: ".", search: { ...next, branch: branchParam } as never, replace: options?.replace ?? false }),
        [navigate, branchParam],
    );

    // Filtering again goes back to the filtered list.
    const filter = useCallback(
        (next: IssueSearch, options?: { replace?: boolean }) => {
            setShown(null);
            setSearch(next, options);
        },
        [setSearch],
    );

    const detailSearch = useMemo(() => ({ ...search, branch: branchParam }) as never, [search, branchParam]);

    const open = useCallback(
        (id: string) =>
            void navigate({
                to: "/w/$ws/p/$project/issues/$issueId",
                params: { ws, project: slug, issueId: id },
                search: detailSearch,
                replace: Boolean(issueId),
            }),
        [navigate, ws, slug, detailSearch, issueId],
    );

    const columns = useMemo<ColumnDef<IssueSummary>[]>(() => {
        const select: ColumnDef<IssueSummary> = {
            id: "select",
            header: ({ table }) => (
                <Checkbox
                    aria-label="Select all issues on this page"
                    checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")}
                    onCheckedChange={(v) => table.toggleAllPageRowsSelected(Boolean(v))}
                />
            ),
            cell: ({ row }) => (
                <Checkbox
                    aria-label={`Select ${row.original.id}`}
                    checked={row.getIsSelected()}
                    onCheckedChange={(v) => row.toggleSelected(Boolean(v))}
                />
            ),
        };
        return [
            ...(canTriage ? [select] : []),
            {
                id: "severity",
                header: "Severity",
                cell: ({ row }) => <SeverityMark severity={row.original.severity} className="text-xs" />,
            },
            {
                id: "issue",
                header: "Issue",
                cell: ({ row }) => {
                    const x = row.original;
                    return (
                        <div className="grid min-w-0 gap-0.5">
                            <Link
                                to="/w/$ws/p/$project/issues/$issueId"
                                params={{ ws, project: slug, issueId: x.id }}
                                search={detailSearch}
                                className="line-clamp-2 font-medium hover:underline focus-visible:underline"
                                aria-current={x.id === issueId ? "true" : undefined}
                            >
                                <InlineCode text={x.title} />
                            </Link>
                            <span className="truncate font-mono text-xs text-muted-foreground">
                                {x.path}
                                {x.startLine ? `:${lines(x.startLine, x.endLine)}` : ""}
                            </span>
                            {x.foundBy && modelCount > 1 && (
                                <span className="text-xs text-muted-foreground" title={x.foundBy.join(", ")}>
                                    Found by{" "}
                                    {x.foundBy.length === modelCount ? `all ${modelCount} models` : `${x.foundBy.length} of ${modelCount}`}
                                    <span className="sr-only">: {x.foundBy.join(", ")}</span>
                                </span>
                            )}
                        </div>
                    );
                },
            },
            {
                id: "category",
                header: "Category",
                cell: ({ row }) => <CategoryMark category={row.original.category} className="text-xs" />,
            },
            { id: "status", header: "Status", cell: ({ row }) => <StatusMark status={row.original.status} className="text-xs" /> },
            {
                id: "assignee",
                header: "Assignee",
                cell: ({ row }) => (
                    <span className="text-xs">
                        {row.original.assignee ?? (
                            <span className="text-muted-foreground">
                                <span aria-hidden="true">—</span>
                                <span className="sr-only">Unassigned</span>
                            </span>
                        )}
                    </span>
                ),
            },
            { id: "flags", header: () => <span className="sr-only">Flags</span>, cell: ({ row }) => <Flags issue={row.original} /> },
        ];
    }, [canTriage, issueId, ws, slug, detailSearch, modelCount]);

    const table = useReactTable({
        data: items,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getRowId: (row) => row.id,
        state: { rowSelection: selection },
        onRowSelectionChange: setSelection,
        enableRowSelection: canTriage,
        manualPagination: true,
        manualSorting: true,
        manualFiltering: true,
    });
    // The selection outlives the filters and pages it was made on, so some of it may not be in the list now.
    const selectedIds = Object.keys(selection).filter((id) => selection[id]);
    // While showing the selection, "shown" is what that view holds on any of its pages, not just this one.
    const listed = useMemo(() => new Set(items.map((x) => x.id)), [items]);
    const notShown = selectedIds.filter((id) => !(shownSet ?? listed).has(id)).length;
    const firstPage = () => {
        if (search.page) setSearch({ ...search, page: undefined }, { replace: true });
    };
    const showSelected = (show: boolean) => {
        // Nothing selected is nothing to show (an empty list of ids would mean "no filter" to the server), and
        // the ids travel in the address, which has a length limit.
        setShown(show && selectedIds.length ? selectedIds.slice(0, MAX_SHOWN) : null);
        firstPage();
    };
    const clearSelection = () => {
        setSelection({});
        if (shown) showSelected(false);
    };

    // Where j/k last went. The URL (and so `issueId`) catches up a render later, and a second press in
    // between must move on from where the first one went, not from where the page was.
    const cursor = useRef<string | undefined>(issueId);
    useEffect(() => {
        cursor.current = issueId;
    }, [issueId]);

    // Single-key shortcuts for the list (the open issue handles 1–4 and Escape itself).
    useEffect(() => {
        if (!shortcuts) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
            if (e.key === "/") {
                e.preventDefault();
                searchRef.current?.focus();
                searchRef.current?.select();
            } else if ((e.key === "j" || e.key === "k") && items.length) {
                const i = items.findIndex((x) => x.id === cursor.current);
                const next = i === -1 ? 0 : e.key === "j" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0);
                const target = items[next];
                if (target && target.id !== cursor.current) {
                    cursor.current = target.id;
                    open(target.id);
                }
            } else if (e.key === "x" && issueId && canTriage && items.some((x) => x.id === issueId)) {
                // Only an issue in the list as it is now: one filtered out of it would be selected unseen.
                setSelection((s) => ({ ...s, [issueId]: !s[issueId] }));
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [shortcuts, items, issueId, open, canTriage]);

    // Keep the open issue's row in view as j/k move through the list.
    useEffect(() => {
        if (issueId) document.querySelector(`[data-issue-row="${CSS.escape(issueId)}"]`)?.scrollIntoView({ block: "nearest" });
    }, [issueId]);

    const filtered = activeFilters(search) > 0;
    return (
        <div
            className={cn("grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)]", issueId && "lg:grid-cols-[minmax(0,1fr)_minmax(26rem,0.95fr)]")}
        >
            <PageMeta
                title={`Issues · ${project.name}`}
                markdown={`/api/v1/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(slug)}/issues.md?branch=${encodeURIComponent(branch)}`}
            />
            <section
                aria-labelledby="issues-heading"
                className={cn(
                    "flex min-h-0 min-w-0 flex-col gap-3 p-4 md:p-5",
                    issueId && "hidden lg:flex lg:h-[calc(100svh-2.75rem)] lg:overflow-y-auto",
                )}
            >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h1 id="issues-heading" className="text-xl font-semibold tracking-tight">
                        Issues
                    </h1>
                    <p className="text-sm text-muted-foreground" data-testid="issues-summary">
                        {summary || " "}
                        {summary && <span className="sr-only"> on branch {branch}</span>}
                    </p>
                </div>
                <IssueFilters search={search} counts={data?.counts} models={data?.models} onChange={filter} searchRef={searchRef} />
                {selectedIds.length > 0 && canTriage && (
                    <BulkBar
                        ids={selectedIds}
                        notShown={notShown}
                        showingSelected={shown !== null}
                        onShowSelected={showSelected}
                        onClear={clearSelection}
                        refs={{ ws, project: slug, branch }}
                    />
                )}
                {shown && (
                    // Its own way back, as the bar above goes when the last issue is unticked.
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground" data-testid="showing-selected">
                        <span>
                            Showing{" "}
                            {shown.length === MAX_SHOWN
                                ? `the first ${MAX_SHOWN} selected issues`
                                : `the ${plural(shown.length, "selected issue")}`}{" "}
                            only; the filters above aren't applied.
                        </span>
                        <Button variant="outline" size="sm" onClick={() => showSelected(false)}>
                            Back to the filtered list
                        </Button>
                    </p>
                )}
                {query.isPending ? (
                    <LoadingRows rows={10} />
                ) : query.isError ? (
                    <LoadError error={query.error} onRetry={() => query.refetch()} title="Couldn't load the issues" />
                ) : items.length === 0 ? (
                    shown ? (
                        <EmptyState
                            title="None of the selected issues are on this branch now"
                            action={
                                <Button variant="outline" size="sm" onClick={() => showSelected(false)}>
                                    Back to the filtered list
                                </Button>
                            }
                        />
                    ) : filtered ? (
                        <EmptyState
                            title="No issues match these filters"
                            action={
                                <Button variant="outline" size="sm" onClick={() => setSearch(withoutFilters(search))}>
                                    Clear filters
                                </Button>
                            }
                        />
                    ) : (
                        <EmptyState title="No issues on this branch">
                            Upload an Open Code Review report on{" "}
                            <Link to="/w/$ws/p/$project/branches" params={{ ws, project: slug }} className="underline">
                                Branches &amp; reports
                            </Link>
                            .
                        </EmptyState>
                    )
                ) : (
                    <>
                        <div className="overflow-x-auto rounded-md border">
                            <table className="w-full text-sm">
                                <caption className="sr-only">{summary}. Choose an issue to open it.</caption>
                                <thead className="bg-muted/50 text-xs text-muted-foreground">
                                    {table.getHeaderGroups().map((hg) => (
                                        <tr key={hg.id}>
                                            {hg.headers.map((h) => (
                                                <th
                                                    key={h.id}
                                                    scope="col"
                                                    className={cn(
                                                        "h-8 px-2 text-start font-medium whitespace-nowrap",
                                                        columnClass(h.id, Boolean(issueId)),
                                                    )}
                                                >
                                                    {flexRender(h.column.columnDef.header, h.getContext())}
                                                </th>
                                            ))}
                                        </tr>
                                    ))}
                                </thead>
                                <tbody>
                                    {table.getRowModel().rows.map((row) => (
                                        <tr
                                            key={row.id}
                                            data-issue-row={row.id}
                                            data-state={row.getIsSelected() ? "selected" : undefined}
                                            className={cn(
                                                "border-t align-top hover:bg-muted/40 data-[state=selected]:bg-accent/70",
                                                row.id === issueId && "bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]",
                                            )}
                                        >
                                            {row.getVisibleCells().map((cell) => (
                                                <td
                                                    key={cell.id}
                                                    className={cn("px-2 py-1.5", columnClass(cell.column.id, Boolean(issueId)))}
                                                >
                                                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <nav aria-label="Pages of issues" className="flex flex-wrap items-center justify-between gap-2 text-sm">
                            <span className="text-muted-foreground">
                                {data && `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, data.total)} of ${data.total}`}
                            </span>
                            {pages > 1 && (
                                <span className="flex items-center gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={page <= 1}
                                        onClick={() => setSearch({ ...search, page: page - 1 > 1 ? page - 1 : undefined })}
                                    >
                                        <ChevronLeft /> Previous
                                    </Button>
                                    <span>
                                        Page {page} of {pages}
                                    </span>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={page >= pages}
                                        onClick={() => setSearch({ ...search, page: page + 1 })}
                                    >
                                        Next <ChevronRight />
                                    </Button>
                                </span>
                            )}
                        </nav>
                        {shortcuts && (
                            <p className="text-xs text-muted-foreground">
                                Shortcuts: <kbd>j</kbd>/<kbd>k</kbd> next and previous, <kbd>x</kbd> select, <kbd>1</kbd>–<kbd>4</kbd> set
                                status, <kbd>/</kbd> search, <kbd>Esc</kbd> close.{" "}
                                <Link to="/w/$ws/settings/appearance" params={{ ws }} className="underline">
                                    Turn shortcuts off
                                </Link>
                            </p>
                        )}
                    </>
                )}
            </section>
            <Outlet />
        </div>
    );
}
