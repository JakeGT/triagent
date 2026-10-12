// A project's common issues (services/patterns.ts): the kinds of problem reviews keep finding there, with
// what's under each on a branch; asking the analysis model to group a branch's findings; people's own
// changes; likely false positives; and where findings came from (services/origins.ts).

import { CATEGORIES } from "@triagent/shared";
import { z } from "zod";
import { MAX_GUIDANCE, MAX_SUMMARY, MAX_TITLE } from "../domain/patterns.ts";
import { json, type Route, route } from "../http/route.ts";
import type { Access } from "../services/accounts.ts";
import { ORIGIN_LEVELS } from "../services/origins.ts";
import type { Project } from "../store/types.ts";
import { BranchQuery, P, W } from "./common.ts";

const workspace = (access: Access | null) => (access as Access).workspace;
const project = (p: Project | null) => p as Project;

const Fields = {
    title: z.string().max(MAX_TITLE).optional(),
    summary: z.string().max(MAX_SUMMARY).optional().describe("What goes wrong"),
    guidance: z.string().max(MAX_GUIDANCE).optional().describe("How to avoid it when writing code here"),
    category: z.enum(CATEGORIES).nullable().optional(),
};

export const patternRoutes: Route[] = [
    route({
        method: "GET",
        path: `${P}/patterns`,
        scope: "project",
        permission: "read",
        tag: "Common issues",
        summary: "A project's common issues, each with what's under it on a branch",
        description:
            "The kinds of problem reviews keep finding in the project: `summary` says what goes wrong, `guidance` how to avoid it. `open` counts its findings still open on the branch, `total` all it has had on any branch; `examples` are a few of the open ones. `ungrouped` is how many open findings on the branch are under none yet, and `grouping` the last time a model was asked to group them (running, done or failed).",
        query: BranchQuery,
        async handler({ services, access, project: p, query }) {
            const proj = project(p);
            return json(await services.patterns.list(workspace(access), proj, services.reports.branchOf(proj, query.branch)));
        },
    }),
    route({
        method: "POST",
        path: `${P}/patterns/group`,
        scope: "project",
        permission: "triage",
        tag: "Common issues",
        summary: "Ask the workspace's analysis model to group a branch's open findings into common issues",
        description:
            "Only findings under no common issue yet are put to it (at most 600 in one go, the most urgent first), under the existing common issues where they fit and new ones where two or more share a cause. It's sent titles and places, never code. Returns the analysis, which is `running` until it's done: read `GET …/patterns` again for how it went. 409 when there's nothing to group or no model is chosen.",
        query: BranchQuery,
        async handler({ services, access, project: p, query, actor }) {
            const proj = project(p);
            return json(await services.patterns.group(actor, workspace(access), proj, services.reports.branchOf(proj, query.branch)), 202);
        },
    }),
    route({
        method: "POST",
        path: `${P}/patterns`,
        scope: "project",
        permission: "triage",
        tag: "Common issues",
        summary: "Add a common issue by hand",
        body: z.object({ ...Fields, title: z.string().min(1).max(MAX_TITLE) }).strict(),
        async handler({ services, access, project: p, body, actor }) {
            return json(await services.patterns.create(actor, workspace(access), project(p), body), 201);
        },
    }),
    route({
        method: "PATCH",
        path: `${P}/patterns/{patternId}`,
        scope: "project",
        permission: "triage",
        tag: "Common issues",
        summary: "Change a common issue's title, what goes wrong, how to avoid it or its category; or hide it",
        description: "A hidden one is left out of what agents are told, and listed last on the page. Its findings stay under it.",
        body: z.object({ ...Fields, hidden: z.boolean().optional() }).strict(),
        async handler({ services, project: p, params, body, actor }) {
            return json(await services.patterns.update(actor, project(p), params.patternId as string, body));
        },
    }),
    route({
        method: "POST",
        path: `${P}/patterns/{patternId}/merge`,
        scope: "project",
        permission: "triage",
        tag: "Common issues",
        summary: "Put everything under this common issue under another, and delete this one",
        body: z.object({ into: z.string().max(40) }).strict(),
        async handler({ services, project: p, params, body, actor }) {
            return json(await services.patterns.merge(actor, project(p), params.patternId as string, body.into));
        },
    }),
    route({
        method: "DELETE",
        path: `${P}/patterns/{patternId}`,
        scope: "project",
        permission: "triage",
        tag: "Common issues",
        summary: "Delete a common issue. Its findings are under none again",
        async handler({ services, project: p, params, actor }) {
            await services.patterns.remove(actor, project(p), params.patternId as string);
            return json({ ok: true });
        },
    }),
    route({
        method: "GET",
        path: `${P}/false-positives`,
        scope: "project",
        permission: "read",
        tag: "Common issues",
        summary: "The open findings a model last thought the team would dismiss, going by what it has dismissed before",
        description:
            "Suggestions only: nothing is closed. `items` are the suggestions still open, each with the dismissed finding it's like (`like`, with the reason that was given) and `why`. `dismissed` is how many findings the project has dismissed with a reason; under `enough`, the suggestions are guesses and `analysis.result.warning` says so.",
        query: BranchQuery,
        async handler({ services, access, project: p, query }) {
            const proj = project(p);
            return json(await services.patterns.falsePositives(workspace(access), proj, services.reports.branchOf(proj, query.branch)));
        },
    }),
    route({
        method: "POST",
        path: `${P}/false-positives`,
        scope: "project",
        permission: "triage",
        tag: "Common issues",
        summary: "Ask the workspace's analysis model which of a branch's open findings look like ones the team has dismissed",
        description:
            "It's given up to 40 findings marked won't fix with a note (the note is the reason) and up to 300 open findings: those only one model found first. Never code. 409 when nothing has been dismissed with a reason yet. Returns the analysis, `running` until it's done.",
        query: BranchQuery,
        async handler({ services, access, project: p, query, actor }) {
            const proj = project(p);
            return json(
                await services.patterns.findFalsePositives(actor, workspace(access), proj, services.reports.branchOf(proj, query.branch)),
                202,
            );
        },
    }),
    // ---- where findings came from ---------------------------------------------------------------
    route({
        method: "GET",
        path: `${W}/settings/origins`,
        scope: "workspace",
        permission: "read",
        tag: "Settings",
        summary: "Whether this workspace traces findings to the commits behind them, and whether it shows a leaderboard of authors",
        async handler({ services, access }) {
            return json({ level: await services.origins.level(services.store, workspace(access).id), levels: ORIGIN_LEVELS });
        },
    }),
    route({
        method: "PUT",
        path: `${W}/settings/origins`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Turn tracing findings to commits off or on, or on with the authors leaderboard",
        description:
            "`off`: nothing is asked of GitHub, and what was traced is deleted. `on`: each finding's commit, the age of the code and the pull request it came in by, and a suggested assignee. `leaderboard`: also findings counted by author, for everyone in the workspace.",
        body: z.object({ level: z.enum(ORIGIN_LEVELS) }).strict(),
        async handler({ services, access, body, actor }) {
            return json(await services.origins.save(actor, workspace(access), body.level));
        },
    }),
    route({
        method: "GET",
        path: `${P}/origins`,
        scope: "project",
        permission: "read",
        tag: "Common issues",
        summary:
            "Where a branch's findings came from: the age of the code behind them, the pull requests, and (if the workspace shows it) the authors",
        description:
            "From Git blame at the report's commit: the newest commit to change a finding's lines. `age` counts the open findings by how old that code is, `pulls` the pull requests behind the most. `authors` is null unless the workspace's level is `leaderboard`. `scan` is the last tracing (running, done or failed); `stale` when the report has moved on since. Blame names whoever last changed a line, which isn't always who wrote the problem.",
        query: BranchQuery,
        async handler({ services, access, project: p, query }) {
            const proj = project(p);
            return json(await services.origins.summary(workspace(access), proj, services.reports.branchOf(proj, query.branch)));
        },
    }),
    route({
        method: "POST",
        path: `${P}/origins`,
        scope: "project",
        permission: "triage",
        tag: "Common issues",
        summary: "Trace a branch's findings to the commits behind them, by asking GitHub for the blame of each file",
        description:
            "Happens by itself after each review once the workspace turns it on. Returns the scan, `running` until it's done. 409 when the workspace hasn't turned it on, the project isn't connected to GitHub, or the report doesn't say which commit it's of.",
        query: BranchQuery,
        async handler({ services, access, project: p, query }) {
            const proj = project(p);
            const scan = await services.origins.trace(workspace(access), proj, services.reports.branchOf(proj, query.branch));
            return json({ ...scan, lines: undefined, authors: undefined }, 202);
        },
    }),
];
