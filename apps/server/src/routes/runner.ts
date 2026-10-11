// The internal API runners use: claim a job, renew its lease, send its log and progress, finish it.
//
// Only a request carrying the shared runner secret (TRIAGENT_RUNNER_SECRET) is accepted, compared in
// constant time before the body is read; sessions and API tokens never are. The reverse proxy must not
// expose /internal/ to the internet: runners reach the server on a private network.

import { createHash, timingSafeEqual } from "node:crypto";
import { LOG_LEVELS, type LogError, log, relayLog } from "@triagent/shared/log";
import type { Context } from "hono";
import { z } from "zod";
import { MAX_MODELS } from "../domain/merge.ts";
import { ApiError, notFound } from "../errors.ts";
import { parseJson } from "../http/mount.ts";
import { type HandlerResult, json, type RequestContext, type Route, route } from "../http/route.ts";
import type { Services } from "../services/index.ts";
import type { RunnerHello } from "../services/runs.ts";

const Runner = z.object({
    id: z.string().regex(/^[\w-]{8,64}$/),
    name: z.string().min(1).max(100),
    version: z.string().max(40).nullable().optional(),
    slots: z.number().int().min(0).max(100),
    // How many jobs it works on at once in all (`slots` is how many more it can take). Older runners don't say.
    capacity: z.number().int().min(1).max(100).nullable().optional(),
    // Finishing what it has before stopping, and taking no more. Older runners never do, so never say.
    draining: z.boolean().optional(),
});

/** The runner as the services know it. */
const hello = (r: z.infer<typeof Runner>): RunnerHello => ({
    id: r.id,
    name: r.name,
    version: r.version ?? null,
    slots: r.slots,
    ...(typeof r.capacity === "number" ? { capacity: r.capacity } : {}),
    ...(r.draining ? { draining: true } : {}),
});

const digest = (s: string) => createHash("sha256").update(s).digest();

/** A wrong secret is a runner set up wrongly, or someone trying the door: said once a minute at most, however often it's tried. */
let refusedAt = 0;

/** The request carries the runner secret. */
function authorise(c: Context, services: Services, ip: string): void {
    const secret = services.config.runnerSecret;
    // Without a secret configured the API doesn't exist, as far as anyone can tell.
    if (!secret) throw notFound(`Nothing at ${c.req.method} ${c.req.path}.`);
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    if (!m || !timingSafeEqual(digest(m[1] as string), digest(secret))) {
        if (Date.now() - refusedAt > 60_000) {
            refusedAt = Date.now();
            log.warn("A runner was refused: its secret is missing or wrong", { ip });
        }
        throw new ApiError(401, "Runner secret missing or wrong.");
    }
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
            authorise(ctx.c, ctx.services, ctx.ip);
            const body = r.body.parse(parseJson(await ctx.readRaw(), ctx.c));
            return handler(ctx.services, body, ctx.params);
        },
    });
}

const Job = z.object({ runner: Runner });

/** An error as a runner wrote it down (packages/shared/src/log.ts), with what caused it, a few deep at most. */
const ErrorShape = z.object({
    name: z.string().max(200),
    message: z.string().max(4000),
    stack: z.string().max(12_000).optional(),
    code: z.string().max(80).optional(),
});
const RunnerError = ErrorShape.extend({ cause: ErrorShape.extend({ cause: ErrorShape.optional() }).optional() });

const RunnerLine = z.object({
    time: z.string().max(40),
    level: z.enum(LOG_LEVELS as [string, ...string[]]),
    msg: z.string().max(4000),
    fields: z.record(z.string().max(80), z.union([z.string().max(4000), z.number(), z.boolean(), z.null()])),
    error: RunnerError.optional(),
});

export const runnerRoutes: Route[] = [
    internal(
        {
            method: "POST",
            path: "/internal/runner/log",
            summary: "The runner's own log lines (never a review's), for the server's error tracker; says whether they're wanted",
            body: Job.extend({ records: z.array(RunnerLine).max(200) }),
            bodyLimit: 1024 * 1024,
        },
        async (services, body) => {
            // Without an error tracker there's nowhere for them to go: the runner printed them itself, and stops sending.
            if (!services.config.telemetry) return json({ wanted: false });
            for (const r of body.records)
                relayLog(
                    {
                        time: r.time,
                        level: r.level as (typeof LOG_LEVELS)[number],
                        msg: r.msg,
                        fields: r.fields,
                        ...(r.error ? { error: r.error as LogError } : {}),
                    },
                    // Last, so a runner can't pass its lines off as the server's.
                    { service: "runner", runner: body.runner.name },
                );
            return json({ wanted: true });
        },
    ),
    internal(
        { method: "POST", path: "/internal/runner/claim", summary: "Take the next job this runner may start, if any", body: Job },
        async (services, body) => json({ job: await services.runs.claim(hello(body.runner)) }),
    ),
    internal(
        {
            method: "POST",
            path: "/internal/runner/jobs/{jobId}/heartbeat",
            summary: "Renew the job's lease; says whether it has been cancelled, and which of its models to stop",
            body: Job,
        },
        async (services, body, params) => json(await services.runs.heartbeat(hello(body.runner), params.jobId as string)),
    ),
    internal(
        {
            method: "POST",
            path: "/internal/runner/jobs/{jobId}/events",
            summary: "Log lines and progress (renews the lease too); says whether it has been cancelled, and which of its models to stop",
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
                await services.runs.events(hello(body.runner), params.jobId as string, {
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
                            reason: z.enum(["stalled", "timeLimit", "overBudget"]).nullable().optional(),
                        }),
                    )
                    .max(MAX_MODELS)
                    .optional(),
                // What a model said about pairs of findings: checked where it's used (a bad one never loses the review).
                judged: z.unknown().optional(),
                error: z.string().max(10_000).nullable().optional(),
                headSha: z.string().max(40).nullable().optional(),
                baseSha: z.string().max(40).nullable().optional(),
            }),
            // A report each, for a review run with several models.
            bodyLimit: MAX_MODELS * 30 * 1024 * 1024,
        },
        async (services, body, params) =>
            json(
                await services.runs.finish(hello(body.runner), params.jobId as string, {
                    status: body.status,
                    report: body.report,
                    ...(body.parts ? { parts: body.parts } : {}),
                    ...(body.judged !== undefined ? { judged: body.judged } : {}),
                    error: body.error ?? null,
                    headSha: body.headSha ?? null,
                    baseSha: body.baseSha ?? null,
                }),
            ),
    ),
];
