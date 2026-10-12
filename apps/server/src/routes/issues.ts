// Issues and tasks on one branch: reading, triage, claims and notes.

import { z } from "zod";
import { type IssueFilters, MAX_ID, parseFilters } from "../domain/filters.ts";
import { issueMarkdown, issuesMarkdown, taskMarkdown } from "../domain/markdown.ts";
import { json, markdown, type Route, route } from "../http/route.ts";
import type { Services } from "../services/index.ts";
import type { BranchRef } from "../services/triage.ts";
import { BranchQuery, branchRef, Finding, IssuePatch, IssueQuery, P, queryParams } from "./common.ts";

const csvCell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Filters a branch's view can apply: those that name a common issue or an author become the ids of their findings. */
async function narrowed(services: Services, ref: BranchRef, filters: IssueFilters): Promise<IssueFilters> {
    return services.origins.narrow(ref.project, ref.branch, await services.patterns.narrow(ref.project, ref.branch, filters));
}

const NoteBody = z.object({ text: z.string().max(4000) });

export const issueRoutes: Route[] = [
    route({
        method: "GET",
        path: `${P}/issues`,
        scope: "project",
        permission: "read",
        tag: "Issues",
        summary: "Issues on a branch, filtered and sorted, with counts for the filtered set",
        query: IssueQuery.extend({ full: z.enum(["true", "false"]).optional().describe("Include each issue's text, code and notes") }),
        async handler(ctx) {
            const ref = branchRef(ctx, ctx.query.branch);
            const full = ctx.query.full === "true";
            const filters = await narrowed(ctx.services, ref, parseFilters(queryParams(ctx), { maxLimit: full ? 200 : 1000 }));
            const view = await ctx.services.reports.view(ctx.services.store, ref.project, ref.branch);
            return json({ branch: ref.branch, ...view.listIssues(filters, { full }) });
        },
    }),
    route({
        method: "GET",
        path: `${P}/issues.md`,
        scope: "project",
        permission: "read",
        tag: "Issues",
        summary: "Issues as Markdown, for agents",
        query: IssueQuery,
        produces: "markdown",
        async handler(ctx) {
            const ref = branchRef(ctx, ctx.query.branch);
            const filters = await narrowed(ctx.services, ref, parseFilters(queryParams(ctx), { maxLimit: 200, defaultLimit: 50 }));
            const view = await ctx.services.reports.view(ctx.services.store, ref.project, ref.branch);
            const result = view.listIssues(filters, { full: true });
            return markdown(issuesMarkdown(view, result as never, filters));
        },
    }),
    route({
        method: "GET",
        path: `${P}/issues.csv`,
        scope: "project",
        permission: "read",
        tag: "Issues",
        summary: "Issues as CSV",
        query: IssueQuery,
        produces: "csv",
        async handler(ctx) {
            const ref = branchRef(ctx, ctx.query.branch);
            const filters = await narrowed(ctx.services, ref, parseFilters(queryParams(ctx), { maxLimit: 100_000, defaultLimit: 100_000 }));
            const view = await ctx.services.reports.view(ctx.services.store, ref.project, ref.branch);
            const rows = view.listIssues(filters, { full: true }).items as unknown as Record<string, unknown>[];
            const cols = [
                "id",
                "severity",
                "category",
                "status",
                "assignee",
                "duplicateOf",
                "needsDiscussion",
                "path",
                "startLine",
                "endLine",
                "title",
                "content",
            ];
            const body = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n");
            return ctx.c.body(body, 200, {
                "content-type": "text/csv; charset=utf-8",
                "content-disposition": `attachment; filename="${ref.project.slug}-issues.csv"`,
            });
        },
    }),
    route({
        method: "POST",
        path: `${P}/issues`,
        scope: "project",
        permission: "triage",
        tag: "Issues",
        summary: "Add a finding by hand (kept when later reports are uploaded, unless they contain it)",
        query: BranchQuery,
        body: Finding,
        async handler(ctx) {
            return json(await ctx.services.reports.addFinding(ctx.actor, branchRef(ctx, ctx.query.branch), ctx.body), 201);
        },
    }),
    route({
        method: "POST",
        path: `${P}/issues/bulk`,
        scope: "project",
        permission: "triage",
        tag: "Issues",
        summary: "Make one change to many issues",
        query: BranchQuery,
        body: IssuePatch.omit({ rev: true }).extend({ ids: z.array(z.string().max(MAX_ID)).min(1).max(1000) }),
        async handler(ctx) {
            return json(await ctx.services.triage.bulkUpdate(ctx.actor, branchRef(ctx, ctx.query.branch), ctx.body));
        },
    }),
    route({
        method: "POST",
        path: `${P}/issues/claim`,
        scope: "project",
        permission: "triage",
        tag: "Issues",
        summary: "Claim the most urgent open, unassigned issue that matches (marked in progress for you)",
        description: "Two callers never get the same issue. Issues flagged as needing discussion are never handed out.",
        query: BranchQuery,
        body: z.object({
            severity: z.string().optional(),
            category: z.string().optional(),
            path: z.string().max(500).optional(),
            q: z.string().max(200).optional(),
            task: z.string().max(MAX_ID).optional(),
            assignee: z.string().max(64).optional().describe("Who to assign it to (default: you)"),
            note: z.string().max(4000).optional(),
        }),
        async handler(ctx) {
            return json(await ctx.services.triage.claimNext(ctx.actor, branchRef(ctx, ctx.query.branch), ctx.body));
        },
    }),
    route({
        method: "GET",
        path: `${P}/issues/{id}`,
        scope: "project",
        permission: "read",
        tag: "Issues",
        summary: "One issue with its text, code, notes and duplicates",
        query: BranchQuery,
        async handler(ctx) {
            const ref = branchRef(ctx, ctx.query.branch);
            const view = await ctx.services.reports.view(ctx.services.store, ref.project, ref.branch);
            const issue = view.getIssue(ctx.params.id as string);
            // The common issue it's under, with its advice, if it's under one.
            return json({
                ...issue,
                commonIssue: await ctx.services.patterns.forIssue(ref.project, ref.branch, issue.id),
                // The commit behind its lines, when the workspace traces findings to commits.
                origin: await ctx.services.origins.forIssue(ref.project, ref.branch, issue.id),
            });
        },
    }),
    route({
        method: "GET",
        path: `${P}/issues/{id}/markdown`,
        scope: "project",
        permission: "read",
        tag: "Issues",
        summary: "One issue as Markdown",
        query: BranchQuery,
        produces: "markdown",
        async handler(ctx) {
            const ref = branchRef(ctx, ctx.query.branch);
            const view = await ctx.services.reports.view(ctx.services.store, ref.project, ref.branch);
            return markdown(issueMarkdown(view.getIssue(ctx.params.id as string), ref.branch));
        },
    }),
    route({
        method: "PATCH",
        path: `${P}/issues/{id}`,
        scope: "project",
        permission: "triage",
        tag: "Issues",
        summary: "Change an issue: status, assignee, rating, duplicate, discussion flag, and/or add a note",
        query: BranchQuery,
        body: IssuePatch,
        async handler(ctx) {
            return json(
                await ctx.services.triage.updateIssue(ctx.actor, branchRef(ctx, ctx.query.branch), ctx.params.id as string, ctx.body),
            );
        },
    }),
    route({
        method: "POST",
        path: `${P}/issues/{id}/release`,
        scope: "project",
        permission: "triage",
        tag: "Issues",
        summary: "Hand back an issue you claimed (force: someone else's)",
        query: BranchQuery,
        body: z.object({ note: z.string().max(4000).optional(), force: z.boolean().optional() }),
        async handler(ctx) {
            return json(
                await ctx.services.triage.releaseIssue(ctx.actor, branchRef(ctx, ctx.query.branch), ctx.params.id as string, ctx.body),
            );
        },
    }),
    route({
        method: "PATCH",
        path: `${P}/issues/{id}/notes/{noteId}`,
        scope: "project",
        permission: "triage",
        tag: "Issues",
        summary: "Edit your own note on an issue",
        query: BranchQuery,
        body: NoteBody,
        async handler(ctx) {
            const actor = { ...ctx.actor, canModerate: ctx.can("moderate") };
            return json(
                await ctx.services.triage.changeNote(
                    actor,
                    branchRef(ctx, ctx.query.branch),
                    "issue",
                    ctx.params.id as string,
                    ctx.params.noteId as string,
                    ctx.body.text,
                ),
            );
        },
    }),
    route({
        method: "DELETE",
        path: `${P}/issues/{id}/notes/{noteId}`,
        scope: "project",
        permission: "triage",
        tag: "Issues",
        summary: "Delete your own note on an issue (admins: anyone's)",
        query: BranchQuery,
        async handler(ctx) {
            const actor = { ...ctx.actor, canModerate: ctx.can("moderate") };
            return json(
                await ctx.services.triage.changeNote(
                    actor,
                    branchRef(ctx, ctx.query.branch),
                    "issue",
                    ctx.params.id as string,
                    ctx.params.noteId as string,
                    null,
                ),
            );
        },
    }),

    // ---- tasks ---------------------------------------------------------------------------------
    route({
        method: "GET",
        path: `${P}/tasks`,
        scope: "project",
        permission: "read",
        tag: "Tasks",
        summary: "The reviewer's summary items as tasks, linked to the issues in the files they name",
        query: BranchQuery.extend({ section: z.string().max(MAX_ID).optional(), status: z.string().optional() }),
        async handler(ctx) {
            const ref = branchRef(ctx, ctx.query.branch);
            const view = await ctx.services.reports.view(ctx.services.store, ref.project, ref.branch);
            const status = parseFilters({ status: ctx.query.status }).status;
            return json({ branch: ref.branch, ...view.listTasks({ section: ctx.query.section ?? "", status }) });
        },
    }),
    route({
        method: "GET",
        path: `${P}/tasks/{id}`,
        scope: "project",
        permission: "read",
        tag: "Tasks",
        summary: "One task with its linked issues and notes",
        query: BranchQuery,
        async handler(ctx) {
            const ref = branchRef(ctx, ctx.query.branch);
            const view = await ctx.services.reports.view(ctx.services.store, ref.project, ref.branch);
            return json(view.getTask(ctx.params.id as string));
        },
    }),
    route({
        method: "GET",
        path: `${P}/tasks/{id}/markdown`,
        scope: "project",
        permission: "read",
        tag: "Tasks",
        summary: "One task as Markdown",
        query: BranchQuery,
        produces: "markdown",
        async handler(ctx) {
            const ref = branchRef(ctx, ctx.query.branch);
            const view = await ctx.services.reports.view(ctx.services.store, ref.project, ref.branch);
            return markdown(taskMarkdown(view.getTask(ctx.params.id as string)));
        },
    }),
    route({
        method: "PATCH",
        path: `${P}/tasks/{id}`,
        scope: "project",
        permission: "triage",
        tag: "Tasks",
        summary: "Change a task's status or assignee, and/or add a note",
        query: BranchQuery,
        body: IssuePatch.pick({ status: true, assignee: true, note: true, rev: true }).strict(),
        async handler(ctx) {
            return json(
                await ctx.services.triage.updateTask(ctx.actor, branchRef(ctx, ctx.query.branch), ctx.params.id as string, ctx.body),
            );
        },
    }),
    route({
        method: "PATCH",
        path: `${P}/tasks/{id}/notes/{noteId}`,
        scope: "project",
        permission: "triage",
        tag: "Tasks",
        summary: "Edit your own note on a task",
        query: BranchQuery,
        body: NoteBody,
        async handler(ctx) {
            const actor = { ...ctx.actor, canModerate: ctx.can("moderate") };
            return json(
                await ctx.services.triage.changeNote(
                    actor,
                    branchRef(ctx, ctx.query.branch),
                    "task",
                    ctx.params.id as string,
                    ctx.params.noteId as string,
                    ctx.body.text,
                ),
            );
        },
    }),
    route({
        method: "DELETE",
        path: `${P}/tasks/{id}/notes/{noteId}`,
        scope: "project",
        permission: "triage",
        tag: "Tasks",
        summary: "Delete your own note on a task (admins: anyone's)",
        query: BranchQuery,
        async handler(ctx) {
            const actor = { ...ctx.actor, canModerate: ctx.can("moderate") };
            return json(
                await ctx.services.triage.changeNote(
                    actor,
                    branchRef(ctx, ctx.query.branch),
                    "task",
                    ctx.params.id as string,
                    ctx.params.noteId as string,
                    null,
                ),
            );
        },
    }),
];
