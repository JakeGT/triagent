// The internal API runners use: claim a job, renew its lease, send its log and progress, finish it.
//
// Only a request carrying the shared runner secret (TRIAGENT_RUNNER_SECRET) is accepted, compared in
// constant time before the body is read; sessions and API tokens never are. The reverse proxy must not
// expose /internal/ to the internet: runners reach the server on a private network.

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { z } from "zod";
import { MAX_MODELS } from "../domain/merge.ts";
import { ApiError, notFound } from "../errors.ts";
import { parseJson } from "../http/mount.ts";
import { type HandlerResult, json, type RequestContext, type Route, route } from "../http/route.ts";
import type { Services } from "../services/index.ts";

const Runner = z.object({
    id: z.string().regex(/^[\w-]{8,64}$/),
    name: z.string().min(1).max(100),
    version: z.string().max(40).nullable().optional(),
    slots: z.number().int().min(0).max(100),
});

const digest = (s: string) => createHash("sha256").update(s).digest();

/** The request carries the runner secret. */
function authorise(c: Context, services: Services): void {
    const secret = services.config.runnerSecret;
    // Without a secret configured the API doesn't exist, as far as anyone can tell.
    if (!secret) throw notFound(`Nothing at ${c.req.method} ${c.req.path}.`);
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    if (!m || !timingSafeEqual(digest(m[1] as string), digest(secret))) throw new ApiError(401, "Runner secret missing or wrong.");
}

/** A runner route: authorised, then its body parsed. */
function internal<B extends z.ZodType>(
    r: { method: "POST"; path: string; summary: string; body: B; bodyLimit?: number },
    handler: (services: Services, body: z.infer<B>, params: Record<string, string>) => Promise<HandlerResult>,
): Route {
    return route({
        method: r.method,
        path: r.path,
        scope: "public",
        tag: "Runner (internal)",
        summary: r.summary,
        description: "For runners only, with the shared runner secret. Not for the public internet.",
        rawBody: true,
        bodyLimit: r.bodyLimit ?? 4 * 1024 * 1024,
        async handler(ctx: RequestContext<undefined, undefined>) {
            authorise(ctx.c, ctx.services);
            const body = r.body.parse(parseJson(await ctx.readRaw(), ctx.c));
            return handler(ctx.services, body, ctx.params);
        },
    });
}

const Job = z.object({ runner: Runner });

export const runnerRoutes: Route[] = [
    internal(
        { method: "POST", path: "/internal/runner/claim", summary: "Take the next job this runner may start, if any", body: Job },
        async (services, body) => json({ job: await services.runs.claim({ ...body.runner, version: body.runner.version ?? null }) }),
    ),
    internal(
        {
            method: "POST",
            path: "/internal/runner/jobs/{jobId}/heartbeat",
            summary: "Renew the job's lease; says whether it has been cancelled",
            body: Job,
        },
        async (services, body, params) =>
            json(await services.runs.heartbeat({ ...body.runner, version: body.runner.version ?? null }, params.jobId as string)),
    ),
    internal(
        {
            method: "POST",
            path: "/internal/runner/jobs/{jobId}/events",
            summary: "Log lines and progress (renews the lease too)",
            body: Job.extend({
                lines: z
                    .array(z.object({ at: z.string().max(40).optional(), line: z.string().max(20_000) }))
                    .max(2000)
                    .optional(),
                progress: z.record(z.string(), z.unknown()).optional(),
            }),
        },
        async (services, body, params) =>
            json(
                await services.runs.events({ ...body.runner, version: body.runner.version ?? null }, params.jobId as string, {
                    ...(body.lines ? { lines: body.lines } : {}),
                    ...(body.progress ? { progress: body.progress } : {}),
                }),
            ),
    ),
    internal(
        {
            method: "POST",
            path: "/internal/runner/jobs/{jobId}/finish",
            summary: "How the job ended, with OCR's report (or each model's, for a review run with several)",
            body: Job.extend({
                status: z.enum(["done", "failed", "cancelled"]),
                report: z.unknown().optional(),
                parts: z
                    .array(
                        z.object({
                            status: z.enum(["done", "failed", "cancelled"]),
                            report: z.unknown().optional(),
                            error: z.string().max(10_000).nullable().optional(),
                            tokens: z.number().min(0).nullable().optional(),
                            seconds: z.number().min(0).nullable().optional(),
                        }),
                    )
                    .max(MAX_MODELS)
                    .optional(),
                error: z.string().max(10_000).nullable().optional(),
                headSha: z.string().max(40).nullable().optional(),
                baseSha: z.string().max(40).nullable().optional(),
            }),
            // A report each, for a review run with several models.
            bodyLimit: MAX_MODELS * 30 * 1024 * 1024,
        },
        async (services, body, params) =>
            json(
                await services.runs.finish({ ...body.runner, version: body.runner.version ?? null }, params.jobId as string, {
                    status: body.status,
                    report: body.report,
                    ...(body.parts ? { parts: body.parts } : {}),
                    error: body.error ?? null,
                    headSha: body.headSha ?? null,
                    baseSha: body.baseSha ?? null,
                }),
            ),
    ),
];
