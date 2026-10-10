// Projects, and their settings (kept under /settings, apart from day-to-day work).

import { z } from "zod";
import { json, type Route, route } from "../http/route.ts";
import type { Access } from "../services/accounts.ts";
import { publicProject } from "../services/projects.ts";
import { AutomationSchema } from "../services/settings.ts";
import type { Project } from "../store/types.ts";
import { P, W } from "./common.ts";

const project = (p: Project | null) => p as Project;

export const projectRoutes: Route[] = [
    route({
        method: "GET",
        path: `${W}/projects`,
        scope: "workspace",
        permission: "read",
        tag: "Projects",
        summary: "The workspace's projects",
        async handler({ services, access }) {
            return json({ items: await services.projects.list((access as Access).workspace) });
        },
    }),
    route({
        method: "POST",
        path: `${W}/projects`,
        scope: "workspace",
        permission: "configure",
        tag: "Projects",
        summary: "Create a project (one per codebase)",
        body: z.object({
            slug: z.string().max(40),
            name: z.string().max(80).optional(),
            repoUrl: z.string().max(300).nullable().optional(),
            defaultBranch: z.string().max(200).optional(),
        }),
        async handler({ services, access, body, actor }) {
            return json(await services.projects.create(actor, (access as Access).workspace, body), 201);
        },
    }),
    route({
        method: "GET",
        path: P,
        scope: "project",
        permission: "read",
        tag: "Projects",
        summary: "One project",
        async handler({ project: p }) {
            return json(publicProject(project(p)));
        },
    }),
    route({
        method: "DELETE",
        path: P,
        scope: "project",
        permission: "configure",
        tag: "Projects",
        summary: "Delete a project and everything stored for it",
        description:
            'Send `{"confirm": "<project slug>"}` (the slug in its address, /p/{project}). Its past reviews and activity stay in ' +
            'the workspace\'s analytics unless you also send `"purgeAnalytics": true`.',
        body: z.object({ confirm: z.string().max(40), purgeAnalytics: z.boolean().optional() }),
        async handler({ services, project: p, body, actor }) {
            return json(await services.projects.delete(actor, project(p), body.confirm, { purgeAnalytics: body.purgeAnalytics === true }));
        },
    }),

    // ---- settings ------------------------------------------------------------------------
    route({
        method: "GET",
        path: `${P}/settings/general`,
        scope: "project",
        permission: "read",
        tag: "Settings",
        summary: "Name, repository and default branch",
        async handler({ project: p }) {
            return json(publicProject(project(p)));
        },
    }),
    route({
        method: "PATCH",
        path: `${P}/settings/general`,
        scope: "project",
        permission: "configure",
        tag: "Settings",
        summary: "Rename the project, or change its repository or default branch",
        body: z
            .object({
                name: z.string().max(80).optional(),
                repoUrl: z.string().max(300).nullable().optional(),
                defaultBranch: z.string().max(200).optional(),
            })
            .strict(),
        async handler({ services, project: p, body, actor }) {
            const input = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
            return json(await services.projects.update(actor, project(p), input));
        },
    }),
    route({
        method: "GET",
        path: `${P}/settings/automation`,
        scope: "project",
        permission: "read",
        tag: "Settings",
        summary: "Automatic review settings",
        async handler({ services, project: p }) {
            return json(await services.settings.automation(services.store, project(p)));
        },
    }),
    route({
        method: "PATCH",
        path: `${P}/settings/automation`,
        scope: "project",
        permission: "configure",
        tag: "Settings",
        summary: "Change automatic review settings",
        description:
            "Only the settings given change. `models` and `options` are each saved whole: a set or an option left out of the one given is no longer set, so send all of it (`options: {}` turns every option off).",
        body: AutomationSchema.partial().strict(),
        async handler({ services, project: p, body, actor }) {
            return json(await services.settings.setAutomation(actor, project(p), body));
        },
    }),
    route({
        method: "GET",
        path: `${P}/settings/github`,
        scope: "project",
        permission: "configure",
        tag: "Settings",
        summary: "The GitHub connection and webhook (whether secrets are set, never their values)",
        async handler({ services, project: p }) {
            return json(await services.github.settingsView(project(p)));
        },
    }),
    route({
        method: "PUT",
        path: `${P}/settings/github/token`,
        scope: "project",
        permission: "secrets",
        tag: "Settings",
        summary: "Set the GitHub token (fine-grained, limited to the repository; stored encrypted)",
        body: z.object({ token: z.string().max(300) }),
        async handler({ services, project: p, body, actor }) {
            return json(await services.settings.setGithubToken(actor, project(p), body.token));
        },
    }),
    route({
        method: "DELETE",
        path: `${P}/settings/github/token`,
        scope: "project",
        permission: "secrets",
        tag: "Settings",
        summary: "Forget the GitHub token",
        async handler({ services, project: p, actor }) {
            return json(await services.settings.setGithubToken(actor, project(p), null));
        },
    }),
    route({
        method: "POST",
        path: `${P}/settings/github/webhook-secret`,
        scope: "project",
        permission: "secrets",
        tag: "Settings",
        summary: "Create a new webhook secret (returned this once; replaces any previous one)",
        async handler({ services, project: p, actor }) {
            return json(await services.settings.generateWebhookSecret(actor, project(p)));
        },
    }),
    route({
        method: "DELETE",
        path: `${P}/settings/github/webhook-secret`,
        scope: "project",
        permission: "secrets",
        tag: "Settings",
        summary: "Turn the webhook off",
        async handler({ services, project: p, actor }) {
            return json(await services.settings.clearWebhookSecret(actor, project(p)));
        },
    }),
];
