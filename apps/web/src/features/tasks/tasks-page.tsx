// Tasks: the reviewer's summary items, each linked to the issues in the files it names, with the open
// task beside the list. The summary itself is the second tab.

import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { FileCode, MessageSquare } from "lucide-react";
import { LoadError, LoadingRows } from "@/components/load-state";
import { InlineCode, Markdown } from "@/components/markdown";
import { StatusMark } from "@/components/marks";
import { EmptyState, PageMeta } from "@/components/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { plural } from "@/lib/format";
import { summaryQuery, tasksQuery } from "@/lib/queries";
import { useProject } from "@/lib/session";
import type { TaskSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const ROUTE = "/authed/w/$ws/p/$project/tasks" as const;

function Progress({ task }: { task: TaskSummary }) {
    const pct = task.issueCount ? Math.round((task.issuesDone / task.issueCount) * 100) : 0;
    return (
        <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span className="block h-full bg-st-resolved" style={{ width: `${pct}%` }} />
            </span>
            {task.issuesDone}/{task.issueCount}
            <span className="sr-only"> issues dealt with</span>
        </span>
    );
}

export function TasksPage() {
    const { ws, slug, project, branch, branchParam } = useProject();
    const { tab } = useSearch({ from: ROUTE });
    const { taskId } = useParams({ strict: false }) as { taskId?: string };
    const navigate = useNavigate();
    const tasks = useQuery(tasksQuery(ws, slug, branch));
    const summary = useQuery({ ...summaryQuery(ws, slug, branch), enabled: tab === "summary" });
    const current = tab === "summary" ? "summary" : "tasks";

    const sections = tasks.data?.sections ?? [];
    const items = tasks.data?.items ?? [];

    return (
        <div className={cn("grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)]", taskId && "lg:grid-cols-[minmax(0,1fr)_minmax(26rem,0.95fr)]")}>
            <PageMeta title={`Tasks · ${project.name}`} />
            <section
                aria-labelledby="tasks-heading"
                className={cn(
                    "flex min-h-0 min-w-0 flex-col gap-3 p-4 md:p-5",
                    taskId && "hidden lg:flex lg:h-[calc(100svh-2.75rem)] lg:overflow-y-auto",
                )}
            >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h1 id="tasks-heading" className="text-xl font-semibold tracking-tight">
                        Tasks
                    </h1>
                    {tasks.data && <p className="text-sm text-muted-foreground">{plural(tasks.data.total, "task")}</p>}
                </div>
                <Tabs
                    data-tour="tasks-list"
                    value={current}
                    onValueChange={(v) =>
                        void navigate({
                            to: ".",
                            search: { branch: branchParam, tab: v === "summary" ? "summary" : undefined },
                            replace: true,
                        })
                    }
                >
                    <TabsList>
                        <TabsTrigger value="tasks">Tasks</TabsTrigger>
                        <TabsTrigger value="summary">Reviewer's summary</TabsTrigger>
                    </TabsList>
                    <TabsContent value="tasks" className="mt-3">
                        {tasks.isPending ? (
                            <LoadingRows rows={8} />
                        ) : tasks.isError ? (
                            <LoadError error={tasks.error} onRetry={() => tasks.refetch()} title="Couldn't load the tasks" />
                        ) : items.length === 0 ? (
                            <EmptyState title="No tasks on this branch">
                                Tasks come from the lists in the reviewer's summary. This branch's report has none.
                            </EmptyState>
                        ) : (
                            <div className="grid gap-5">
                                {sections.map((s) => {
                                    const inSection = items.filter((t) => t.sectionId === s.id);
                                    if (!inSection.length) return null;
                                    return (
                                        <section key={s.id} aria-labelledby={`section-${s.id}`} className="grid gap-1.5">
                                            <h2 id={`section-${s.id}`} className="section-title">
                                                {s.title}
                                            </h2>
                                            <ul className="divide-y rounded-md border">
                                                {inSection.map((t) => (
                                                    <li
                                                        key={t.id}
                                                        className={cn(
                                                            "grid gap-1 px-3 py-2",
                                                            t.id === taskId && "bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]",
                                                        )}
                                                    >
                                                        <Link
                                                            to="/w/$ws/p/$project/tasks/$taskId"
                                                            params={{ ws, project: slug, taskId: t.id }}
                                                            search={{ branch: branchParam }}
                                                            className="font-medium hover:underline"
                                                            aria-current={t.id === taskId ? "true" : undefined}
                                                        >
                                                            <InlineCode text={t.title} />
                                                        </Link>
                                                        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                                                            <StatusMark status={t.status} />
                                                            <span className="text-muted-foreground">{t.assignee ?? "Unassigned"}</span>
                                                            <Progress task={t} />
                                                            <span className="flex items-center gap-1 text-muted-foreground">
                                                                <FileCode className="size-3.5" aria-hidden="true" />
                                                                {plural(t.files.length, "file")}
                                                            </span>
                                                            {t.noteCount > 0 && (
                                                                <span className="flex items-center gap-1 text-muted-foreground">
                                                                    <MessageSquare className="size-3.5" aria-hidden="true" />
                                                                    {plural(t.noteCount, "note")}
                                                                </span>
                                                            )}
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </section>
                                    );
                                })}
                            </div>
                        )}
                    </TabsContent>
                    <TabsContent value="summary" className="mt-3">
                        {summary.isPending ? (
                            <LoadingRows rows={8} />
                        ) : summary.isError ? (
                            <LoadError error={summary.error} onRetry={() => summary.refetch()} title="Couldn't load the summary" />
                        ) : summary.data.markdown.trim() ? (
                            <article className="rounded-lg border bg-card p-4">
                                <Markdown>{summary.data.markdown}</Markdown>
                            </article>
                        ) : (
                            <EmptyState title="No summary">This branch's report has no summary from the reviewer.</EmptyState>
                        )}
                    </TabsContent>
                </Tabs>
            </section>
            <Outlet />
        </div>
    );
}
