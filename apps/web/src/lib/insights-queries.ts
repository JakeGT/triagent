// Queries for analytics, model prices, the OpenRouter catalogue and instance-key allowances. Workspace
// keys nest under the workspace (so a workspace-wide live notice refreshes them); instance keys under "instance".

import { queryOptions } from "@tanstack/react-query";
import { api, paths } from "./api";
import type {
    Allowance,
    Analytics,
    Catalogue,
    Days,
    InstanceModel,
    InstanceReviews,
    InstanceWorkspaces,
    PriceEntry,
    WorkspacePrices,
} from "./insights-types";
import { keys } from "./queries";

export const insightKeys = {
    analytics: (ws: string, scope: { project?: string; branch?: string; days: Days }) => ["ws", ws, "analytics", scope] as const,
    catalogue: (ws: string) => ["ws", ws, "catalogue"] as const,
    prices: (ws: string) => keys.wsSettings(ws, "model-prices"),
    allowance: (ws: string) => keys.wsSettings(ws, "model-allowance"),
    instanceModel: ["instance", "model"] as const,
    instanceWorkspaces: ["instance", "workspaces"] as const,
    instancePrices: ["instance", "model-prices"] as const,
    instanceReviews: keys.instanceReviews,
};

export const instancePaths = {
    model: "/api/v1/instance/model",
    workspaces: "/api/v1/instance/workspaces",
    prices: "/api/v1/instance/model-prices",
    reviews: "/api/v1/instance/reviews",
};

export const analyticsQuery = (ws: string, scope: { project?: string; branch?: string; days: Days }) =>
    queryOptions({
        queryKey: insightKeys.analytics(ws, scope),
        queryFn: ({ signal }) =>
            api.get<Analytics>(
                `${paths.workspace(ws)}/analytics`,
                { project: scope.project, branch: scope.branch, days: scope.days },
                { signal },
            ),
        placeholderData: (previous) => previous,
        staleTime: 30_000,
    });

export const catalogueQuery = (ws: string) =>
    queryOptions({
        queryKey: insightKeys.catalogue(ws),
        queryFn: ({ signal }) => api.get<Catalogue>(`${paths.workspace(ws)}/models/catalogue`, undefined, { signal }),
        staleTime: 30 * 60_000,
    });

export const pricesQuery = (ws: string) =>
    queryOptions({
        queryKey: insightKeys.prices(ws),
        queryFn: ({ signal }) => api.get<WorkspacePrices>(`${paths.workspace(ws)}/settings/model-prices`, undefined, { signal }),
    });

export const allowanceQuery = (ws: string) =>
    queryOptions({
        queryKey: insightKeys.allowance(ws),
        queryFn: ({ signal }) => api.get<Allowance>(`${paths.workspace(ws)}/settings/model-allowance`, undefined, { signal }),
    });

export const instanceModelQuery = queryOptions({
    queryKey: insightKeys.instanceModel,
    queryFn: ({ signal }) => api.get<InstanceModel>(instancePaths.model, undefined, { signal }),
});

export const instanceWorkspacesQuery = queryOptions({
    queryKey: insightKeys.instanceWorkspaces,
    queryFn: ({ signal }) => api.get<InstanceWorkspaces>(instancePaths.workspaces, undefined, { signal }),
});

export const instanceReviewsQuery = queryOptions({
    queryKey: insightKeys.instanceReviews,
    queryFn: ({ signal }) => api.get<InstanceReviews>(instancePaths.reviews, undefined, { signal }),
});

export const instancePricesQuery = queryOptions({
    queryKey: insightKeys.instancePrices,
    queryFn: ({ signal }) => api.get<{ prices: PriceEntry[] }>(instancePaths.prices, undefined, { signal }),
});
