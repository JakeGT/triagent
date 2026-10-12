// The HTTP application: security headers, rate limits and every declared route.

import { log } from "@triagent/shared/log";
import { type Context, Hono } from "hono";
import { ApiError } from "./errors.ts";
import { clientIp, errorResponse, mount } from "./http/mount.ts";
import { type RequestInfo, runInRequest } from "./http/request-context.ts";
import type { Route } from "./http/route.ts";
import { serveWeb, webDistDir } from "./http/static.ts";
import { accountRoutes } from "./routes/account.ts";
import { analysisRoutes } from "./routes/analysis.ts";
import { authRoutes } from "./routes/auth.ts";
import { githubRoutes } from "./routes/github.ts";
import { insightRoutes } from "./routes/insights.ts";
import { instanceModelRoutes } from "./routes/instance-models.ts";
import { inviteRoutes } from "./routes/invites.ts";
import { issueRoutes } from "./routes/issues.ts";
import { patternRoutes } from "./routes/patterns.ts";
import { platformRoutes } from "./routes/platform.ts";
import { projectRoutes } from "./routes/projects.ts";
import { reportRoutes } from "./routes/reports.ts";
import { runnerRoutes } from "./routes/runner.ts";
import { runRoutes } from "./routes/runs.ts";
import { skillRoutes } from "./routes/skill.ts";
import { tutorialRoutes } from "./routes/tutorial.ts";
import { workspaceRoutes } from "./routes/workspace.ts";
import { RequestLimiter, randomId } from "./security.ts";
import { BrowserReports } from "./services/browser-reports.ts";
import type { Services } from "./services/index.ts";

const CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join("; ");

export function allRoutes(services: Services): Route[] {
    const routes: Route[] = [];
    routes.push(
        ...accountRoutes,
        ...tutorialRoutes,
        ...authRoutes,
        ...inviteRoutes,
        ...workspaceRoutes,
        ...projectRoutes,
        ...reportRoutes,
        ...issueRoutes,
        ...skillRoutes,
        ...runRoutes,
        ...githubRoutes,
        ...runnerRoutes,
        ...insightRoutes,
        ...analysisRoutes,
        ...patternRoutes,
        ...instanceModelRoutes,
        ...platformRoutes(services, () => routes),
    );
    return routes;
}

/** Asked for every few seconds, or for every file of a page: a line each only when looking closely (LOG_LEVEL=debug). */
const quiet = (info: RequestInfo, path: string) => path === "/healthz" || path.startsWith("/internal/runner/") || !info.route;

/** One line for each request answered: what was asked, by whom, what it got and how long that took. */
function logRequest(c: Context, info: RequestInfo, started: number): void {
    const status = c.res.status;
    const fields = { path: c.req.path.slice(0, 300), status, ms: Math.round(performance.now() - started) };
    if (status >= 500) log.warn("Request answered with an error", fields);
    else if (quiet(info, c.req.path)) log.debug("Request", fields);
    else log.info("Request", fields);
}

export function createApp(services: Services): { app: Hono; routes: Route[] } {
    const app = new Hono();
    const limiter = new RequestLimiter(services.config.requestsPerMinute);

    // First, so that everything after it (the limits, the routes, an error's answer) is part of the request.
    app.use("*", (c, next) => {
        const info: RequestInfo = { id: randomId(), method: c.req.method };
        const started = performance.now();
        c.header("X-Request-Id", info.id);
        return runInRequest(info, async () => {
            try {
                await next();
            } finally {
                logRequest(c, info, started);
            }
        });
    });

    app.use("*", async (c, next) => {
        c.header("Content-Security-Policy", CSP);
        c.header("X-Content-Type-Options", "nosniff");
        c.header("X-Frame-Options", "DENY");
        c.header("Referrer-Policy", "no-referrer");
        c.header("Cross-Origin-Opener-Policy", "same-origin");
        c.header("Cross-Origin-Resource-Policy", "same-origin");
        c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
        c.header("X-Robots-Tag", "noindex, nofollow");
        c.header("Cache-Control", "no-store");
        if (services.config.cookieSecure) c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        if (c.req.path !== "/healthz" && !limiter.allow(clientIp(c, services.config.proxyHops))) {
            c.header("Retry-After", "60");
            throw new ApiError(429, "Too many requests. Slow down and try again in a minute.");
        }
        await next();
    });

    const routes = allRoutes(services);
    mount(app, services, routes);
    // The web app, if it has been built (after the API, so API routes win).
    serveWeb(app, webDistDir(services.config.webDistDir), BrowserReports.forPage(services.config.telemetry));
    app.onError((err, c) => errorResponse(c, err));
    app.notFound((c) => c.json({ error: `Nothing at ${c.req.method} ${c.req.path}. See /api/v1/openapi.json.` }, 404));
    return { app, routes };
}
