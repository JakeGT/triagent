// Changing issues. Every single-issue change carries the `rev` the person was looking at; if someone
// else saved first, the server answers 409 with their version, which replaces ours on screen.

import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Category, Severity, Status } from "@triagent/shared";
import { api, conflictCurrent, paths } from "@/lib/api";
import { keys } from "@/lib/queries";
import type { IssueDetail, Note } from "@/lib/types";

export interface IssueChange {
    status?: Status;
    assignee?: string | null;
    severity?: Severity | "reviewer";
    category?: Category | "reviewer";
    duplicateOf?: string | null;
    needsDiscussion?: boolean;
    note?: string;
}

interface Ref {
    ws: string;
    project: string;
    branch: string;
}

/** Refresh everything on the branch that shows issues, except the issue we just updated ourselves. */
export function refreshBranch(queryClient: QueryClient, { ws, project, branch }: Ref, exceptIssue?: string) {
    void queryClient.invalidateQueries({
        queryKey: keys.branch(ws, project, branch),
        predicate: (q) => !(exceptIssue && q.queryKey[6] === "issue" && q.queryKey[7] === exceptIssue),
    });
    void queryClient.invalidateQueries({ queryKey: keys.branches(ws, project) });
    void queryClient.invalidateQueries({ queryKey: ["ws", ws, "p", project, "activity"] });
}

export class IssueConflict extends Error {
    readonly current: IssueDetail;
    readonly attempted: IssueChange;
    constructor(current: IssueDetail, attempted: IssueChange) {
        super("Someone else changed this issue first.");
        this.current = current;
        this.attempted = attempted;
    }
}

export function useUpdateIssue(ref: Ref, onSaved?: (issue: IssueDetail) => void) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ id, rev, change }: { id: string; rev: number; change: IssueChange }) => {
            try {
                return await api.patch<{ issue: IssueDetail; changed: boolean }>(
                    `${paths.project(ref.ws, ref.project)}/issues/${encodeURIComponent(id)}`,
                    { ...change, rev },
                    { branch: ref.branch },
                );
            } catch (err) {
                const current = conflictCurrent<IssueDetail>(err);
                if (current) throw new IssueConflict(current, change);
                throw err;
            }
        },
        onSuccess: ({ issue }) => {
            queryClient.setQueryData(keys.issue(ref.ws, ref.project, ref.branch, issue.id), issue);
            onSaved?.(issue);
            refreshBranch(queryClient, ref, issue.id);
        },
        onError: (err) => {
            if (err instanceof IssueConflict) {
                queryClient.setQueryData(keys.issue(ref.ws, ref.project, ref.branch, err.current.id), err.current);
                onSaved?.(err.current);
                refreshBranch(queryClient, ref, err.current.id);
            }
        },
    });
}

export function useBulkUpdate(ref: Ref) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ ids, change }: { ids: string[]; change: Omit<IssueChange, "note"> & { note?: string } }) =>
            api.post<{ matched: number; changed: number }>(
                `${paths.project(ref.ws, ref.project)}/issues/bulk`,
                { ids, ...change },
                { branch: ref.branch },
            ),
        onSettled: () => refreshBranch(queryClient, ref),
    });
}

/** Edit (text) or delete (null) a note on an issue or task. */
export function useChangeNote(ref: Ref, kind: "issues" | "tasks", itemId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ noteId, text }: { noteId: string; text: string | null }) => {
            const url = `${paths.project(ref.ws, ref.project)}/${kind}/${encodeURIComponent(itemId)}/notes/${encodeURIComponent(noteId)}`;
            return text === null
                ? api.delete<{ note: Note; changed: boolean }>(url, undefined, { branch: ref.branch })
                : api.patch<{ note: Note; changed: boolean }>(url, { text }, { branch: ref.branch });
        },
        onSettled: () =>
            queryClient.invalidateQueries({
                queryKey:
                    kind === "issues"
                        ? keys.issue(ref.ws, ref.project, ref.branch, itemId)
                        : keys.task(ref.ws, ref.project, ref.branch, itemId),
            }),
    });
}
