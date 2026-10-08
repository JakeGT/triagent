// The first-run tutorial: your place in it, and your example project. Yours alone, in the browser only.

import { z } from "zod";
import { forbidden } from "../errors.ts";
import { json, type RequestContext, type Route, route } from "../http/route.ts";
import { TUTORIAL_STATUSES } from "../store/types.ts";

/** The signed-in person, as the actor for their own example's changes. */
function person(ctx: Pick<RequestContext<undefined, undefined>, "principal" | "actor">) {
    if (ctx.principal?.kind !== "session" || !ctx.actor.userId) throw forbidden("Sign in through the browser to use the tutorial.");
    return { ...ctx.actor, userId: ctx.actor.userId };
}

export const tutorialRoutes: Route[] = [
    route({
        method: "GET",
        path: "/api/v1/me/tutorial",
        scope: "user",
        browserOnly: true,
        tag: "Account",
        summary: "Where you are in the first-run tutorial, and your example project",
        async handler(ctx) {
            return json(await ctx.services.tutorial.get(person(ctx).userId));
        },
    }),
    route({
        method: "PATCH",
        path: "/api/v1/me/tutorial",
        scope: "user",
        browserOnly: true,
        tag: "Account",
        summary: "Start, move through, finish or skip the tutorial",
        description: "`status` is pending, in_progress, completed or dismissed; `step` is where to pick it up again.",
        body: z.object({ status: z.enum(TUTORIAL_STATUSES).optional(), step: z.number().int().min(0).max(50).optional() }),
        async handler(ctx) {
            return json(await ctx.services.tutorial.update(person(ctx).userId, ctx.body));
        },
    }),
    route({
        method: "POST",
        path: "/api/v1/me/tutorial/example",
        scope: "user",
        browserOnly: true,
        tag: "Account",
        summary: "Make the example project in your personal workspace (or return the one you have)",
        description:
            "Made-up reports, triage, reviews and finished runs for a small web shop. It never contacts GitHub, starts a review or uses a model.",
        async handler(ctx) {
            return json(await ctx.services.tutorial.createExample(person(ctx)), 201);
        },
    }),
    route({
        method: "DELETE",
        path: "/api/v1/me/tutorial/example",
        scope: "user",
        browserOnly: true,
        tag: "Account",
        summary: "Remove your example project",
        async handler(ctx) {
            return json(await ctx.services.tutorial.removeExample(person(ctx)));
        },
    }),
];
