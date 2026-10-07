// One issue, open beside the list: what the reviewer found, the code, and everything people do with it
// (status, assignee, rating corrections, duplicates, the discussion flag and notes). Changes carry the
// issue's `rev`; if someone else got there first, their version replaces ours and we say what happened.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { CATEGORIES, type Category, SEVERITIES, type Severity, STATUSES, type Status } from "@triagent/shared";
import { AlertTriangle, ChevronDown, ExternalLink, RotateCcw, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { CodeView } from "@/components/code-view";
import { FieldError } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { InlineCode, Markdown } from "@/components/markdown";
import { CategoryMark, SeverityMark, StatusMark } from "@/components/marks";
import { NoteEditor, NoteList } from "@/components/notes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage, isApiError } from "@/lib/api";
import { useHeldWhileEditing } from "@/lib/drafts";
import { CATEGORY_LABEL, formatDateTime, lines, SEVERITY_LABEL, STATUS_LABEL, timeAgo } from "@/lib/format";
import { useShortcutsEnabled } from "@/lib/prefs";
import { issueQuery, membersQuery } from "@/lib/queries";
import { safeHref } from "@/lib/safe-href";
import { useCan, useMe, useProject } from "@/lib/session";
import type { IssueDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DuplicatePicker } from "./duplicate-picker";
import { isTypingTarget } from "./keys";
import { type IssueChange, IssueConflict, useChangeNote, useUpdateIssue } from "./use-issue-actions";

const ROUTE = "/authed/w/$ws/p/$project/issues/$issueId" as const;

/** "set the status to Resolved", for saying which change didn't go through. */
export function describeChange(c: IssueChange): string {
    const parts: string[] = [];
    if (c.status) parts.push(`set the status to ${STATUS_LABEL[c.status]}`);
    if (c.assignee !== undefined) parts.push(c.assignee ? `assign it to ${c.assignee}` : "unassign it");
    if (c.severity) parts.push(c.severity === "reviewer" ? "restore the reviewer's severity" : `rate it ${c.severity}`);
    if (c.category) parts.push(c.category === "reviewer" ? "restore the reviewer's category" : `file it under ${c.category}`);
    if (c.duplicateOf !== undefined) parts.push(c.duplicateOf ? `mark it a duplicate of ${c.duplicateOf}` : "unmark it as a duplicate");
    if (c.needsDiscussion !== undefined) parts.push(c.needsDiscussion ? "flag it for discussion" : "clear the discussion flag");
    if (c.note) parts.push("add a note");
    return parts.join(" and ") || "change it";
}

function ConflictAlert({ conflict, onRetry, onDismiss }: { conflict: IssueConflict; onRetry(): void; onDismiss(): void }) {
    const x = conflict.current;
    const now = [
        STATUS_LABEL[x.status].toLowerCase(),
        x.assignee ? `assigned to ${x.assignee}` : "unassigned",
        `rated ${x.severity}`,
        ...(x.needsDiscussion ? ["flagged for discussion"] : []),
        ...(x.duplicateOf ? [`a duplicate of ${x.duplicateOf}`] : []),
    ].join(", ");
    return (
        <Alert variant="destructive" data-testid="conflict">
            <AlertTriangle />
            <AlertTitle>Someone else changed this issue first</AlertTitle>
            <AlertDescription>
                <p>
                    {x.updatedBy ?? "Someone"} changed it {x.updatedAt ? timeAgo(x.updatedAt) : "just now"}. It's now {now}. Your change (
                    {describeChange(conflict.attempted)}) wasn't saved. Their version is shown below: check it, then try again if it's still
                    needed.
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                    <Button size="sm" variant="outline" onClick={onRetry}>
                        Apply my change to their version
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onDismiss}>
                        Dismiss
                    </Button>
                </div>
            </AlertDescription>
        </Alert>
    );
}

export function IssuePanel() {
    const { issueId } = useParams({ from: ROUTE });
    return <IssueView key={issueId} id={issueId} />;
}

function IssueView({ id }: { id: string }) {
    const { ws, slug, branch, branchParam } = useProject();
    const listSearch = useSearch({ from: ROUTE });
    const navigate = useNavigate();
    const me = useMe();
    const can = useCan();
    const canTriage = can("triage");
    const shortcuts = useShortcutsEnabled();
    const headingRef = useRef<HTMLHeadingElement>(null);
    const assigneeId = useId();
    const membersListId = useId();

    const query = useQuery(issueQuery(ws, slug, branch, id));
    const members = useQuery({ ...membersQuery(ws), enabled: canTriage });

    const [note, setNote] = useState("");
    const [editingNote, setEditingNote] = useState(false);
    const [assignee, setAssignee] = useState<string | null>(null);
    const [conflict, setConflict] = useState<IssueConflict | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pickingDuplicate, setPickingDuplicate] = useState(false);

    const editing = note.trim() !== "" || editingNote || assignee !== null;
    const held = useHeldWhileEditing(query.data, editing, (x) => x.rev);
    const issue = held.shown;
    const ref = { ws, project: slug, branch };
    const update = useUpdateIssue(ref, held.accept);
    const changeNote = useChangeNote(ref, "issues", id);

    const change = async (c: IssueChange, confirmation?: string): Promise<boolean> => {
        if (!issue) return false;
        setError(null);
        setConflict(null);
        try {
            await update.mutateAsync({ id, rev: issue.rev, change: c });
            if (confirmation) toast.success(confirmation);
            return true;
        } catch (err) {
            if (err instanceof IssueConflict) setConflict(err);
            else setError(errorMessage(err));
            return false;
        }
    };

    const close = () =>
        void navigate({
            to: "/w/$ws/p/$project/issues",
            params: { ws, project: slug },
            search: { ...listSearch, branch: branchParam } as never,
        });

    // Move focus into the panel when it was opened from the list with the keyboard or a click.
    useEffect(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest("[data-issue-row]")) headingRef.current?.focus();
    }, []);

    // 1–4 set the status; Escape goes back to the list.
    useEffect(() => {
        if (!shortcuts || !issue) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
            if (e.key === "Escape") close();
            const n = Number(e.key);
            const status = STATUSES[n - 1];
            if (canTriage && status && Number.isInteger(n) && issue.status !== status) {
                e.preventDefault();
                void change({ status }, `Marked ${STATUS_LABEL[status].toLowerCase()}.`);
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    });

    if (query.isPending)
        return (
            <section className="border-s p-4" aria-busy="true">
                <LoadingRows rows={8} />
            </section>
        );
    if (query.isError || !issue)
        return (
            <section className="grid content-start gap-3 border-s p-4">
                <LoadError
                    error={query.error}
                    title={isApiError(query.error, 404) ? "No such issue on this branch" : "Couldn't load the issue"}
                    onRetry={isApiError(query.error, 404) ? undefined : () => query.refetch()}
                />
                <div>
                    <Button variant="outline" size="sm" onClick={close}>
                        Back to the list
                    </Button>
                </div>
            </section>
        );

    const source = safeHref(issue.sourceUrl);
    const myKey = `user:${me.user.id}`;
    return (
        <section
            aria-labelledby="issue-title"
            className="flex min-w-0 flex-col gap-4 border-s bg-card/40 p-4 md:p-5 lg:h-[calc(100svh-2.75rem)] lg:overflow-y-auto"
            data-testid="issue-panel"
        >
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <SeverityMark severity={issue.severity} was={issue.reviewerSeverity} />
                        <CategoryMark category={issue.category} was={issue.reviewerCategory} />
                        <StatusMark status={issue.status} />
                        {issue.needsDiscussion && (
                            <span className="rounded bg-sev-medium/15 px-1.5 text-xs font-medium text-sev-medium">Needs discussion</span>
                        )}
                    </div>
                    <h2 id="issue-title" ref={headingRef} tabIndex={-1} className="text-lg leading-snug font-semibold outline-none">
                        <InlineCode text={issue.title} />
                    </h2>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-mono break-all">
                            {issue.path}
                            {issue.startLine ? `:${lines(issue.startLine, issue.endLine)}` : ""}
                        </span>
                        {source && (
                            <a href={source} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
                                View source <ExternalLink className="size-3" aria-hidden="true" />
                                <span className="sr-only">(opens in a new tab)</span>
                            </a>
                        )}
                        <span className="font-mono">{issue.id}</span>
                        {issue.addedBy && <span>Added by {issue.addedBy}</span>}
                    </p>
                </div>
                <Button variant="ghost" size="icon" className="size-8" onClick={close} aria-label="Close issue">
                    <X />
                </Button>
            </div>

            <ChangedElsewhere show={held.changedElsewhere} onReload={held.reload} what="This issue" keepsInput />
            {conflict && (
                <ConflictAlert
                    conflict={conflict}
                    onDismiss={() => setConflict(null)}
                    onRetry={() => {
                        const attempted = conflict.attempted;
                        void change(attempted).then((ok) => {
                            if (ok && attempted.note) setNote("");
                        });
                    }}
                />
            )}
            <FieldError message={error} />

            {canTriage && (
                <div className="grid gap-3 rounded-lg border bg-background p-3" data-testid="triage">
                    <fieldset className="grid gap-1.5">
                        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Status</legend>
                        <div className="flex flex-wrap gap-1">
                            {STATUSES.map((s: Status, i) => (
                                <Button
                                    key={s}
                                    size="sm"
                                    variant={issue.status === s ? "default" : "outline"}
                                    aria-pressed={issue.status === s}
                                    disabled={update.isPending}
                                    onClick={() =>
                                        issue.status !== s && void change({ status: s }, `Marked ${STATUS_LABEL[s].toLowerCase()}.`)
                                    }
                                    aria-keyshortcuts={shortcuts ? String(i + 1) : undefined}
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
                                value={assignee ?? issue.assignee ?? ""}
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
                            {assignee !== null && (
                                <>
                                    <Button type="submit" size="sm" disabled={update.isPending}>
                                        Save
                                    </Button>
                                    <Button type="button" size="sm" variant="ghost" onClick={() => setAssignee(null)}>
                                        Cancel
                                    </Button>
                                </>
                            )}
                            {assignee === null && issue.assignee !== me.user.displayName && (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => void change({ assignee: me.user.displayName }, "Assigned to you.")}
                                >
                                    Assign to me
                                </Button>
                            )}
                            {assignee === null && issue.assignee && (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void change({ assignee: null }, "Unassigned.")}
                                >
                                    Unassign
                                </Button>
                            )}
                        </div>
                    </form>

                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">Rating</span>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="outline">
                                    Correct the rating <ChevronDown />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuLabel className="text-xs text-muted-foreground">Severity</DropdownMenuLabel>
                                <DropdownMenuRadioGroup
                                    value={issue.severity}
                                    onValueChange={(v) =>
                                        v !== issue.severity &&
                                        void change(
                                            {
                                                severity:
                                                    v === (issue.reviewerSeverity ?? issue.severity) && issue.reviewerSeverity
                                                        ? "reviewer"
                                                        : (v as Severity),
                                            },
                                            `Rated ${v}.`,
                                        )
                                    }
                                >
                                    {SEVERITIES.map((s) => (
                                        <DropdownMenuRadioItem key={s} value={s}>
                                            <span className={`sev sev-${s}`}>{SEVERITY_LABEL[s]}</span>
                                        </DropdownMenuRadioItem>
                                    ))}
                                </DropdownMenuRadioGroup>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel className="text-xs text-muted-foreground">Category</DropdownMenuLabel>
                                <DropdownMenuRadioGroup
                                    value={issue.category}
                                    onValueChange={(v) =>
                                        v !== issue.category &&
                                        void change(
                                            {
                                                category:
                                                    v === (issue.reviewerCategory ?? issue.category) && issue.reviewerCategory
                                                        ? "reviewer"
                                                        : (v as Category),
                                            },
                                            `Filed under ${CATEGORY_LABEL[v as Category].toLowerCase()}.`,
                                        )
                                    }
                                >
                                    {CATEGORIES.map((c) => (
                                        <DropdownMenuRadioItem key={c} value={c}>
                                            {CATEGORY_LABEL[c]}
                                        </DropdownMenuRadioItem>
                                    ))}
                                </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        {(issue.reviewerSeverity || issue.reviewerCategory) && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    void change(
                                        {
                                            ...(issue.reviewerSeverity ? { severity: "reviewer" as const } : {}),
                                            ...(issue.reviewerCategory ? { category: "reviewer" as const } : {}),
                                        },
                                        "Reviewer's rating restored.",
                                    )
                                }
                            >
                                <RotateCcw /> Restore the reviewer's rating
                            </Button>
                        )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <div className="flex items-center gap-2">
                            <Switch
                                id={`${assigneeId}-discuss`}
                                checked={issue.needsDiscussion}
                                onCheckedChange={(v) =>
                                    void change({ needsDiscussion: v }, v ? "Flagged for discussion." : "Discussion flag cleared.")
                                }
                            />
                            <Label htmlFor={`${assigneeId}-discuss`}>Needs discussion</Label>
                        </div>
                        {issue.duplicateOf ? (
                            <Button size="sm" variant="ghost" onClick={() => void change({ duplicateOf: null }, "No longer a duplicate.")}>
                                Not a duplicate
                            </Button>
                        ) : (
                            <Button size="sm" variant="outline" onClick={() => setPickingDuplicate(true)}>
                                Mark as a duplicate…
                            </Button>
                        )}
                    </div>
                    <DuplicatePicker
                        open={pickingDuplicate}
                        onOpenChange={setPickingDuplicate}
                        issue={issue}
                        onPick={async (target) => {
                            if (await change({ duplicateOf: target.id }, `Marked a duplicate of ${target.id}.`)) setPickingDuplicate(false);
                        }}
                    />
                </div>
            )}

            {issue.duplicateOf && (
                <p className="text-sm">
                    Duplicate of{" "}
                    <Link
                        to="/w/$ws/p/$project/issues/$issueId"
                        params={{ ws, project: slug, issueId: issue.duplicateOf }}
                        search={{ ...listSearch, branch: branchParam } as never}
                        className="underline"
                    >
                        {issue.duplicateOfTitle ? <InlineCode text={issue.duplicateOfTitle} /> : issue.duplicateOf}
                    </Link>
                </p>
            )}

            <section aria-labelledby="finding-heading" className="grid gap-1.5">
                <h3 id="finding-heading" className="text-sm font-medium">
                    Finding
                </h3>
                <Markdown>{issue.content}</Markdown>
            </section>

            <CodeView existing={issue.existingCode} suggestion={issue.suggestionCode} startLine={issue.startLine} />

            {issue.duplicates.length > 0 && (
                <section aria-labelledby="dups-heading" className="grid gap-1.5">
                    <h3 id="dups-heading" className="text-sm font-medium">
                        Duplicates of this issue
                    </h3>
                    <ul className="grid gap-1 text-sm">
                        {issue.duplicates.map((d) => (
                            <li key={d.id}>
                                <Link
                                    to="/w/$ws/p/$project/issues/$issueId"
                                    params={{ ws, project: slug, issueId: d.id }}
                                    search={{ ...listSearch, branch: branchParam } as never}
                                    className="underline"
                                >
                                    <InlineCode text={d.title} />
                                </Link>{" "}
                                <span className="font-mono text-xs text-muted-foreground">
                                    {d.path}
                                    {d.startLine ? `:${d.startLine}` : ""}
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {issue.tasks.length > 0 && (
                <section aria-labelledby="tasks-heading" className="grid gap-1.5">
                    <h3 id="tasks-heading" className="text-sm font-medium">
                        Related tasks
                    </h3>
                    <ul className="grid gap-1 text-sm">
                        {issue.tasks.map((t) => (
                            <li key={t.id}>
                                <Link
                                    to="/w/$ws/p/$project/tasks/$taskId"
                                    params={{ ws, project: slug, taskId: t.id }}
                                    search={{ branch: branchParam }}
                                    className="underline"
                                >
                                    <InlineCode text={t.title} />
                                </Link>{" "}
                                <span className="text-xs text-muted-foreground">{t.section}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <section aria-labelledby="notes-heading" className="grid gap-2">
                <h3 id="notes-heading" className="text-sm font-medium">
                    Notes
                </h3>
                <NoteList
                    notes={issue.notes}
                    myKey={myKey}
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

            <p className={cn("text-xs text-muted-foreground", !issue.updatedAt && "hidden")}>
                Last changed {issue.updatedBy ? `by ${issue.updatedBy} ` : ""}
                <time dateTime={issue.updatedAt ?? undefined}>{formatDateTime(issue.updatedAt)}</time>
            </p>
        </section>
    );
}

export type { IssueDetail };
