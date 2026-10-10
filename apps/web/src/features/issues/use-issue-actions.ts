// Changing issues. Every single-issue change carries the `rev` the person was looking at; if someone
// else saved first, the server answers 409 with their version, which replaces ours on screen.

import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Category, Severity, Status } from "@triagent/shared";
import { api, conflictCurrent, paths } from "@/lib/api";
import { keys } from "@/lib/queries";
import type { IssueDetail, IssueList, IssueSummary, Note } from "@/lib/types";

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

/** What a bulk change can set: the fields the list knows the previous value of, so each can be put back. */
export type BulkChange = Pick<IssueChange, "status" | "assignee" | "severity" | "needsDiscussion">;
type Before = Pick<IssueSummary, "id" | "status" | "assignee" | "severity" | "reviewerSeverity" | "needsDiscussion">;

/** The change that puts one issue back as it was before `change`. */
export function inverseOf(x: Before, change: BulkChange): BulkChange {
    const back: BulkChange = {};
    if (change.status !== undefined) back.status = x.status;
    if (change.assignee !== undefined) back.assignee = x.assignee;
    // A rating someone corrected is put back as theirs; otherwise it goes back to the reviewer's.
    if (change.severity !== undefined) back.severity = x.reviewerSeverity ? x.severity : "reviewer";
    if (change.needsDiscussion !== undefined) back.needsDiscussion = x.needsDiscussion;
    return back;
}

/** Undo for a bulk change: one bulk request for each distinct previous value, with the issues that had it. */
export function undoPlan(before: readonly Before[], change: BulkChange): { ids: string[]; change: BulkChange }[] {
    const groups = new Map<string, { ids: string[]; change: BulkChange }>();
    for (const x of before) {
        const back = inverseOf(x, change);
        const key = JSON.stringify([back.status, back.assignee, back.severity, back.needsDiscussion]);
        const group = groups.get(key);
        if (group) group.ids.push(x.id);
        else groups.set(key, { ids: [x.id], change: back });
    }
    return [...groups.values()];
}

/** How many ids go in one request's address when reading issues by id. */
const IDS_PER_REQUEST = 100;

export function useBulkUpdate(ref: Ref) {
    const queryClient = useQueryClient();
    const url = `${paths.project(ref.ws, ref.project)}/issues`;
    const post = (ids: string[], change: BulkChange) =>
        api.post<{ matched: number; changed: number }>(`${url}/bulk`, { ids, ...change }, { branch: ref.branch });
    return useMutation({
        /**
         * Makes the change, and answers with how to undo it: the issues as they were just before, from the
         * list on screen (`known`) and, for selected issues that aren't in it, read from the server first.
         * If those can't be read the change still goes ahead, without an undo.
         */
        mutationFn: async ({ ids, change, known }: { ids: string[]; change: BulkChange; known: readonly IssueSummary[] }) => {
            const byId = new Map(known.map((x) => [x.id, x]));
            const missing = ids.filter((id) => !byId.has(id));
            let complete = true;
            try {
                for (let i = 0; i < missing.length; i += IDS_PER_REQUEST) {
                    const chunk = missing.slice(i, i + IDS_PER_REQUEST);
                    const page = await api.get<IssueList>(url, {
                        branch: ref.branch,
                        ids: chunk.join(","),
                        limit: String(IDS_PER_REQUEST),
                    });
                    for (const x of page.items) byId.set(x.id, x);
                }
            } catch {
                complete = false;
            }
            const before = ids.map((id) => byId.get(id)).filter((x): x is IssueSummary => x !== undefined);
            const result = await post(ids, change);
            const plan = complete && before.length === ids.length ? undoPlan(before, change) : null;
            return {
                ...result,
                /** Puts every issue back as it was; null when the previous values aren't all known. */
                undo: plan
                    ? async () => {
                          try {
                              for (const step of plan) await post(step.ids, step.change);
                          } finally {
                              refreshBranch(queryClient, ref);
                          }
                      }
                    : null,
            };
        },
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
