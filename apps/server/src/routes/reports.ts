// Reports and branches: uploading, comparing, moving and deleting, plus each branch's overview, files,
// summary and activity.

import { z } from "zod";
import { overviewMarkdown } from "../domain/markdown.ts";
import { ApiError } from "../errors.ts";
import { json, markdown, type Route, route } from "../http/route.ts";
import type { Project } from "../store/types.ts";
import { BranchQuery, P, PagingQuery, pageOf } from "./common.ts";

const project = (p: Project | null) => p as Project;
const REPORT_LIMIT = 25 * 1024 * 1024;

const UploadBody = z.object({
    branch: z.string().max(200).optional(),
    commit: z.string().max(40).optional(),
    fileName: z.string().max(200).optional(),
    report: z.unknown().describe("The JSON report Open Code Review wrote"),
    confirm: z.boolean().optional().describe("Replace a report that still has unresolved issues"),
    reopen: z.boolean().optional().describe("Reopen resolved findings the report still contains (default true)"),
    scope: z.enum(["full", "diff"]).optional().describe("\"diff\" for a review of only a pull request's or branch's changes"),
});

export const reportRoutes: Route[] = [
    route({
        method: "GET",
        path: `${P}/branches`,
        scope: "project",
        permission: "read",
        tag: "Branches",
        summary: "Branches with a report, default first",
        async handler({ services, project: p }) {
            return json(await services.reports.branches(project(p)));
        },
    }),
    route({
        method: "POST",
        path: `${P}/branches/move`,
        scope: "project",
        permission: "configure",
        tag: "Branches",
        summary: "Move a branch's report and triage to another branch name",
        body: z.object({ from: z.string().max(200), to: z.string().max(200), makeDefault: z.boolean().optional() }),
        async handler({ services, project: p, body, actor }) {
            return json(await services.reports.moveBranch(actor, project(p), body));
        },
    }),
    route({
        method: "POST",
        path: `${P}/branches/delete`,
        scope: "project",
        permission: "configure",
        tag: "Branches",
        summary: "Delete a branch's report and triage (archived). Unresolved issues need confirm",
        body: z.object({ branch: z.string().max(200), confirm: z.boolean().optional() }),
        async handler({ services, project: p, body, actor }) {
            return json(await services.reports.deleteBranch(actor, project(p), body));
        },
    }),
    route({
        method: "GET",
        path: `${P}/compare`,
        scope: "project",
        permission: "read",
        tag: "Branches",
        summary: "Findings a branch adds, and those it no longer has, compared with another (default: the default branch)",
        query: z.object({ head: z.string().max(200), base: z.string().max(200).optional() }),
        async handler({ services, project: p, query }) {
            const proj = project(p);
            return json(
                await services.reports.compare(
                    proj,
                    services.reports.branchOf(proj, query.base),
                    services.reports.branchOf(proj, query.head),
                ),
            );
        },
    }),

    // ---- reports -----------------------------------------------------------------------------
    route({
        method: "GET",
        path: `${P}/reports`,
        scope: "project",
        permission: "read",
        tag: "Reports",
        summary: "A branch's current report and its archived predecessors",
        query: BranchQuery,
        async handler({ services, project: p, query }) {
            const proj = project(p);
            return json(await services.reports.history(proj, services.reports.branchOf(proj, query.branch)));
        },
    }),
    route({
        method: "POST",
        path: `${P}/reports`,
        scope: "project",
        permission: "upload",
        tag: "Reports",
        summary: "Upload a report to a branch",
        description:
            "Findings still in the new report keep their triage; resolved ones it still contains are reopened. A branch with unresolved issues is only replaced with `confirm: true` (409 otherwise, with what the upload would do).",
        body: UploadBody,
        bodyLimit: REPORT_LIMIT,
        async handler({ services, project: p, body, actor }) {
            return json(await services.reports.upload(actor, project(p), body));
        },
    }),
    route({
        method: "POST",
        path: `${P}/reports/preview`,
        scope: "project",
        permission: "upload",
        tag: "Reports",
        summary: "What uploading a report would change, without changing anything",
        body: UploadBody,
        bodyLimit: REPORT_LIMIT,
        async handler({ services, project: p, body, actor }) {
            return json(await services.reports.upload(actor, project(p), body, { preview: true }));
        },
    }),
    route({
        method: "POST",
        path: `${P}/upload-links`,
        scope: "project",
        permission: "upload",
        tag: "Reports",
        summary: "A single-use link (15 minutes) that accepts one raw OCR JSON file, with no other credential",
        body: z.object({
            branch: z.string().max(200).optional(),
            commit: z.string().max(40).optional(),
            fileName: z.string().max(200).optional(),
            confirm: z.boolean().optional(),
            reopen: z.boolean().optional(),
        }),
        async handler({ services, project: p, body, actor }) {
            return json(await services.reports.createLink(actor, project(p), body), 201);
        },
    }),
    route({
        method: "POST",
        path: "/api/v1/uploads/{token}",
        scope: "public",
        tag: "Reports",
        summary: "Use an upload link: send the OCR JSON file as the body",
        rawBody: true,
        bodyLimit: REPORT_LIMIT,
        async handler({ services, params, raw }) {
            let report: unknown;
            try {
                report = JSON.parse((raw as Buffer).toString("utf8"));
            } catch {
                throw new ApiError(400, "The file isn't valid JSON. Send the JSON file Open Code Review wrote.");
            }
            const token = params.token as string;
            const out = /^[\w-]{20,64}$/.test(token) ? await services.reports.redeemLink(token, report) : null;
            if (!out) throw new ApiError(410, "This upload link has expired or was already used. Ask for a new one.");
            return json(out);
        },
    }),

    // ---- one branch ---------------------------------------------------------------------------
    route({
        method: "GET",
        path: `${P}/overview`,
        scope: "project",
        permission: "read",
        tag: "Branches",
        summary: "A branch at a glance: progress, severity, themes, hotspots",
        query: BranchQuery,
        async handler({ services, project: p, query }) {
            const proj = project(p);
            return json(await services.reports.overview(proj, services.reports.branchOf(proj, query.branch)));
        },
    }),
    route({
        method: "GET",
        path: `${P}/overview.md`,
        scope: "project",
        permission: "read",
        tag: "Branches",
        summary: "The overview as Markdown",
        query: BranchQuery,
        produces: "markdown",
        async handler({ services, project: p, query }) {
            const proj = project(p);
            const view = await services.reports.view(services.store, proj, services.reports.branchOf(proj, query.branch));
            return markdown(overviewMarkdown(view, `${proj.name}, branch ${view.branch}`));
        },
    }),
    route({
        method: "GET",
        path: `${P}/files`,
        scope: "project",
        permission: "read",
        tag: "Branches",
        summary: "Files with findings, most open (weighted by severity) first",
        query: BranchQuery.extend({ prefix: z.string().max(500).optional(), limit: z.string().regex(/^\d+$/).optional() }),
        async handler({ services, project: p, query }) {
            const proj = project(p);
            const view = await services.reports.view(services.store, proj, services.reports.branchOf(proj, query.branch));
            return json(view.listFiles({ prefix: query.prefix ?? "", limit: Math.min(Math.max(Number(query.limit) || 1000, 1), 1000) }));
        },
    }),
    route({
        method: "GET",
        path: `${P}/summary`,
        scope: "project",
        permission: "read",
        tag: "Branches",
        summary: "The reviewer's summary (Markdown) and its sections",
        query: BranchQuery,
        async handler({ services, project: p, query }) {
            const proj = project(p);
            const view = await services.reports.view(services.store, proj, services.reports.branchOf(proj, query.branch));
            return json({ markdown: view.review.summaryMarkdown, sections: view.review.sections });
        },
    }),
    route({
        method: "GET",
        path: `${P}/activity`,
        scope: "project",
        permission: "read",
        tag: "Activity",
        summary: "Recent changes to the project (one branch, or all), newest first",
        query: PagingQuery.extend({ branch: z.string().max(200).optional() }),
        async handler({ services, project: p, query }) {
            const page = pageOf(query);
            return json({ items: await services.reports.activity(project(p), query.branch ?? null, page.limit, page.before) });
        },
    }),
];
