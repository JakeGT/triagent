// One task beside the list: what the reviewer said, the files and issues it covers, and its status,
// assignee and notes. Changes carry the task's `rev`, like issues.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { STATUSES, type Status } from "@triagent/shared";
import { AlertTriangle, X } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { FieldError } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { InlineCode, Markdown } from "@/components/markdown";
import { SeverityMark, StatusMark } from "@/components/marks";
import { NoteEditor, NoteList } from "@/components/notes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { refreshBranch, useChangeNote } from "@/features/issues/use-issue-actions";
import { api, conflictCurrent, errorMessage, isApiError, paths } from "@/lib/api";
import { useHeldWhileEditing } from "@/lib/drafts";
import { formatDateTime, plural, STATUS_LABEL, timeAgo } from "@/lib/format";
import { keys, membersQuery, taskQuery } from "@/lib/queries";
import { useCan, useMe, useProject } from "@/lib/session";
import type { TaskDetail } from "@/lib/types";

const ROUTE = "/authed/w/$ws/p/$project/tasks/$taskId" as const;

interface TaskChange {
    status?: Status;
    assignee?: string | null;
    note?: string;
}

class TaskConflict extends Error {
    readonly current: TaskDetail;
    readonly attempted: TaskChange;
    constructor(current: TaskDetail, attempted: TaskChange) {
        super("Someone else changed this task first.");
        this.current = current;
        this.attempted = attempted;
    }
}

function describe(c: TaskChange): string {
    const parts: string[] = [];
    if (c.status) parts.push(`set the status to ${STATUS_LABEL[c.status]}`);
    if (c.assignee !== undefined) parts.push(c.assignee ? `assign it to ${c.assignee}` : "unassign it");
    if (c.note) parts.push("add a note");
    return parts.join(" and ") || "change it";
}

export function TaskPanel() {
    const { taskId } = useParams({ from: ROUTE });
    const { branch } = useProject();
    // A fresh panel for each task on each branch: drafts and conflicts belong to that one.
    return <TaskView key={`${branch}\0${taskId}`} id={taskId} />;
}

function TaskView({ id }: { id: string }) {
    const { ws, slug, branch, branchParam } = useProject();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const me = useMe();
    const can = useCan();
    const canTriage = can("triage");
    const assigneeId = useId();
    const membersListId = useId();

    const query = useQuery(taskQuery(ws, slug, branch, id));
    const members = useQuery({ ...membersQuery(ws), enabled: canTriage });
    const [note, setNote] = useState("");
    const [editingNote, setEditingNote] = useState(false);
    const [assignee, setAssignee] = useState<string | null>(null);
    const [conflict, setConflict] = useState<TaskConflict | null>(null);
    const [error, setError] = useState<string | null>(null);

    const editing = note.trim() !== "" || editingNote || assignee !== null;
    const held = useHeldWhileEditing(query.data, editing, (t) => t.rev);
    const task = held.shown;
    const ref = { ws, project: slug, branch };
    const changeNote = useChangeNote(ref, "tasks", id);
    const key = keys.task(ws, slug, branch, id);

    const update = useMutation({
        mutationFn: async ({ rev, change }: { rev: number; change: TaskChange }) => {
            try {
                return await api.patch<{ task: TaskDetail; changed: boolean }>(
                    `${paths.project(ws, slug)}/tasks/${encodeURIComponent(id)}`,
                    { ...change, rev },
                    { branch },
                );
            } catch (err) {
                const current = conflictCurrent<TaskDetail>(err);
                if (current) throw new TaskConflict(current, change);
                throw err;
            }
        },
        onSuccess: ({ task: saved }) => {
            queryClient.setQueryData(key, saved);
            held.accept(saved);
            refreshBranch(queryClient, ref);
        },
        onError: (err) => {
            if (err instanceof TaskConflict) {
                queryClient.setQueryData(key, err.current);
                held.accept(err.current);
                refreshBranch(queryClient, ref);
            }
        },
    });

    const change = async (c: TaskChange, confirmation?: string): Promise<boolean> => {
        if (!task) return false;
        setError(null);
        setConflict(null);
        try {
            await update.mutateAsync({ rev: task.rev, change: c });
            if (confirmation) toast.success(confirmation);
            return true;
        } catch (err) {
            if (err instanceof TaskConflict) setConflict(err);
            else setError(errorMessage(err));
            return false;
        }
    };

    const close = () => void navigate({ to: "/w/$ws/p/$project/tasks", params: { ws, project: slug }, search: { branch: branchParam } });

    if (query.isPending)
        return (
            <section className="border-s p-4" aria-busy="true">
                <LoadingRows rows={8} />
            </section>
        );
    if (query.isError || !task)
        return (
            <section className="grid content-start gap-3 border-s p-4">
                <LoadError
                    error={query.error}
                    title={isApiError(query.error, 404) ? "No such task on this branch" : "Couldn't load the task"}
                    onRetry={isApiError(query.error, 404) ? undefined : () => query.refetch()}
                />
                <div>
                    <Button variant="outline" size="sm" onClick={close}>
                        Back to the list
                    </Button>
                </div>
            </section>
        );

    const issuesLink = (filters: Record<string, unknown>) => ({ branch: branchParam, ...filters }) as never;
    return (
        <section
            aria-labelledby="task-title"
            className="flex min-w-0 flex-col gap-4 border-s bg-card/40 p-4 md:p-5 lg:h-[calc(100svh-2.75rem)] lg:overflow-y-auto"
            data-testid="task-panel"
        >
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-3 text-sm">
                        <span className="text-muted-foreground">{task.section}</span>
                        <StatusMark status={task.status} />
                        <span className="text-muted-foreground">{task.assignee ? `Assigned to ${task.assignee}` : "Unassigned"}</span>
                    </div>
                    <h2 id="task-title" className="text-lg leading-snug font-semibold">
                        <InlineCode text={task.title} />
                    </h2>
                </div>
                <Button variant="ghost" size="icon" className="size-8" onClick={close} aria-label="Close task">
                    <X />
                </Button>
            </div>

            <ChangedElsewhere show={held.changedElsewhere} onReload={held.reload} what="This task" keepsInput />
            {conflict && (
                <Alert variant="destructive" data-testid="conflict">
                    <AlertTriangle />
                    <AlertTitle>Someone else changed this task first</AlertTitle>
                    <AlertDescription>
                        <p>
                            {conflict.current.updatedBy ?? "Someone"} changed it{" "}
                            {conflict.current.updatedAt ? timeAgo(conflict.current.updatedAt) : "just now"}. It's now{" "}
                            {STATUS_LABEL[conflict.current.status].toLowerCase()},{" "}
                            {conflict.current.assignee ? `assigned to ${conflict.current.assignee}` : "unassigned"}. Your change (
                            {describe(conflict.attempted)}) wasn't saved. Their version is shown below.
                        </p>
                        <div className="flex flex-wrap gap-2 pt-1">
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={update.isPending}
                                onClick={() => {
                                    const attempted = conflict.attempted;
                                    void change(attempted).then((ok) => {
                                        // Clear the box only if it still holds the note that was just added.
                                        if (ok && attempted.note) setNote((n) => (n.trim() === attempted.note ? "" : n));
                                    });
                                }}
                            >
                                Apply my change to their version
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>
                                Dismiss
                            </Button>
                        </div>
                    </AlertDescription>
                </Alert>
            )}
            <FieldError message={error} />

            {canTriage && (
                <div className="grid gap-3 rounded-lg border bg-background p-3">
                    <fieldset className="grid gap-1.5">
                        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Status</legend>
                        <div className="flex flex-wrap gap-1">
                            {STATUSES.map((s) => (
                                <Button
                                    key={s}
                                    size="sm"
                                    variant={task.status === s ? "default" : "outline"}
                                    aria-pressed={task.status === s}
                                    disabled={update.isPending}
                                    onClick={() =>
                                        task.status !== s && void change({ status: s }, `Marked ${STATUS_LABEL[s].toLowerCase()}.`)
                                    }
                                >
                                    {STATUS_LABEL[s]}
                                </Button>
                            ))}
                        </div>
                    </fieldset>
                    <form
                        className="grid gap-1.5"
                        onSubmit={async (e) => {
                            e.preventDefault();
                            const name = (assignee ?? "").trim();
                            if (await change({ assignee: name || null }, name ? `Assigned to ${name}.` : "Unassigned.")) setAssignee(null);
                        }}
                    >
                        <Label htmlFor={assigneeId} className="text-xs text-muted-foreground">
                            Assignee
                        </Label>
                        <div className="flex flex-wrap gap-1.5">
                            <Input
                                id={assigneeId}
                                list={membersListId}
                                value={assignee ?? task.assignee ?? ""}
                                onChange={(e) => setAssignee(e.target.value)}
                                maxLength={64}
                                className="h-8 w-48"
                                autoComplete="off"
                            />
                            <datalist id={membersListId}>
                                {(members.data ?? []).map((m) => (
                                    <option key={m.user.id} value={m.user.displayName} />
                                ))}
                            </datalist>
                            {assignee !== null ? (
                                <>
                                    <Button type="submit" size="sm" disabled={update.isPending}>
                                        Save
                                    </Button>
                                    <Button type="button" size="sm" variant="ghost" onClick={() => setAssignee(null)}>
                                        Cancel
                                    </Button>
                                </>
                            ) : (
                                <>
                                    {task.assignee !== me.user.displayName && (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() => void change({ assignee: me.user.displayName }, "Assigned to you.")}
                                        >
                                            Assign to me
                                        </Button>
                                    )}
                                    {task.assignee && (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => void change({ assignee: null }, "Unassigned.")}
                                        >
                                            Unassign
                                        </Button>
                                    )}
                                </>
                            )}
                        </div>
                    </form>
                </div>
            )}

            {task.body.trim() && (
                <section aria-labelledby="task-body-heading" className="grid gap-1.5">
                    <h3 id="task-body-heading" className="text-sm font-medium">
                        What the reviewer said
                    </h3>
                    <Markdown>{task.body}</Markdown>
                </section>
            )}

            <section aria-labelledby="task-files-heading" className="grid gap-1.5">
                <h3 id="task-files-heading" className="text-sm font-medium">
                    Files
                </h3>
                {task.files.length === 0 ? (
                    <p className="text-sm text-muted-foreground">The task doesn't name any file with findings.</p>
                ) : (
                    <ul className="grid gap-1 text-sm">
                        {task.files.map((f) => (
                            <li key={f}>
                                <Link
                                    to="/w/$ws/p/$project/issues"
                                    params={{ ws, project: slug }}
                                    search={issuesLink({ path: f })}
                                    className="font-mono text-xs underline"
                                >
                                    {f}
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section aria-labelledby="task-issues-heading" className="grid gap-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 id="task-issues-heading" className="text-sm font-medium">
                        Issues ({task.issuesDone} of {task.issueCount} dealt with)
                    </h3>
                    {task.issueCount > 0 && (
                        <Link
                            to="/w/$ws/p/$project/issues"
                            params={{ ws, project: slug }}
                            search={issuesLink({ task: task.id })}
                            className="text-sm underline"
                        >
                            All {plural(task.issueCount, "issue")} in Issues
                        </Link>
                    )}
                </div>
                {task.issues.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No issues are linked to this task.</p>
                ) : (
                    <ul className="grid gap-1.5 text-sm">
                        {task.issues.map((x) => (
                            <li key={x.id} className="grid gap-0.5 rounded-md border bg-card px-3 py-2">
                                <span className="flex flex-wrap items-center gap-x-3">
                                    <SeverityMark severity={x.severity} className="text-xs" />
                                    <StatusMark status={x.status} className="text-xs" />
                                </span>
                                <Link
                                    to="/w/$ws/p/$project/issues/$issueId"
                                    params={{ ws, project: slug, issueId: x.id }}
                                    search={issuesLink({ task: task.id })}
                                    className="font-medium hover:underline"
                                >
                                    <InlineCode text={x.title} />
                                </Link>
                                <span className="truncate font-mono text-xs text-muted-foreground">{x.path}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section aria-labelledby="task-notes-heading" className="grid gap-2">
                <h3 id="task-notes-heading" className="text-sm font-medium">
                    Notes
                </h3>
                <NoteList
                    notes={task.notes}
                    myKey={`user:${me.user.id}`}
                    canEditOwn={canTriage}
                    canModerate={can("moderate")}
                    onEditingChange={setEditingNote}
                    onEdit={(noteId, text) => changeNote.mutateAsync({ noteId, text })}
                    onDelete={async (noteId) => {
                        await changeNote.mutateAsync({ noteId, text: null });
                        toast.success("Note deleted.");
                    }}
                />
                {canTriage && (
                    <NoteEditor
                        label="Add a note"
                        submitLabel="Add note"
                        value={note}
                        onChange={setNote}
                        onSubmit={async (text) => {
                            if (await change({ note: text }, "Note added.")) setNote("");
                        }}
                    />
                )}
            </section>

            {task.updatedAt && (
                <p className="text-xs text-muted-foreground">
                    Last changed {task.updatedBy ? `by ${task.updatedBy} ` : ""}
                    <time dateTime={task.updatedAt}>{formatDateTime(task.updatedAt)}</time>
                </p>
            )}
        </section>
    );
}
