// Instance administration of models: the instance's model key, provider and model, the workspaces allowed
// to use it (with monthly token allowances), and instance-wide model prices. Instance administrators
// only, in the browser; keys are never returned.

import { MODEL_PROTOCOLS } from "@triagent/shared/model";
import { z } from "zod";
import { notFound } from "../errors.ts";
import { json, type Route, route } from "../http/route.ts";
import { PROVIDER_IDS } from "../services/providers.ts";
import { ModelBody, PriceBody } from "./insights.ts";

/** Choosing a provider and model, and the chosen provider's protocol, endpoint URL (Azure, custom) or AWS region (Bedrock). */
export const ModelChoiceBody = z.object({
    provider: z.enum(PROVIDER_IDS as [string, ...string[]]).optional(),
    model: z.string().max(150).optional(),
    protocol: z.enum(MODEL_PROTOCOLS).optional(),
    url: z.string().max(500).nullable().optional(),
    region: z.string().max(40).nullable().optional(),
});

export const instanceModelRoutes: Route[] = [
    route({
        method: "GET",
        path: "/api/v1/instance/model",
        scope: "instance",
        tag: "Instance",
        summary: "The instance's provider and model, and which providers have an instance key (never the keys)",
        async handler({ services }) {
            return json(await services.allowances.view());
        },
    }),
    route({
        method: "PATCH",
        path: "/api/v1/instance/model",
        scope: "instance",
        tag: "Instance",
        summary: "Choose the provider and model reviews use with the instance key, and that provider's settings",
        body: ModelChoiceBody,
        async handler({ services, body, actor }) {
            return json(await services.allowances.setModel(actor, body));
        },
    }),
    route({
        method: "PUT",
        path: "/api/v1/instance/model/keys/{provider}",
        scope: "instance",
        // A secret without the secrets permission (instance routes have none): it needs a recent sign-in all the same.
        recentSignIn: true,
        tag: "Instance",
        summary: "Set the instance's API key for a provider (stored encrypted, never shown again)",
        body: z.object({ key: z.string().max(500) }),
        async handler({ services, params, body, actor }) {
            return json(await services.allowances.setKey(actor, params.provider as string, body.key));
        },
    }),
    route({
        method: "DELETE",
        path: "/api/v1/instance/model/keys/{provider}",
        scope: "instance",
        // A secret without the secrets permission (instance routes have none): it needs a recent sign-in all the same.
        recentSignIn: true,
        tag: "Instance",
        summary: "Forget the instance's API key for a provider",
        async handler({ services, params, actor }) {
            return json(await services.allowances.setKey(actor, params.provider as string, null));
        },
    }),
    route({
        method: "PUT",
        path: "/api/v1/instance/model/keys/{provider}/access-key-id",
        scope: "instance",
        recentSignIn: true,
        tag: "Instance",
        summary: "Set the instance's AWS access key ID for a provider (Amazon Bedrock; stored encrypted)",
        body: z.object({ key: z.string().max(500) }),
        async handler({ services, params, body, actor }) {
            return json(await services.allowances.setKey(actor, params.provider as string, body.key, "accessKeyId"));
        },
    }),
    route({
        method: "DELETE",
        path: "/api/v1/instance/model/keys/{provider}/access-key-id",
        scope: "instance",
        recentSignIn: true,
        tag: "Instance",
        summary: "Forget the instance's AWS access key ID for a provider",
        async handler({ services, params, actor }) {
            return json(await services.allowances.setKey(actor, params.provider as string, null, "accessKeyId"));
        },
    }),
    route({
        method: "GET",
        path: "/api/v1/instance/model/providers/{provider}/models",
        scope: "instance",
        tag: "Instance",
        summary: "A provider's models, fetched by the server with the instance key (never returned), plus suggestions",
        async handler({ services, params }) {
            const view = await services.modelLists.list(services.store, { kind: "instance" }, params.provider as string);
            if (!view) throw notFound("No such provider.");
            return json(view);
        },
    }),
    route({
        method: "GET",
        path: "/api/v1/instance/workspaces",
        scope: "instance",
        tag: "Instance",
        summary: "Every workspace, with its instance-key allowance and this month's use of it",
        async handler({ services }) {
            return json(await services.allowances.workspaces());
        },
    }),
    route({
        method: "PUT",
        path: "/api/v1/instance/workspaces/{workspaceId}/grant",
        scope: "instance",
        recentSignIn: true,
        tag: "Instance",
        summary: "Let a workspace use the instance key, up to a number of tokens each month (UTC)",
        body: z.object({ monthlyTokens: z.number().int() }),
        async handler({ services, params, body, actor }) {
            return json(await services.allowances.setGrant(actor, params.workspaceId as string, body.monthlyTokens));
        },
    }),
    route({
        method: "DELETE",
        path: "/api/v1/instance/workspaces/{workspaceId}/grant",
        scope: "instance",
        recentSignIn: true,
        tag: "Instance",
        summary: "Stop a workspace using the instance key",
        async handler({ services, params, actor }) {
            return json(await services.allowances.removeGrant(actor, params.workspaceId as string));
        },
    }),
    route({
        method: "GET",
        path: "/api/v1/instance/model-prices",
        scope: "instance",
        tag: "Instance",
        summary: "Instance-wide model prices (US$ per million tokens)",
        async handler({ services }) {
            return json(await services.prices.instanceView());
        },
    }),
    route({
        method: "PUT",
        path: "/api/v1/instance/model-prices",
        scope: "instance",
        tag: "Instance",
        summary: "Set the instance-wide price for a model",
        body: PriceBody,
        async handler({ services, body, actor }) {
            return json(await services.prices.setInstance(actor, body));
        },
    }),
    route({
        method: "DELETE",
        path: "/api/v1/instance/model-prices",
        scope: "instance",
        tag: "Instance",
        summary: "Remove the instance-wide price for a model",
        body: ModelBody,
        async handler({ services, body, actor }) {
            return json(await services.prices.removeInstance(actor, body.model));
        },
    }),
];
