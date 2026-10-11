import { CATEGORIES, ISSUE_SORTS, ROLES, SEVERITIES, STATUSES, TOKEN_SCOPES } from "@triagent/shared";
import { z } from "zod";
import { MAX_ID } from "../domain/filters.ts";
import type { RequestContext } from "../http/route.ts";
import type { BranchRef } from "../services/triage.ts";
import type { Project } from "../store/types.ts";

export const BranchQuery = z.object({
    branch: z.string().max(200).optional().describe("Git branch. Default: the project's default branch."),
});

/** Issue filters. Lists can be comma-separated or repeated. */
export const IssueQuery = BranchQuery.extend({
    severity: z
        .string()
        .optional()
        .describe(`Comma-separated: ${SEVERITIES.join(", ")}`),
    category: z
        .string()
        .optional()
        .describe(`Comma-separated: ${CATEGORIES.join(", ")}`),
    status: z
        .string()
        .optional()
        .describe(`Comma-separated: ${STATUSES.join(", ")}`),
    path: z.string().optional().describe("A file, or a folder ending in /"),
    q: z.string().optional().describe("Words that must all appear in the finding"),
    task: z.string().optional().describe("Only issues linked to this task"),
    assignee: z.string().optional().describe('A name, or "none" for unassigned'),
    hasSuggestion: z.enum(["true", "false"]).optional(),
    needsDiscussion: z.enum(["true", "false"]).optional(),
    duplicates: z.enum(["true", "false"]).optional(),
    adjusted: z.enum(["true", "false"]).optional().describe("Only issues whose rating someone corrected"),
    foundBy: z.string().regex(/^\d+$/).optional().describe("Only findings at least this many models found (reviews run with several)"),
    model: z.string().max(200).optional().describe("Only findings this model found, by its name in the review (the list's `models`)"),
    onlyModel: z.enum(["true", "false"]).optional().describe("With `model`: only findings no other model found"),
    lowerConfidence: z
        .enum(["true", "false"])
        .optional()
        .describe("Only findings marked as lower confidence (one model found them, and the review asked for that), or only the others"),
    ids: z.string().optional().describe("Comma-separated issue ids"),
    sort: z.enum(ISSUE_SORTS).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
    offset: z.string().regex(/^\d+$/).optional(),
});

export const PagingQuery = z.object({
    limit: z.string().regex(/^\d+$/).optional(),
    before: z.string().max(64).optional().describe("Continue after the row with this id"),
});

export const pageOf = (q: { limit?: string | undefined; before?: string | undefined } | undefined, fallback = 100, max = 500) => ({
    limit: Math.min(Math.max(Number(q?.limit) || fallback, 1), max),
    ...(q?.before ? { before: q.before } : {}),
});

export const IssuePatch = z
    .object({
        status: z.enum(STATUSES).optional(),
        assignee: z.string().max(64).nullable().optional(),
        severity: z
            .union([z.enum(SEVERITIES), z.literal("reviewer"), z.null()])
            .optional()
            .describe('"reviewer" or null puts back the reviewer\'s rating'),
        category: z.union([z.enum(CATEGORIES), z.literal("reviewer"), z.null()]).optional(),
        duplicateOf: z.string().max(MAX_ID).nullable().optional(),
        needsDiscussion: z.boolean().optional(),
        note: z.string().max(4000).optional(),
        rev: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("The revision you loaded: a stale one is refused with 409 and the current version"),
    })
    .strict();

export const Finding = z.object({
    path: z.string().max(500),
    content: z.string().max(8000),
    severity: z.enum(SEVERITIES).optional(),
    category: z.enum(CATEGORIES).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    existingCode: z.string().max(20_000).optional(),
    suggestionCode: z.string().max(20_000).optional(),
});

export const RoleSchema = z.enum(ROLES);
export const ScopeSchema = z.enum(TOKEN_SCOPES);

/** The project and branch a request is about. */
export function branchRef(ctx: RequestContext<z.ZodType | undefined, z.ZodType | undefined>, branch: unknown): BranchRef {
    const project = ctx.project as Project;
    return { project, branch: ctx.services.reports.branchOf(project, branch) };
}

export function queryParams(ctx: { c: { req: { url: string } } }): URLSearchParams {
    return new URL(ctx.c.req.url).searchParams;
}

export const W = "/api/v1/w/{workspace}";
export const P = `${W}/p/{project}`;
