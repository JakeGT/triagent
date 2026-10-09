// MCP tools. Each declares the permission it needs (the same table as the API), a zod input schema
// (published as JSON Schema), and runs through the same services as the REST API.

import { CATEGORIES, type Permission, SEVERITIES, STATUSES } from "@triagent/shared";
import { z } from "zod";
import { parseFilters } from "../domain/filters.ts";
import { issueMarkdown, overviewMarkdown, taskMarkdown } from "../domain/markdown.ts";
import { badRequest, notFound } from "../errors.ts";
import type { Access } from "../services/accounts.ts";
import type { Actor } from "../services/core.ts";
import type { Services } from "../services/index.ts";
import { publicProject } from "../services/projects.ts";
import { AutomationSchema } from "../services/settings.ts";
import type { BranchRef } from "../services/triage.ts";
import type { Project } from "../store/types.ts";
import { analyticsTool } from "./analytics-tool.ts";

export interface ToolContext {
    services: Services;
    access: Access;
    actor: Actor;
    can(permission: Permission): boolean;
}

export interface ToolResult {
    text: string;
    data?: unknown;
    isError?: boolean;
}

export interface Tool {
    name: string;
    title: string;
    description: string;
    permission: Permission;
    input: z.ZodObject;
    readOnly?: boolean;
    destructive?: boolean;
    run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const project = z
    .string()
    .max(40)
    .optional()
    .describe("Project id (see list_projects). Optional when the workspace has one project. Match it to the repository you're working in.");
const branch = z.string().max(200).optional().describe("Git branch. Default: the project's default branch (see list_branches).");
const where = { project, branch };
const filterProps = {
    severity: z.array(z.enum(SEVERITIES)).optional(),
    category: z.array(z.enum(CATEGORIES)).optional(),
    status: z.array(z.enum(STATUSES)).optional(),
    path: z.string().max(500).optional().describe("A file, or a folder ending in /"),
    q: z.string().max(200).optional().describe("Words that must all appear"),
    task: z.string().max(100).optional().describe("Only issues linked to this task"),
    foundBy: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Only findings at least this many models found (for reviews run with several models)"),
};
const editProps = {
    status: z.enum(STATUSES).optional(),
    assignee: z.string().max(64).nullable().optional().describe("null to unassign"),
    severity: z
        .union([z.enum(SEVERITIES), z.literal("reviewer")])
        .optional()
        .describe('Correct the reviewer\'s severity; "reviewer" puts it back'),
    category: z.union([z.enum(CATEGORIES), z.literal("reviewer")]).optional(),
    duplicateOf: z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe("Mark as a duplicate of another issue (it becomes won't fix); null to undo"),
    needsDiscussion: z.boolean().optional().describe("Flag for a person to decide; agents never claim flagged issues"),
    note: z.string().max(4000).optional(),
};

async function projectOf(ctx: ToolContext, slug: unknown): Promise<Project> {
    if (typeof slug === "string" && slug) return ctx.services.projects.get(ctx.services.store, ctx.access.workspace, slug);
    const all = await ctx.services.store.projects.forWorkspace(ctx.access.workspace.id);
    if (all.length === 1) return all[0] as Project;
    if (!all.length) throw notFound("This workspace has no projects yet.");
    throw badRequest(
        `Name the project: one of ${all.map((p) => p.slug).join(", ")}. Match it to the repository's git remote (see list_projects).`,
    );
}

async function refOf(ctx: ToolContext, args: Record<string, unknown>): Promise<BranchRef> {
    const p = await projectOf(ctx, args.project);
    return { project: p, branch: ctx.services.reports.branchOf(p, args.branch) };
}

async function viewOf(ctx: ToolContext, args: Record<string, unknown>) {
    const ref = await refOf(ctx, args);
    return { ref, view: await ctx.services.reports.view(ctx.services.store, ref.project, ref.branch) };
}

/** How many findings compare_branches lists in its text, per section. */
const COMPARE_LINES = 100;

const line = (x: {
    id: string;
    severity: string;
    category: string;
    status: string;
    path: string;
    startLine: number | null;
    title: string;
    assignee?: string | null;
    foundBy?: string[] | null;
}) =>
    `- ${x.id} [${x.severity}/${x.category}/${x.status}${x.assignee ? ` @${x.assignee}` : ""}] \`${x.path}${x.startLine ? `:${x.startLine}` : ""}\` — ${x.title}${x.foundBy ? ` (found by ${x.foundBy.join(", ")})` : ""}`;

function tool(t: Tool): Tool {
    return t;
}

export const TOOLS: Tool[] = [
    tool({
        name: "list_projects",
        title: "List projects",
        description:
            "The workspace's projects (one per codebase) with their repository addresses. Match the repository you're working in by its git remote, and pass that project's id to the other tools.",
        permission: "read",
        readOnly: true,
        input: z.object({}),
        async run(ctx) {
            const items = await ctx.services.projects.list(ctx.access.workspace);
            return {
                text:
                    items
                        .map(
                            (p) =>
                                `- ${p.slug}: ${p.name}${p.repoUrl ? ` (${p.repoUrl})` : ""}, default branch ${p.defaultBranch}, ${p.branches} branch(es) with reports`,
                        )
                        .join("\n") || "No projects yet.",
                data: { items },
            };
        },
    }),
    tool({
        name: "list_branches",
        title: "List branches",
        description: "Branches of a project that have a report, with how many issues are unresolved.",
        permission: "read",
        readOnly: true,
        input: z.object({ project }),
        async run(ctx, args) {
            const data = await ctx.services.reports.branches(await projectOf(ctx, args.project));
            return {
                text:
                    data.items
                        .map(
                            (b) =>
                                `- ${b.name}${b.isDefault ? " (default)" : ""}: ${b.unresolved} unresolved of ${b.issues}, uploaded ${b.uploadedAt} by ${b.uploadedBy}`,
                        )
                        .join("\n") || "No reports yet.",
                data,
            };
        },
    }),
    tool({
        name: "compare_branches",
        title: "Compare branches",
        description:
            "Findings a branch adds, and findings from the base branch it no longer has (probably fixed there). Useful when reviewing a pull request.",
        permission: "read",
        readOnly: true,
        input: z.object({
            project,
            head: z.string().max(200),
            base: z.string().max(200).optional().describe("Default: the default branch"),
        }),
        async run(ctx, args) {
            const p = await projectOf(ctx, args.project);
            const c = await ctx.services.reports.compare(
                p,
                ctx.services.reports.branchOf(p, args.base),
                ctx.services.reports.branchOf(p, args.head),
            );
            // A long list would flood the agent's context: the first ones, and how many more (all are in the data).
            const some = (items: typeof c.added.items) => [
                ...items.slice(0, COMPARE_LINES).map(line),
                ...(items.length > COMPARE_LINES ? [`- … and ${items.length - COMPARE_LINES} more`] : []),
            ];
            const text = [
                `# ${c.head} compared with ${c.base}`,
                "",
                `## New on ${c.head} (${c.added.total})`,
                ...some(c.added.items),
                "",
                `## Gone from ${c.head} (${c.gone.total})`,
                ...some(c.gone.items),
                "",
                `${c.shared.total} findings are on both.`,
            ].join("\n");
            return { text, data: c };
        },
    }),
    tool({
        name: "review_overview",
        title: "Review overview",
        description: "A branch at a glance: totals, progress by severity, hotspot files and the reviewer's themes.",
        permission: "read",
        readOnly: true,
        input: z.object(where),
        async run(ctx, args) {
            const { ref, view } = await viewOf(ctx, args);
            return { text: overviewMarkdown(view, `${ref.project.name}, branch ${ref.branch}`) };
        },
    }),
    tool({
        name: "list_issues",
        title: "List issues",
        description: "Issues on a branch, most urgent first, with filters. Returns one line per issue; use get_issue for details.",
        permission: "read",
        readOnly: true,
        input: z.object({
            ...where,
            ...filterProps,
            assignee: z.string().max(64).optional().describe('A name, or "none"'),
            limit: z.number().int().min(1).max(200).optional(),
            offset: z.number().int().min(0).optional(),
        }),
        async run(ctx, args) {
            const { view } = await viewOf(ctx, args);
            const filters = parseFilters(args, { maxLimit: 200, defaultLimit: 50 });
            const r = view.listIssues(filters);
            const more = r.offset + r.items.length < r.total ? `\n_More: repeat with offset ${r.offset + r.items.length}._` : "";
            return {
                text: `${r.total} matching issue(s) on ${view.branch}; showing ${r.items.length}.\n${r.items.map(line).join("\n")}${more}`,
                data: r,
            };
        },
    }),
    tool({
        name: "get_issue",
        title: "Get issue",
        description:
            "One issue in full: the finding, existing and suggested code, notes, duplicates and its revision (pass rev back to update_issue).",
        permission: "read",
        readOnly: true,
        input: z.object({ ...where, id: z.string().max(100) }),
        async run(ctx, args) {
            const { view } = await viewOf(ctx, args);
            const issue = view.getIssue(String(args.id));
            return { text: issueMarkdown(issue, view.branch), data: issue };
        },
    }),
    tool({
        name: "update_issue",
        title: "Update issue",
        description:
            "Change an issue's status, assignee, rating, duplicate or discussion flag, and/or add a note. Pass rev (from get_issue) so you never overwrite someone else's change.",
        permission: "triage",
        input: z.object({ ...where, id: z.string().max(100), rev: z.number().int().min(0).optional(), ...editProps }),
        async run(ctx, args) {
            const { project: _p, branch: _b, id, ...patch } = args;
            const r = await ctx.services.triage.updateIssue(ctx.actor, await refOf(ctx, args), String(id), patch);
            return { text: `${r.changed ? "Updated" : "No change to"} ${line(r.issue)}`, data: r };
        },
    }),
    tool({
        name: "bulk_update_issues",
        title: "Update many issues",
        description: "Apply one change to up to 1000 issues, e.g. after one commit fixes several findings.",
        permission: "triage",
        input: z.object({ ...where, ids: z.array(z.string().max(100)).min(1).max(1000), ...editProps }),
        async run(ctx, args) {
            const { project: _p, branch: _b, ...body } = args;
            const r = await ctx.services.triage.bulkUpdate(ctx.actor, await refOf(ctx, args), body);
            return { text: `Changed ${r.changed} of ${r.matched} issue(s).`, data: r };
        },
    }),
    tool({
        name: "claim_next_issue",
        title: "Claim next issue",
        description:
            "Take the most urgent open, unassigned issue that matches, marked in progress for you. Safe with several agents: two callers never get the same issue. Release it with release_issue if you stop.",
        permission: "triage",
        input: z.object({ ...where, ...filterProps, note: z.string().max(4000).optional() }),
        async run(ctx, args) {
            const { project: _p, branch: _b, ...body } = args;
            const ref = await refOf(ctx, args);
            const r = await ctx.services.triage.claimNext(ctx.actor, ref, body);
            if (!r.issue) return { text: r.message ?? "Nothing to claim.", data: r };
            return { text: `Claimed:\n\n${issueMarkdown(r.issue, ref.branch)}`, data: r };
        },
    }),
    tool({
        name: "release_issue",
        title: "Release issue",
        description: "Hand back an issue you claimed: it goes back to open and unassigned. force releases someone else's.",
        permission: "triage",
        input: z.object({ ...where, id: z.string().max(100), note: z.string().max(4000).optional(), force: z.boolean().optional() }),
        async run(ctx, args) {
            const r = await ctx.services.triage.releaseIssue(ctx.actor, await refOf(ctx, args), String(args.id), {
                note: args.note,
                force: args.force,
            });
            return { text: `Released ${line(r.issue)}`, data: r };
        },
    }),
    tool({
        name: "edit_note",
        title: "Edit note",
        description: "Change the text of one of your own notes on an issue or task (note ids appear in brackets in get_issue).",
        permission: "triage",
        input: z.object({
            ...where,
            kind: z.enum(["issue", "task"]).optional(),
            id: z.string().max(100),
            noteId: z.string().max(40),
            text: z.string().max(4000),
        }),
        async run(ctx, args) {
            const r = await ctx.services.triage.changeNote(
                { ...ctx.actor, canModerate: ctx.can("moderate") },
                await refOf(ctx, args),
                args.kind === "task" ? "task" : "issue",
                String(args.id),
                String(args.noteId),
                String(args.text),
            );
            return { text: r.changed ? "Note updated." : "No change.", data: r };
        },
    }),
    tool({
        name: "delete_note",
        title: "Delete note",
        description: "Delete one of your own notes on an issue or task.",
        permission: "triage",
        destructive: true,
        input: z.object({ ...where, kind: z.enum(["issue", "task"]).optional(), id: z.string().max(100), noteId: z.string().max(40) }),
        async run(ctx, args) {
            await ctx.services.triage.changeNote(
                { ...ctx.actor, canModerate: ctx.can("moderate") },
                await refOf(ctx, args),
                args.kind === "task" ? "task" : "issue",
                String(args.id),
                String(args.noteId),
                null,
            );
            return { text: "Note deleted." };
        },
    }),
    tool({
        name: "add_issue",
        title: "Add issue",
        description:
            "Record a finding you spotted yourself. It's marked as added by you, and kept when later reports are uploaded unless they contain the same finding.",
        permission: "triage",
        input: z.object({
            ...where,
            path: z.string().max(500).describe("Relative to the repository root"),
            content: z.string().max(8000).describe("What's wrong and why it matters"),
            severity: z.enum(SEVERITIES).optional(),
            category: z.enum(CATEGORIES).optional(),
            startLine: z.number().int().positive().optional(),
            endLine: z.number().int().positive().optional(),
            existingCode: z.string().max(20_000).optional(),
            suggestionCode: z.string().max(20_000).optional(),
        }),
        async run(ctx, args) {
            const { project: _p, branch: _b, ...finding } = args;
            const r = await ctx.services.reports.addFinding(ctx.actor, await refOf(ctx, args), finding);
            return { text: `Added ${line(r.issue)}`, data: r };
        },
    }),
    tool({
        name: "create_upload_link",
        title: "Create upload link",
        description:
            "A single-use URL (valid 15 minutes) for uploading Open Code Review's JSON report with curl, so the report never passes through this conversation: `curl -fsS --data-binary @code_review.json -H 'Content-Type: application/json' <url>`. Pass the branch and commit from git.",
        permission: "upload",
        input: z.object({
            ...where,
            commit: z.string().max(40).optional(),
            confirm: z.boolean().optional().describe("Replace a report that still has unresolved issues"),
        }),
        async run(ctx, args) {
            const ref = await refOf(ctx, args);
            const link = await ctx.services.reports.createLink(ctx.actor, ref.project, {
                branch: ref.branch,
                commit: args.commit,
                confirm: args.confirm,
            });
            return {
                text: `Upload with:\n\ncurl -fsS --data-binary @code_review.json -H 'Content-Type: application/json' '${link.url}'\n\nThe link works once and expires at ${link.expiresAt}.`,
                data: link,
            };
        },
    }),
    tool({
        name: "upload_report",
        title: "Upload report",
        description: "Upload a small report inline (under 200,000 characters). For anything larger use create_upload_link.",
        permission: "upload",
        input: z.object({
            ...where,
            report: z.object({ comments: z.array(z.record(z.string(), z.unknown())) }).passthrough(),
            commit: z.string().max(40).optional(),
            confirm: z.boolean().optional(),
            reopen: z.boolean().optional(),
        }),
        async run(ctx, args) {
            if (JSON.stringify(args.report).length > 200_000)
                throw badRequest("That report is too large to send inline. Use create_upload_link.");
            const ref = await refOf(ctx, args);
            const r = await ctx.services.reports.upload(ctx.actor, ref.project, {
                branch: ref.branch,
                report: args.report,
                commit: args.commit,
                confirm: args.confirm,
                reopen: args.reopen,
                fileName: "code_review.json",
            });
            return {
                text: `Uploaded to ${ref.branch}: ${r.next.issues} findings (${r.carriedOver} carried over, ${r.added} new, ${r.removed} gone).`,
                data: r,
            };
        },
    }),
    tool({
        name: "list_tasks",
        title: "List tasks",
        description:
            "The reviewer's summary items (top issues, hotspots, cross-cutting concerns, quick wins) as trackable tasks. Only full scans have a summary.",
        permission: "read",
        readOnly: true,
        input: z.object({ ...where, section: z.string().max(100).optional(), status: z.array(z.enum(STATUSES)).optional() }),
        async run(ctx, args) {
            const { view } = await viewOf(ctx, args);
            const r = view.listTasks({ section: String(args.section ?? ""), status: (args.status as never) ?? [] });
            return {
                text:
                    r.items
                        .map((t) => `- ${t.id} [${t.status}] ${t.title} — ${t.issuesDone}/${t.issueCount} linked issues done`)
                        .join("\n") || "No tasks: this report has no reviewer summary.",
                data: r,
            };
        },
    }),
    tool({
        name: "get_task",
        title: "Get task",
        description: "One task with its linked issues and notes.",
        permission: "read",
        readOnly: true,
        input: z.object({ ...where, id: z.string().max(100) }),
        async run(ctx, args) {
            const { view } = await viewOf(ctx, args);
            const t = view.getTask(String(args.id));
            return { text: taskMarkdown(t), data: t };
        },
    }),
    tool({
        name: "update_task",
        title: "Update task",
        description: "Change a task's status or assignee, and/or add a note.",
        permission: "triage",
        input: z.object({
            ...where,
            id: z.string().max(100),
            rev: z.number().int().min(0).optional(),
            status: editProps.status,
            assignee: editProps.assignee,
            note: editProps.note,
        }),
        async run(ctx, args) {
            const { project: _p, branch: _b, id, ...patch } = args;
            const r = await ctx.services.triage.updateTask(ctx.actor, await refOf(ctx, args), String(id), patch);
            return { text: `${r.changed ? "Updated" : "No change to"} task ${r.task.id} [${r.task.status}] ${r.task.title}`, data: r };
        },
    }),
    tool({
        name: "list_files",
        title: "List files",
        description: "Files with findings, most open issues (weighted by severity) first.",
        permission: "read",
        readOnly: true,
        input: z.object({ ...where, prefix: z.string().max(500).optional(), limit: z.number().int().min(1).max(1000).optional() }),
        async run(ctx, args) {
            const { view } = await viewOf(ctx, args);
            const r = view.listFiles({ prefix: String(args.prefix ?? ""), limit: Number(args.limit ?? 100) });
            return { text: r.items.map((f) => `- \`${f.path}\` — ${f.open} open of ${f.total}`).join("\n") || "No findings.", data: r };
        },
    }),
    tool({
        name: "get_summary",
        title: "Get reviewer summary",
        description: "The reviewer's written summary of the codebase (Markdown). Only full scans have one.",
        permission: "read",
        readOnly: true,
        input: z.object(where),
        async run(ctx, args) {
            const { view } = await viewOf(ctx, args);
            return { text: view.review.summaryMarkdown || "This report has no reviewer summary." };
        },
    }),
    tool({
        name: "list_activity",
        title: "List activity",
        description: "Recent changes to a project (one branch, or all), newest first.",
        permission: "read",
        readOnly: true,
        input: z.object({
            project,
            branch: z.string().max(200).optional().describe("Only this branch"),
            limit: z.number().int().min(1).max(200).optional(),
        }),
        async run(ctx, args) {
            const p = await projectOf(ctx, args.project);
            const items = await ctx.services.reports.activity(
                p,
                typeof args.branch === "string" ? args.branch : null,
                Number(args.limit ?? 50),
            );
            return {
                text:
                    items
                        .map(
                            (e) =>
                                `- ${e.at} ${e.actor} (${e.via}) ${e.kind} ${e.itemId}${e.branch ? ` on ${e.branch}` : ""}: ${Object.keys(e.changes).join(", ")}`,
                        )
                        .join("\n") || "No activity yet.",
                data: { items },
            };
        },
    }),

    analyticsTool,

    // ---- configuration (manage tokens) ---------------------------------------------------------
    tool({
        name: "create_project",
        title: "Create project",
        description: "Add a project for a codebase.",
        permission: "configure",
        input: z.object({
            slug: z.string().max(40).describe("Lower-case letters, digits and dashes; the repository name works well"),
            name: z.string().max(80).optional(),
            repoUrl: z.string().max(300).optional(),
            defaultBranch: z.string().max(200).optional(),
        }),
        async run(ctx, args) {
            const p = await ctx.services.projects.create(ctx.actor, ctx.access.workspace, args as never);
            return { text: `Created project ${p.slug}.`, data: p };
        },
    }),
    tool({
        name: "get_project_settings",
        title: "Get project settings",
        description: "A project's name, repository, default branch and automation settings.",
        permission: "configure",
        readOnly: true,
        input: z.object({ project }),
        async run(ctx, args) {
            const p = await projectOf(ctx, args.project);
            const data = { ...publicProject(p), automation: await ctx.services.settings.automation(ctx.services.store, p) };
            return { text: JSON.stringify(data, null, 2), data };
        },
    }),
    tool({
        name: "configure_project",
        title: "Configure project",
        description:
            "Change a project's name, repository address, default branch and/or automation settings. Secrets (GitHub token, webhook secret, model keys) can only be set by a person in the browser.",
        permission: "configure",
        input: z.object({
            project,
            name: z.string().max(80).optional(),
            repoUrl: z.string().max(300).nullable().optional(),
            defaultBranch: z.string().max(200).optional(),
            automation: AutomationSchema.partial().optional(),
        }),
        async run(ctx, args) {
            const p = await projectOf(ctx, args.project);
            const general = Object.fromEntries(
                Object.entries({ name: args.name, repoUrl: args.repoUrl, defaultBranch: args.defaultBranch }).filter(
                    ([, v]) => v !== undefined,
                ),
            );
            // Both changes are saved together, or neither is.
            const data = await ctx.services.store.transaction(async () => {
                const updated = Object.keys(general).length ? await ctx.services.projects.update(ctx.actor, p, general) : publicProject(p);
                const automation = args.automation
                    ? await ctx.services.settings.setAutomation(ctx.actor, p, args.automation as never)
                    : await ctx.services.settings.automation(ctx.services.store, p);
                return { ...updated, automation };
            });
            return { text: "Saved.", data };
        },
    }),
    tool({
        name: "move_branch",
        title: "Move branch",
        description:
            "Move a branch's report and triage to another branch name (e.g. a report uploaded to the wrong branch). The target must have no report.",
        permission: "configure",
        input: z.object({ project, from: z.string().max(200), to: z.string().max(200), makeDefault: z.boolean().optional() }),
        async run(ctx, args) {
            const r = await ctx.services.reports.moveBranch(ctx.actor, await projectOf(ctx, args.project), args as never);
            return { text: `Moved ${r.issues} finding(s) from ${r.from} to ${r.to}.`, data: r };
        },
    }),
    tool({
        name: "delete_branch",
        title: "Delete branch",
        description: "Delete a branch's report and triage (kept in its archive). A branch with unresolved issues needs confirm: true.",
        permission: "configure",
        destructive: true,
        input: z.object({ project, branch: z.string().max(200), confirm: z.boolean().optional() }),
        async run(ctx, args) {
            const r = await ctx.services.reports.deleteBranch(ctx.actor, await projectOf(ctx, args.project), args as never);
            return { text: `Deleted ${r.branch} (${r.issues} findings, ${r.unresolved} unresolved).`, data: r };
        },
    }),

    // ---- reviews ---------------------------------------------------------------------------------
    tool({
        name: "start_review",
        title: "Start review",
        description:
            'Start an Open Code Review run: a pull request (kind "pr" with its number), a branch\'s changes since its base (kind "changes" with branch, and base if not the default branch), or a full scan (kind "full", default branch unless given). Returns the run at once; wait_for_run waits for it to finish.',
        permission: "operate",
        input: z.object({
            project,
            kind: z.enum(["pr", "changes", "full"]),
            number: z.number().int().positive().optional().describe("The pull request (kind pr)"),
            branch: z.string().max(200).optional(),
            base: z.string().max(200).optional(),
        }),
        async run(ctx, args) {
            const p = await projectOf(ctx, args.project);
            const { project: _p, ...input } = args;
            const r = await ctx.services.runs.start(ctx.actor, p, input as never);
            return { text: `Queued run ${r.id}: ${r.title} (branch ${r.branch}). Use wait_for_run with this id to wait for it.`, data: r };
        },
    }),
    tool({
        name: "list_runs",
        title: "List runs",
        description:
            "Queued, running and recent reviews (one project, or the whole workspace), and why reviews are waiting if they can't start.",
        permission: "read",
        readOnly: true,
        input: z.object({ project: project.describe("Only this project's runs (default: all)") }),
        async run(ctx, args) {
            const p = typeof args.project === "string" && args.project ? await projectOf(ctx, args.project) : null;
            const r = await ctx.services.runs.list(ctx.access.workspace, p ? { projectId: p.id } : {});
            const row = (x: (typeof r.recent)[number]) =>
                `- ${x.id} [${x.status}] ${x.project}: ${x.title}${x.result?.total !== undefined && x.result?.total !== null ? `, ${x.result.total} finding(s)` : ""}${x.error ? ` (${x.error})` : ""}`;
            const text = [
                r.waiting ? `Reviews are waiting: ${r.waiting}` : "",
                `Running (${r.running.length}):`,
                ...r.running.map(row),
                `Queued (${r.queued.length}):`,
                ...r.queued.map(row),
                "Recent:",
                ...r.recent.slice(0, 15).map(row),
            ]
                .filter(Boolean)
                .join("\n");
            return { text, data: r };
        },
    }),
    tool({
        name: "get_run",
        title: "Get run",
        description: "One review: status, progress, result, and its log (lines after `after`, a line number).",
        permission: "read",
        readOnly: true,
        input: z.object({ id: z.string().max(40), after: z.number().int().min(0).optional() }),
        async run(ctx, args) {
            const r = await ctx.services.runs.get(ctx.access.workspace, String(args.id), Number(args.after ?? 0));
            const tail = r.logLines.slice(-40).map((l) => l.line);
            return {
                text: `${r.title}: ${r.status}${r.error ? ` (${r.error})` : ""}${r.result?.total !== null && r.result?.total !== undefined ? `, ${r.result.total} finding(s) on ${r.branch}` : ""}.\n\n${tail.join("\n")}`,
                data: r,
            };
        },
    }),
    tool({
        name: "wait_for_run",
        title: "Wait for run",
        description: "Wait until a review finishes (up to 10 minutes), then say how it ended. Call it again if it's still going.",
        permission: "read",
        readOnly: true,
        input: z.object({
            id: z.string().max(40),
            seconds: z.number().int().min(1).max(600).optional().describe("How long to wait (default 600)"),
        }),
        async run(ctx, args) {
            const r = await ctx.services.runs.waitFor(ctx.access.workspace, String(args.id), Number(args.seconds ?? 600));
            const run = r.run;
            return {
                text: r.finished
                    ? `${run.title} ${run.status}${run.error ? `: ${run.error}` : ""}${run.result?.total !== null && run.result?.total !== undefined ? `. ${run.result.total} finding(s) on branch ${run.branch}; use list_issues with that branch.` : "."}`
                    : `${run.title} is still ${run.status}${run.progress?.phase ? ` (${run.progress.phase})` : ""}. Call wait_for_run again.`,
                data: r,
            };
        },
    }),
    tool({
        name: "cancel_run",
        title: "Cancel run",
        description: "Cancel a queued or running review.",
        permission: "operate",
        destructive: true,
        input: z.object({ id: z.string().max(40) }),
        async run(ctx, args) {
            const r = await ctx.services.runs.cancel(ctx.actor, ctx.access.workspace, String(args.id));
            return { text: r.status === "cancelled" ? `Cancelled ${r.title}.` : `Asked ${r.title} to stop; it ends shortly.`, data: r };
        },
    }),
    tool({
        name: "list_pull_requests",
        title: "List pull requests",
        description:
            "A project's open pull requests: whether each head commit has been reviewed, and why the last check did or didn't queue it.",
        permission: "read",
        readOnly: true,
        input: z.object({ project }),
        async run(ctx, args) {
            const r = await ctx.services.automation.pullRequests(await projectOf(ctx, args.project));
            const text = r.connected
                ? r.items
                      .map(
                          (p) =>
                              `- #${p.number} ${p.title} (${p.branch}, ${p.headSha.slice(0, 7)}): ${p.status}${p.lastDecision ? `; last check: ${p.lastDecision.action}, ${p.lastDecision.why}` : ""}`,
                      )
                      .join("\n") || "No open pull requests (as of the last check)."
                : "This project isn't connected to GitHub.";
            return { text, data: r };
        },
    }),
    tool({
        name: "check_pull_requests",
        title: "Check pull requests",
        description: "Ask GitHub about the project's pull requests now, queueing reviews of new commits if automatic reviews are on.",
        permission: "operate",
        input: z.object({ project }),
        async run(ctx, args) {
            const p = await projectOf(ctx, args.project);
            await ctx.services.github.githubFor(p);
            const check = await ctx.services.automation.checkPulls(p);
            const text = check?.error
                ? `Checking failed: ${check.error}`
                : `${check?.openPulls ?? 0} open pull request(s).\n${(check?.decisions ?? []).map((d) => `- #${d.number}: ${d.action} (${d.why})`).join("\n")}`;
            return { text, data: check, ...(check?.error ? { isError: true } : {}) };
        },
    }),
];

export function toolSchema(t: Tool): Record<string, unknown> {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
    return schema;
}
