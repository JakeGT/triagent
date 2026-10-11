// Analytics, model prices, the OpenRouter catalogue and the workspace's view of its instance-key
// allowance. Instance-wide prices, the instance key and allowances are under /api/v1/instance (routes/instance-models.ts).

import { z } from "zod";
import { ANALYTICS_DAYS, ANALYTICS_SECTIONS, type AnalyticsDays, type AnalyticsSection } from "../domain/analytics.ts";
import { json, type Route, route } from "../http/route.ts";
import type { Access } from "../services/accounts.ts";
import type { Services } from "../services/index.ts";
import type { Workspace } from "../store/types.ts";
import { W } from "./common.ts";

export const AnalyticsQuery = z.object({
    project: z
        .string()
        .max(40)
        .optional()
        .describe("A project's slug, as in its address (/p/{project}); empty for every project in the workspace"),
    branch: z.string().max(200).optional().describe("One branch; empty for every branch"),
    days: z
        .enum(ANALYTICS_DAYS.map(String) as [string, ...string[]])
        .optional()
        .describe("The range in days: 7, 30 (default), 90, 365, or 0 for all time"),
    sections: z
        .string()
        .max(80)
        .regex(new RegExp(`^(${ANALYTICS_SECTIONS.join("|")})(,(${ANALYTICS_SECTIONS.join("|")}))*$`))
        .optional()
        .describe(`Only these parts, separated by commas: ${ANALYTICS_SECTIONS.join(", ")}. Default: all of them.`),
});

export const PriceBody = z.object({
    model: z.string().max(150),
    input: z.number().describe("US$ per million input tokens"),
    output: z.number().describe("US$ per million output tokens"),
    cacheRead: z.number().nullable().optional().describe("US$ per million cache-read tokens (default: the input price)"),
});

export const ModelBody = z.object({ model: z.string().max(150) });

export const daysOf = (v: string | undefined): AnalyticsDays => (v === undefined ? 30 : (Number(v) as AnalyticsDays));

/** The models a workspace's reviews used, with what each costs there (or null: no price). */
export async function usedModels(services: Services, workspace: Workspace) {
    const price = await services.prices.resolver(workspace.id);
    const used = new Map<string, { model: string; reviews: number; tokens: number }>();
    for (const r of await services.store.reviewHistory.list({ workspaceId: workspace.id }, 5000)) {
        if (!r.model) continue;
        const u = used.get(r.model) ?? { model: r.model, reviews: 0, tokens: 0 };
        u.reviews++;
        u.tokens += r.tokens?.total ?? 0;
        used.set(r.model, u);
    }
    return [...used.values()].sort((a, b) => b.tokens - a.tokens).map((u) => ({ ...u, price: price(u.model) }));
}

export const insightRoutes: Route[] = [
    route({
        method: "GET",
        path: `${W}/analytics`,
        scope: "workspace",
        permission: "read",
        tag: "Analytics",
        summary: "Reviews, findings, triage throughput and model performance over a range",
        description:
            "Computed from the review history, the activity log and the current reports. Costs use the workspace's model prices (or the instance's, or OpenRouter's listed price); models without a price are listed in `unpriced` and left out of costs.",
        query: AnalyticsQuery,
        async handler({ services, access, query }) {
            return json(
                await services.analytics.compute((access as Access).workspace, {
                    project: query.project || undefined,
                    branch: query.branch || undefined,
                    days: daysOf(query.days),
                    sections: query.sections ? (query.sections.split(",") as AnalyticsSection[]) : undefined,
                }),
            );
        },
    }),
    route({
        method: "GET",
        path: `${W}/models/catalogue`,
        scope: "workspace",
        permission: "read",
        tag: "Settings",
        summary: "OpenRouter's model catalogue: model ids and prices (US$ per million tokens)",
        description: "Fetched by the server and kept for an hour. Empty, with `error` set, when OpenRouter can't be reached.",
        async handler({ services }) {
            return json(await services.catalogue.view());
        },
    }),
    route({
        method: "GET",
        path: `${W}/settings/model-prices`,
        scope: "workspace",
        permission: "read",
        tag: "Settings",
        summary: "Model prices: this workspace's own, the instance's, and what each model its reviews used costs",
        async handler({ services, access }) {
            const workspace = (access as Access).workspace;
            return json({ ...(await services.prices.workspaceView(workspace)), used: await usedModels(services, workspace) });
        },
    }),
    route({
        method: "PUT",
        path: `${W}/settings/model-prices`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Set this workspace's price for a model (overrides the instance's and OpenRouter's)",
        body: PriceBody,
        async handler({ services, access, body, actor }) {
            return json(await services.prices.setWorkspace(actor, (access as Access).workspace, body));
        },
    }),
    route({
        method: "DELETE",
        path: `${W}/settings/model-prices`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "Remove this workspace's price for a model",
        body: ModelBody,
        async handler({ services, access, body, actor }) {
            return json(await services.prices.removeWorkspace(actor, (access as Access).workspace, body.model));
        },
    }),
    route({
        method: "GET",
        path: `${W}/settings/model-allowance`,
        scope: "workspace",
        permission: "read",
        tag: "Settings",
        summary: "Whether this workspace may use the instance's model key, its monthly token allowance and this month's use",
        async handler({ services, access }) {
            const workspace = (access as Access).workspace;
            const run = await services.models.forRun(workspace);
            // What reviews would run with now; never the key itself.
            const now = run.ready
                ? { ready: true, keySource: run.keySource, provider: run.provider, model: run.model }
                : { ready: false, reason: run.reason };
            return json({ ...(await services.allowances.usage(workspace)), now });
        },
    }),
];
