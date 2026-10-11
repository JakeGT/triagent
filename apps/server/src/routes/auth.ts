// Signing in through an identity provider (AUTH_MODE=oidc), confirming it's you before sensitive steps,
// and what the sign-in page needs to know. Password sign-in and sign-out are in routes/account.ts.

import { log } from "@triagent/shared/log";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { forbidden, notFound } from "../errors.ts";
import { logFailure } from "../failure.ts";
import { cookieName } from "../http/mount.ts";
import { json, type Route, route } from "../http/route.ts";
import { sha256 } from "../security.ts";
import type { Services } from "../services/index.ts";
import { LOGIN_STATE_SECONDS, type Oidc, OidcError, safeNext } from "../services/oidc.ts";

/** The cookie that carries a sign-in attempt to the provider and back (sealed: see services/oidc.ts). */
export function loginStateCookie(services: Services): string {
    return services.config.cookieSecure ? "__Host-triagent_oidc" : "triagent_oidc";
}

export function setSessionCookie(c: Context, services: Services, value: string): void {
    setCookie(c, cookieName(services), value, {
        path: "/",
        httpOnly: true,
        secure: services.config.cookieSecure,
        // Lax, not Strict: the first request back from the provider is a cross-site navigation, and a
        // Strict cookie wouldn't be sent with it. Writes are still protected by the CSRF token and Origin checks.
        sameSite: "Lax",
        maxAge: services.config.sessionMaxHours * 3600,
    });
}

function oidcOf(services: Services): Oidc {
    if (services.config.authMode !== "oidc" || !services.oidc)
        throw notFound("Signing in through an identity provider isn't turned on (AUTH_MODE=local).");
    return services.oidc;
}

/** Back to the sign-in page with a short reason the page explains. */
const toSignIn = (c: Context, reason: OidcError["code"]) => c.redirect(`/sign-in?error=${reason}`, 302);

export const authRoutes: Route[] = [
    route({
        method: "GET",
        path: "/auth/config",
        scope: "public",
        tag: "Account",
        summary: "How people sign in here: with a password, or through an identity provider",
        async handler({ services }) {
            const { authMode, oidc, inviteHint, signupMode } = services.config;
            return json({ mode: authMode, providerName: oidc?.providerName ?? null, inviteHint, signupMode });
        },
    }),
    route({
        method: "GET",
        path: "/auth/login",
        scope: "public",
        tag: "Account",
        summary: "Sign in through the identity provider (AUTH_MODE=oidc): redirects there and back to `next`",
        description:
            "`next` must be a path on this site. `prompt=login&max_age=60` asks the provider to check who you are again, for steps that need a recent sign-in.",
        query: z.object({
            next: z.string().max(2000).optional(),
            prompt: z.enum(["login", "consent", "select_account", "none"]).optional(),
            max_age: z
                .string()
                .regex(/^\d{1,7}$/)
                .optional(),
        }),
        async handler({ c, services, query }) {
            const oidc = oidcOf(services);
            let started: { url: string; cookie: string };
            try {
                started = await oidc.start({
                    next: safeNext(query.next),
                    prompt: query.prompt ?? null,
                    maxAge: query.max_age === undefined ? null : Number(query.max_age),
                });
            } catch (err) {
                if (err instanceof OidcError) return toSignIn(c, err.code);
                throw err;
            }
            setCookie(c, loginStateCookie(services), started.cookie, {
                path: "/",
                httpOnly: true,
                secure: services.config.cookieSecure,
                // Lax, so it comes back with the provider's redirect (a top-level navigation from another site).
                sameSite: "Lax",
                maxAge: LOGIN_STATE_SECONDS,
            });
            return c.redirect(started.url, 302);
        },
    }),
    route({
        method: "GET",
        path: "/auth/callback",
        scope: "public",
        tag: "Account",
        summary: "Where the identity provider sends people back after signing in",
        async handler({ c, services, ip }) {
            const oidc = oidcOf(services);
            const stateCookie = getCookie(c, loginStateCookie(services));
            // One use only, whatever happens next.
            setCookie(c, loginStateCookie(services), "", {
                path: "/",
                httpOnly: true,
                secure: services.config.cookieSecure,
                sameSite: "Lax",
                maxAge: 0,
            });
            try {
                const { identity, idToken, next } = await oidc.finish(new URL(c.req.url).search.slice(1), stateCookie);
                const current = getCookie(c, cookieName(services));
                const result = await services.accounts.signInWithIdentity(identity, idToken, ip, current ? sha256(current) : null);
                if ("refused" in result) {
                    log.warn("Sign-in refused: no account and no invite", { ip, subject: identity.subject.slice(0, 64) });
                    return c.redirect("/invite-required", 302);
                }
                setSessionCookie(c, services, result.cookie);
                log.info("Signed in", { user: result.user.id, with: "provider", created: result.created });
                return c.redirect(safeNext(next), 302);
            } catch (err) {
                if (err instanceof OidcError) return toSignIn(c, err.code);
                logFailure("Signing in through the identity provider failed", err);
                return toSignIn(c, "failed");
            }
        },
    }),
    route({
        method: "POST",
        path: "/auth/reauth",
        scope: "user",
        browserOnly: true,
        tag: "Account",
        summary: "Confirm it's you with your password, for steps that need a recent sign-in (AUTH_MODE=local)",
        description: "With an identity provider, sign in again through `/auth/login?prompt=login&max_age=60` instead.",
        body: z.object({ password: z.string().min(1).max(1024) }),
        async handler({ services, principal, body, ip }) {
            if (services.config.authMode !== "local")
                throw notFound("With an identity provider, confirm it's you by signing in there again.");
            if (principal?.kind !== "session") throw forbidden("Sign in through the browser.");
            await services.accounts.reauthenticate(principal, body.password, ip);
            return json({ ok: true });
        },
    }),
];
