// Signing in and out, your own account, your workspaces, and (for instance admins) local accounts.

import { setCookie } from "hono/cookie";
import { z } from "zod";
import { ApiError, forbidden, notFound } from "../errors.ts";
import { cookieName } from "../http/mount.ts";
import { json, type Route, route } from "../http/route.ts";
import { publicUser, publicWorkspace } from "../services/accounts.ts";
import type { Services } from "../services/index.ts";
import { setSessionCookie } from "./auth.ts";

/** Passwords are only for AUTH_MODE=local: with an identity provider, it looks after them. */
function passwordsOnly(services: Services): void {
    if (services.config.authMode !== "local")
        throw notFound(
            `Passwords aren't used here: people sign in with ${services.config.oidc?.providerName ?? "the identity provider"}, which looks after them.`,
        );
}

export const accountRoutes: Route[] = [
    route({
        method: "POST",
        path: "/auth/login",
        scope: "public",
        tag: "Account",
        summary: "Sign in with a username and password (AUTH_MODE=local)",
        body: z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(1024) }),
        async handler({ c, services, body, ip }) {
            passwordsOnly(services);
            // Signing in from another site would let it plant its own session (login CSRF).
            const origin = c.req.header("origin");
            const site = c.req.header("sec-fetch-site");
            if (origin ? origin !== services.config.publicOrigin : site && site !== "same-origin" && site !== "none")
                throw forbidden("Cross-site sign-in blocked.");
            const result = await services.accounts.signIn(body.username, body.password, ip);
            if ("retryAfter" in result) {
                if (result.retryAfter) {
                    c.header("Retry-After", String(result.retryAfter));
                    throw new ApiError(429, `Too many failed attempts. Try again in ${Math.ceil(result.retryAfter / 60)} minute(s).`);
                }
                console.warn(`Failed sign-in for "${body.username.slice(0, 64)}" from ${ip}`);
                throw new ApiError(401, "Wrong username or password.");
            }
            setSessionCookie(c, services, result.cookie);
            return json({ ok: true, mustChangePassword: result.user.mustChangePassword });
        },
    }),
    route({
        method: "POST",
        path: "/auth/logout",
        scope: "user",
        browserOnly: true,
        duringPasswordChange: true,
        tag: "Account",
        summary: "Sign out of this browser",
        description:
            "`redirect` is where to go next: with an identity provider, its sign-out page (which returns to this site); otherwise null.",
        async handler({ c, services, principal }) {
            const idToken = principal?.kind === "session" ? principal.session.idToken : null;
            if (principal?.kind === "session") await services.accounts.signOut(principal.session.idHash);
            setCookie(c, cookieName(services), "", {
                path: "/",
                httpOnly: true,
                secure: services.config.cookieSecure,
                sameSite: "Lax",
                maxAge: 0,
            });
            return json({ ok: true, redirect: services.oidc ? await services.oidc.endSessionUrl(idToken) : null });
        },
    }),
    route({
        method: "GET",
        path: "/api/v1/me",
        scope: "user",
        duringPasswordChange: true,
        tag: "Account",
        summary: "Who you are, your workspaces, and your CSRF token",
        async handler({ services, principal }) {
            if (principal?.kind === "token") {
                const t = principal.token;
                const workspace = await services.store.workspaces.get(t.workspaceId);
                return json({
                    kind: "token",
                    token: { id: t.id, name: t.name, scope: t.scope, expiresAt: t.expiresAt },
                    workspace: workspace && publicWorkspace(workspace),
                    owner: principal.owner && publicUser(principal.owner),
                });
            }
            if (principal?.kind !== "session") throw new ApiError(401, "Sign in.");
            const { user, session } = principal;
            const workspaces = await services.accounts.workspacesOf(user);
            const personal = workspaces.find((w) => w.kind === "personal" && w.role === "owner");
            return json({
                kind: "session",
                user: publicUser(user),
                authMode: services.config.authMode,
                csrf: session.csrf,
                mustChangePassword: user.mustChangePassword,
                notify: user.notify,
                tutorial: {
                    status: user.tutorial.status,
                    step: user.tutorial.step,
                    setup: user.tutorial.setup ?? "pending",
                    // Where the example project is, so pages can mark it as one.
                    example:
                        personal && user.tutorial.exampleProject
                            ? { workspace: personal.slug, project: user.tutorial.exampleProject }
                            : null,
                },
                workspaces,
            });
        },
    }),
    route({
        method: "POST",
        path: "/api/v1/me/password",
        scope: "user",
        browserOnly: true,
        duringPasswordChange: true,
        tag: "Account",
        summary: "Change your password (signs out your other sessions)",
        body: z.object({ current: z.string().max(1024), password: z.string().max(1024) }),
        async handler({ services, principal, body, ip, actor }) {
            passwordsOnly(services);
            if (principal?.kind !== "session") throw forbidden("Sign in through the browser to change a password.");
            return json(await services.accounts.changeOwnPassword(principal, body.current, body.password, ip, actor));
        },
    }),
    route({
        method: "PUT",
        path: "/api/v1/me/notifications",
        scope: "user",
        browserOnly: true,
        tag: "Account",
        summary: "Choose which finished reviews you hear about",
        body: z.object({ scope: z.enum(["mine", "all", "none"]).optional(), problemsOnly: z.boolean().optional() }).strict(),
        async handler({ services, principal, body }) {
            if (principal?.kind !== "session") throw forbidden("Sign in through the browser.");
            const prefs = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
            return json(await services.accounts.setNotify(principal.user, prefs));
        },
    }),
    route({
        method: "GET",
        path: "/api/v1/workspaces",
        scope: "user",
        tag: "Workspaces",
        summary: "Workspaces you belong to (for a token: its own workspace)",
        async handler({ services, principal }) {
            if (principal?.kind === "token") {
                const w = await services.store.workspaces.get(principal.token.workspaceId);
                return json({ items: w ? [publicWorkspace(w)] : [] });
            }
            return json({ items: principal?.kind === "session" ? await services.accounts.workspacesOf(principal.user) : [] });
        },
    }),
    route({
        method: "POST",
        path: "/api/v1/workspaces",
        scope: "user",
        browserOnly: true,
        tag: "Workspaces",
        summary: "Create an organisation (you become its owner)",
        body: z.object({ slug: z.string().max(40), name: z.string().max(80).optional() }),
        async handler({ services, principal, body, actor }) {
            if (principal?.kind !== "session") throw forbidden("Sign in through the browser.");
            return json(
                await services.accounts.createOrganisation(
                    { ...actor, userId: principal.user.id },
                    { slug: body.slug, name: body.name ?? "" },
                ),
                201,
            );
        },
    }),

    // ---- instance administration: local accounts ----------------------------------------------
    route({
        method: "GET",
        path: "/api/v1/instance/users",
        scope: "instance",
        tag: "Instance",
        summary: "All accounts",
        async handler({ services }) {
            const users = await services.store.users.list();
            const items = await Promise.all(
                users.map(async (u) => ({
                    ...publicUser(u),
                    signsInWith: u.subject ? "provider" : "password",
                    mustChangePassword: u.mustChangePassword,
                    sessions: (await services.store.sessions.listForUser(u.id)).length,
                })),
            );
            return json({ items: items.sort((a, b) => a.displayName.localeCompare(b.displayName)) });
        },
    }),
    route({
        method: "POST",
        path: "/api/v1/instance/users",
        scope: "instance",
        recentSignIn: true,
        tag: "Instance",
        summary: "Create a local account (it must choose its own password at first sign-in)",
        description: "Leave the password out to have one generated; it's returned this once.",
        body: z.object({
            username: z.string().max(64),
            password: z.string().max(1024).optional(),
            isInstanceAdmin: z.boolean().optional(),
        }),
        async handler({ services, body, actor }) {
            passwordsOnly(services);
            return json(await services.accounts.adminCreateUser(actor, body), 201);
        },
    }),
    route({
        method: "POST",
        path: "/api/v1/instance/users/{userId}/password",
        scope: "instance",
        recentSignIn: true,
        tag: "Instance",
        summary: "Reset an account's password (signs it out everywhere)",
        body: z.object({ password: z.string().max(1024).optional() }),
        async handler({ services, params, body, actor }) {
            passwordsOnly(services);
            return json(await services.accounts.adminResetPassword(actor, params.userId as string, body.password));
        },
    }),
    route({
        method: "POST",
        path: "/api/v1/instance/users/{userId}/sign-out",
        scope: "instance",
        recentSignIn: true,
        tag: "Instance",
        summary: "Sign an account out of all its sessions",
        async handler({ services, params, actor }) {
            return json(await services.accounts.adminSignOutUser(actor, params.userId as string));
        },
    }),
    route({
        method: "DELETE",
        path: "/api/v1/instance/users/{userId}",
        scope: "instance",
        recentSignIn: true,
        tag: "Instance",
        summary: "Remove an account",
        async handler({ services, params, actor }) {
            return json(await services.accounts.adminDeleteUser(actor, params.userId as string));
        },
    }),
];
