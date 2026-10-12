// What a model has been asked to write about reviews and findings (services/analyst.ts): which model a
// workspace has chosen for it, a review's written comparison and summary, and questions about the analytics.
// Asking spends the workspace's model tokens, so it needs the right to triage; choosing the model is a setting.

import { z } from "zod";
import { MAX_QUESTION } from "../domain/analyst.ts";
import { ANALYTICS_DAYS } from "../domain/analytics.ts";
import { json, type Route, route } from "../http/route.ts";
import type { Access } from "../services/accounts.ts";
import type { Project } from "../store/types.ts";
import { BranchQuery, P, W } from "./common.ts";
import { daysOf } from "./insights.ts";

const workspace = (access: Access | null) => (access as Access).workspace;

const WRITTEN =
    "An analysis is `running` until the model has answered, then `done` with `result` (its `markdown`, and a `warning` when there was little to go on) or `failed` with `error`. Ask for it again by its id until it isn't running.";

export const analysisRoutes: Route[] = [
    route({
        method: "GET",
        path: `${W}/settings/analysis`,
        scope: "workspace",
        permission: "read",
        tag: "Settings",
        summary: "The model this workspace asks to write analyses, whether it can be asked now, and what's written without being asked",
        async handler({ services, access }) {
            return json(await services.analyst.view(workspace(access)));
        },
    }),
    route({
        method: "PUT",
        path: `${W}/settings/analysis`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Choose the model for analyses (one of the workspace's models, by id; null for none) and what's written after each review",
        body: z
            .object({
                model: z.string().max(40).nullable().optional(),
                afterReview: z.object({ comparison: z.boolean().optional(), summary: z.boolean().optional() }).strict().optional(),
            })
            .strict(),
        async handler({ services, access, body, actor }) {
            return json(
                await services.analyst.save(actor, workspace(access), {
                    ...(body.model !== undefined ? { model: body.model } : {}),
                    ...(body.afterReview
                        ? {
                              afterReview: {
                                  ...(body.afterReview.comparison !== undefined ? { comparison: body.afterReview.comparison } : {}),
                                  ...(body.afterReview.summary !== undefined ? { summary: body.afterReview.summary } : {}),
                              },
                          }
                        : {}),
                }),
            );
        },
    }),
    route({
        method: "GET",
        path: `${W}/runs/{runId}/analysis`,
        scope: "workspace",
        permission: "read",
        tag: "Analysis",
        summary: "What's been written about a review: a comparison of its models, and a summary of what it changed",
        description: `Each is the latest written, or null. \`unavailable\` says why one can't be written for this review (null when it can). ${WRITTEN}`,
        async handler({ services, access, params }) {
            return json(await services.analyst.forRun(workspace(access), params.runId as string));
        },
    }),
    route({
        method: "POST",
        path: `${W}/runs/{runId}/analysis`,
        scope: "workspace",
        permission: "triage",
        tag: "Analysis",
        summary: "Ask the workspace's analysis model to write a comparison of a review's models, or a summary of what it changed",
        description: `The model is sent figures and findings' titles and places, never code. 409 when no model is chosen or it can't be written for this review; 429 past the workspace's hourly limit. One already being written is returned as it is. ${WRITTEN}`,
        body: z.object({ kind: z.enum(["comparison", "summary"]) }).strict(),
        async handler({ services, access, params, body, actor }) {
            const ws = workspace(access);
            const id = params.runId as string;
            return json(
                body.kind === "comparison"
                    ? await services.analyst.writeComparison(actor, ws, id)
                    : await services.analyst.writeSummary(actor, ws, id),
                202,
            );
        },
    }),
    route({
        method: "GET",
        path: `${P}/analysis`,
        scope: "project",
        permission: "read",
        tag: "Analysis",
        summary:
            "A branch's latest review that can be summarised, and its latest that can be compared, with what's been written about each",
        query: BranchQuery,
        async handler({ services, access, project, query }) {
            const p = project as Project;
            return json(await services.analyst.forBranch(workspace(access), p, services.reports.branchOf(p, query.branch)));
        },
    }),
    route({
        method: "POST",
        path: `${W}/ask`,
        scope: "workspace",
        permission: "triage",
        tag: "Analysis",
        summary: "Ask a question about the workspace's reviews and findings, answered by its analysis model from the analytics",
        description: `The model is given the analytics for the scope as text, and may look at up to three issue lists (\`result.lookups\` says which) before it answers. It never sees code. \`result.warning\` is set when the scope has few reviews or findings to go on. ${WRITTEN}`,
        body: z
            .object({
                question: z.string().min(1).max(MAX_QUESTION),
                project: z.string().max(40).optional().describe("A project's slug; leave out for every project"),
                branch: z.string().max(200).optional(),
                days: z
                    .number()
                    .int()
                    .refine((d) => (ANALYTICS_DAYS as readonly number[]).includes(d), "Use 7, 30, 90, 365 or 0 (all time).")
                    .optional(),
            })
            .strict(),
        async handler({ services, access, body, actor }) {
            return json(
                await services.analyst.ask(actor, workspace(access), {
                    question: body.question,
                    project: body.project || undefined,
                    branch: body.project ? body.branch || undefined : undefined,
                    days: daysOf(body.days === undefined ? undefined : String(body.days)),
                }),
                202,
            );
        },
    }),
    route({
        method: "GET",
        path: `${W}/analyses/{analysisId}`,
        scope: "workspace",
        permission: "read",
        tag: "Analysis",
        summary: "One analysis, by id",
        description: WRITTEN,
        async handler({ services, access, params }) {
            return json(await services.analyst.get(workspace(access), params.analysisId as string));
        },
    }),
];
