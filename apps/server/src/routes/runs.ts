// Starting, watching and cancelling reviews, and a project's pull requests.

import { z } from "zod";
import { json, type Route, route } from "../http/route.ts";
import type { Access } from "../services/accounts.ts";
import { ModelIds } from "../services/settings.ts";
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
            "`runnersConnected` says how many runners are connected; their names and versions (`runners`) are listed for instance administrators only.",
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
