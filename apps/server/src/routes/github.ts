// GitHub: a project's repository (from the GitHub App, or a token), linking app installations to a
// workspace, the app's webhook, and the instance's GitHub App.

import { z } from "zod";
import { forbidden } from "../errors.ts";
import { json, type Route, route } from "../http/route.ts";
import type { Access } from "../services/accounts.ts";
import { ConnectionSchema } from "../services/github/service.ts";
import type { Project } from "../store/types.ts";
import { P, W } from "./common.ts";

const project = (p: Project | null) => p as Project;

export const githubRoutes: Route[] = [
    // ---- a project's repository ------------------------------------------------------------------
    route({
        method: "PUT",
        path: `${P}/settings/github/repository`,
        scope: "project",
        permission: "configure",
        tag: "Settings",
        summary: "Use one of the GitHub App installation's repositories for this project",
        body: ConnectionSchema,
        async handler({ services, project: p, body, actor }) {
            return json(await services.github.setConnection(actor, project(p), body));
        },
    }),
    route({
        method: "DELETE",
        path: `${P}/settings/github/repository`,
        scope: "project",
        permission: "configure",
        tag: "Settings",
        summary: "Stop using the GitHub App for this project (a token, if set, is used instead)",
        async handler({ services, project: p, actor }) {
            return json(await services.github.clearConnection(actor, project(p)));
        },
    }),
    route({
        method: "POST",
        path: `${P}/settings/github/test`,
        scope: "project",
        permission: "configure",
        tag: "Settings",
        summary: "Check the connection: read the repository and its open pull requests",
        async handler({ services, project: p }) {
            return json(await services.github.test(project(p)));
        },
    }),

    // ---- installations ---------------------------------------------------------------------------
    route({
        method: "GET",
        path: `${W}/github/installations`,
        scope: "workspace",
        permission: "configure",
        tag: "Settings",
        summary: "The GitHub App installations linked to this workspace, with their repositories",
        async handler({ services, access }) {
            return json(await services.github.installations((access as Access).workspace));
        },
    }),
    route({
        method: "POST",
        path: `${W}/github/installations`,
        scope: "workspace",
        permission: "secrets",
        tag: "Settings",
        summary: "Start installing the GitHub App: returns the address on GitHub to go to",
        description: "GitHub sends you back to Triagent, which links the installation once GitHub confirms you can see it.",
        body: z.object({ project: z.string().max(40).describe("The project whose settings to come back to") }),
        async handler({ services, access, body, actor }) {
            const workspace = (access as Access).workspace;
            await services.projects.get(services.store, workspace, body.project);
            return json(await services.github.startInstall(actor, workspace, body.project));
        },
    }),
    route({
        method: "DELETE",
        path: `${W}/github/installations/{installationId}`,
        scope: "workspace",
        permission: "secrets",
        tag: "Settings",
        summary: "Unlink a GitHub App installation from this workspace (it stays installed on GitHub)",
        async handler({ services, access, params, actor }) {
            return json(await services.github.unlink(actor, (access as Access).workspace, Number(params.installationId)));
        },
    }),
    route({
        method: "GET",
        path: "/api/v1/github/app/installed",
        scope: "user",
        browserOnly: true,
        tag: "GitHub",
        summary: "Where GitHub sends you after installing the app (links it, once GitHub confirms you can see it)",
        query: z.object({
            code: z.string().max(200).optional(),
            installation_id: z.string().max(20).optional(),
            setup_action: z.string().max(40).optional(),
            state: z.string().max(2000).optional(),
        }),
        async handler({ c, services, principal, query }) {
            if (principal?.kind !== "session") throw forbidden("Sign in through the browser.");
            const out = await services.github.completeInstall(principal.user, query);
            return c.redirect(out.redirect, 302);
        },
    }),
    route({
        method: "POST",
        path: "/api/v1/github/app/webhook",
        scope: "public",
        tag: "GitHub",
        summary: "The GitHub App's webhook (verified by X-Hub-Signature-256 with the app's secret)",
        rawBody: true,
        bodyLimit: 5 * 1024 * 1024,
        async handler({ c, services, readRaw }) {
            return json(
                await services.automation.appDelivery(
                    readRaw,
                    c.req.header("x-hub-signature-256"),
                    c.req.header("x-github-event"),
                    c.req.header("x-github-delivery")?.slice(0, 80) ?? null,
                ),
            );
        },
    }),

    // ---- the instance's GitHub App -----------------------------------------------------------------
    route({
        method: "GET",
        path: "/api/v1/instance/github-app",
        scope: "instance",
        tag: "Instance",
        summary: "Whether the instance has a GitHub App, and its recent webhook deliveries",
        async handler({ services }) {
            return json(await services.github.appStatus());
        },
    }),
    route({
        method: "POST",
        path: "/api/v1/instance/github-app/manifest",
        scope: "instance",
        // It ends with the app's keys stored: like setting any secret, it needs a recent sign-in.
        recentSignIn: true,
        tag: "Instance",
        summary: "Start creating the GitHub App (GitHub's manifest flow): returns a page to open",
        body: z.object({
            name: z.string().max(34),
            public: z.boolean().describe("Installable by any GitHub account (needed for other people's workspaces), or only its owner"),
            org: z.string().max(39).nullable().describe("Create it under this organisation, or (null) your own account"),
            ws: z.string().max(40).describe("The workspace whose settings to come back to"),
        }),
        async handler({ services, principal, body }) {
            if (principal?.kind !== "session") throw forbidden("Sign in through the browser.");
            return json(services.github.startManifest(principal.user, { ...body, org: body.org || null }));
        },
    }),
    route({
        method: "GET",
        path: "/api/v1/instance/github-app/form",
        scope: "instance",
        tag: "Instance",
        summary: "A page that posts the app's manifest to GitHub",
        query: z.object({ state: z.string().max(2000) }),
        async handler({ c, services, principal, query }) {
            if (principal?.kind !== "session") throw forbidden("Sign in through the browser.");
            const page = services.github.manifestForm(principal.user, query.state);
            // The one page allowed to post a form to GitHub.
            c.header(
                "Content-Security-Policy",
                `default-src 'none'; form-action ${page.formAction}; base-uri 'none'; frame-ancestors 'none'`,
            );
            return c.html(page.html);
        },
    }),
    route({
        method: "GET",
        path: "/api/v1/instance/github-app/created",
        scope: "instance",
        recentSignIn: true,
        tag: "Instance",
        summary: "Where GitHub sends you after creating the app: keeps its credentials (encrypted)",
        query: z.object({ code: z.string().max(200).optional(), state: z.string().max(2000).optional() }),
        async handler({ c, services, principal, query }) {
            if (principal?.kind !== "session") throw forbidden("Sign in through the browser.");
            const out = await services.github.manifestCreated(principal.user, query);
            return c.redirect(out.redirect, 302);
        },
    }),
    route({
        method: "DELETE",
        path: "/api/v1/instance/github-app",
        scope: "instance",
        recentSignIn: true,
        tag: "Instance",
        summary: "Forget the GitHub App (delete it on GitHub too); its installations are unlinked",
        async handler({ services, actor }) {
            return json(await services.github.removeApp(actor));
        },
    }),
];
