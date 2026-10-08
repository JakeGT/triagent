// The HTTP application: security headers, rate limits and every declared route.

import { Hono } from "hono";
import { ApiError } from "./errors.ts";
import { clientIp, errorResponse, mount } from "./http/mount.ts";
import type { Route } from "./http/route.ts";
import { serveWeb, webDistDir } from "./http/static.ts";
import { accountRoutes } from "./routes/account.ts";
import { githubRoutes } from "./routes/github.ts";
import { issueRoutes } from "./routes/issues.ts";
import { platformRoutes } from "./routes/platform.ts";
import { projectRoutes } from "./routes/projects.ts";
import { reportRoutes } from "./routes/reports.ts";
import { runnerRoutes } from "./routes/runner.ts";
import { runRoutes } from "./routes/runs.ts";
import { skillRoutes } from "./routes/skill.ts";
import { workspaceRoutes } from "./routes/workspace.ts";
import { RequestLimiter } from "./security.ts";
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
        ...workspaceRoutes,
        ...projectRoutes,
        ...reportRoutes,
        ...issueRoutes,
        ...skillRoutes,
        ...runRoutes,
        ...githubRoutes,
        ...runnerRoutes,
        ...platformRoutes(services, () => routes),
    );
    return routes;
}

export function createApp(services: Services): { app: Hono; routes: Route[] } {
    const app = new Hono();
    const limiter = new RequestLimiter(services.config.requestsPerMinute);

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
    serveWeb(app, webDistDir(services.config.webDistDir));
    app.onError((err, c) => errorResponse(c, err));
    app.notFound((c) => c.json({ error: `Nothing at ${c.req.method} ${c.req.path}. See /api/v1/openapi.json.` }, 404));
    return { app, routes };
}
