// Starting, watching and cancelling reviews, and a project's pull requests.

import { z } from "zod";
import { costOf } from "../domain/analytics.ts";
import { json, type Route, route } from "../http/route.ts";
import type { Access } from "../services/accounts.ts";
import { ModelIds, RunOptionsInput } from "../services/settings.ts";
import type { Project } from "../store/types.ts";
import { P, W } from "./common.ts";

const project = (p: Project | null) => p as Project;

export const StartReviewBody = z
    .object({
        kind: z.enum(["pr", "changes", "full"]).describe("A pull request, a branch's changes since its base, or a full scan of a branch"),
        number: z.number().int().positive().optional().describe("The pull request (kind pr)"),
        branch: z.string().max(200).optional().describe("The branch (kind changes; full defaults to the project's default branch)"),
        base: z.string().max(200).optional().describe("What the changes are compared with (kind changes; default: the default branch)"),
        models: ModelIds.optional().describe(
            "The models for this review only: ids of favourite models (see GET …/models), or \"instance\" for the instance's model. Default: the project's models for this kind of review",
        ),
        options: RunOptionsInput.optional().describe(
            "Options for this review, when it has two or more models. Anything left out is off; without `options` at all, the project's own apply (Project settings → Review models)",
        ),
    })
    .strict();

export const runRoutes: Route[] = [
    route({
        method: "POST",
        path: `${P}/reviews`,
        scope: "project",
        permission: "operate",
        tag: "Runs",
        summary: "Start a review: a pull request, a branch's changes, or a full scan",
        description:
            "Checked against GitHub, then queued. A queued review of the same thing is replaced; one of the same commit already queued or running is returned instead. `models` chooses this review's models; without it, the project's set for this kind of review, then the project's set, then the workspace's default.",
        body: StartReviewBody,
        async handler({ services, project: p, body, actor }) {
            return json(await services.runs.start(actor, project(p), body), 201);
        },
    }),
    route({
        method: "GET",
        path: `${W}/models`,
        scope: "workspace",
        permission: "read",
        tag: "Runs",
        summary: "The models reviews can use: the favourites, which is the default, and the instance's model when there's an allowance",
        description:
            "Each says whether it's ready, and if not what it needs. With `project`, `rules` says what each kind of review of that project uses when a run doesn't choose its own.",
        query: z.object({ project: z.string().max(40).optional().describe("Also say what this project's reviews use") }),
        async handler({ services, access, query }) {
            const workspace = (access as Access).workspace;
            const p = query.project ? await services.projects.get(services.store, workspace, query.project) : null;
            return json(await services.models.list(workspace, p));
        },
    }),
    route({
        method: "GET",
        path: `${W}/runs`,
        scope: "workspace",
        permission: "read",
        tag: "Runs",
        summary: "Queued, running and recent reviews, and whether reviews can start (and if not, why)",
        description:
            "`concurrency` is how many reviews may run at once: on the instance, and in this workspace (its own limit if it has one, never more than the instance's). `runnersConnected` says how many runners are connected; their names, versions and slots (`runners`) are listed for instance administrators only.",
        query: z.object({
            project: z.string().max(40).optional().describe("Only this project's"),
            limit: z.string().regex(/^\d+$/).optional().describe("How many recent runs (default 30)"),
        }),
        async handler({ services, access, query, principal }) {
            const workspace = (access as Access).workspace;
            const p = query.project ? await services.projects.get(services.store, workspace, query.project) : null;
            const runnerDetails = principal?.kind === "session" && principal.user.isInstanceAdmin;
            return json(
                await services.runs.list(workspace, { ...(p ? { projectId: p.id } : {}), limit: Number(query.limit) || 30, runnerDetails }),
            );
        },
    }),
    route({
        method: "GET",
        path: `${W}/runs/{runId}`,
        scope: "workspace",
        permission: "read",
        tag: "Runs",
        summary: "One review, with its progress and its log after line `after`",
        query: z.object({ after: z.string().regex(/^\d+$/).optional().describe("The last log line you have (its seq)") }),
        async handler({ services, access, params, query }) {
            return json(await services.runs.get((access as Access).workspace, params.runId as string, Number(query.after) || 0));
        },
    }),
    route({
        method: "POST",
        path: `${W}/runs/{runId}/cancel`,
        scope: "workspace",
        permission: "operate",
        tag: "Runs",
        summary: "Cancel a queued or running review",
        async handler({ services, access, params, actor }) {
            return json(await services.runs.cancel(actor, (access as Access).workspace, params.runId as string));
        },
    }),
    route({
        method: "GET",
        path: `${W}/runs/{runId}/models`,
        scope: "workspace",
        permission: "read",
        tag: "Runs",
        summary: "A finished review's models side by side",
        description:
            "One row for each model the review ran (one, for a review with one): its outcome, `findings`, how many of them no other model found (`unique`), their severities, how many were since resolved (`accepted`) or marked won't fix (`rejected`), its tokens, time and cost in US$ (null without a price for it). `recorded` is false for a review from before who found what was kept, or one run only to compare models: then `unique`, `bySeverity`, `accepted` and `rejected` are null. 409 until it has finished.",
        async handler({ services, access, params }) {
            const workspace = (access as Access).workspace;
            const out = await services.runs.breakdown(workspace, params.runId as string);
            const price = await services.prices.resolver(workspace.id);
            return json({ ...out, models: out.models.map((m) => ({ ...m, cost: costOf(m.tokens, price(m.model, m.provider)) })) });
        },
    }),
    route({
        method: "GET",
        path: `${W}/runs/{runId}/comparison`,
        scope: "workspace",
        permission: "read",
        tag: "Runs",
        summary: "What a review run only to compare its models found (started with options.bakeOff)",
        description:
            "`models`: each model's own findings (`total`, of which `unique` no other found and `shared` another did), by severity, with its tokens, time and cost in US$ (null without a price for it). `overlap[i][j]`: findings models i and j both found. `findings`: the findings once merged, most models agreeing first, each with the models that found it (`foundBy`); at most 500, `truncated` when there were more. 409 until it has finished; 404 for a run that isn't a comparison.",
        async handler({ services, access, params }) {
            const workspace = (access as Access).workspace;
            const { run, comparison } = await services.runs.comparison(workspace, params.runId as string);
            const price = await services.prices.resolver(workspace.id);
            const models = comparison.models.map((m) => ({ ...m, cost: costOf(m.tokens, price(m.model, m.provider)) }));
            return json({ run, ...comparison, models });
        },
    }),
    route({
        method: "POST",
        path: `${W}/runs/{runId}/models/{index}/rerun`,
        scope: "workspace",
        permission: "operate",
        tag: "Runs",
        summary: "Run one model of a finished review again: the one at this place in its models (from 0), which failed or was stopped",
        description:
            "Queues a small review with that model alone, on the commit the review was of, and returns it. When it finishes, its findings are added to the report the review made, and triage on the findings already there is left as it is. Refused (409) when that model finished, is already being run again, or the branch has a newer report by now; if a newer report arrives while it runs, its findings aren't added and its `result.rerun.notAdded` says why. `GET …/runs/{runId}` lists a review's models that can be run again (`rerunnable`) and those that were (`retries`).",
        async handler({ services, access, params, actor }) {
            const index = /^\d{1,2}$/.test(params.index as string) ? Number(params.index) : -1;
            return json(await services.runs.rerun(actor, (access as Access).workspace, params.runId as string, index), 201);
        },
    }),
    route({
        method: "GET",
        path: `${P}/pull-requests`,
        scope: "project",
        permission: "read",
        tag: "Runs",
        summary: "Open pull requests, the state of each in words, and why the last check did or didn't queue a review",
        async handler({ services, project: p }) {
            return json(await services.automation.pullRequests(project(p)));
        },
    }),
    route({
        method: "POST",
        path: `${P}/pull-requests/check`,
        scope: "project",
        permission: "operate",
        tag: "Runs",
        summary: "Check GitHub for pull requests now (and queue reviews, if automatic reviews are on)",
        async handler({ services, project: p }) {
            await services.github.githubFor(project(p));
            await services.automation.checkPulls(project(p), { fresh: true });
            await services.automation.syncBranches(project(p));
            return json(await services.automation.pullRequests(project(p)));
        },
    }),
];
