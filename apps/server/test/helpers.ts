// An in-process server for tests: real routes and services over the in-memory store.

import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Route } from "../src/http/route.ts";
import { createServices, type Services } from "../src/services/index.ts";
import { MemoryStore } from "../src/store/memory.ts";

export const ORIGIN = "http://triagent.test";
export const ADMIN_PASSWORD = "correct-horse-battery-staple";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field in the tests
type Body = any;

export interface TestApp {
    app: Hono;
    routes: Route[];
    services: Services;
    request(
        path: string,
        init?: { method?: string; body?: unknown; session?: Session; token?: string; headers?: Record<string, string> },
    ): Promise<{ status: number; body: Body; text: string }>;
    signIn(username: string, password: string): Promise<Session>;
}

export interface Session {
    cookie: string;
    csrf: string;
}

export async function testApp(): Promise<TestApp> {
    const config = loadConfig({
        PUBLIC_ORIGIN: ORIGIN,
        COOKIE_SECURE: "false",
        TRIAGENT_ADMIN_USER: "admin",
        TRIAGENT_ADMIN_PASSWORD: ADMIN_PASSWORD,
        TRIAGENT_SECRETS_KEY: randomBytes(32).toString("base64"),
        REQUESTS_PER_MINUTE: "1000000",
    });
    const services = createServices(config, new MemoryStore());
    await services.accounts.bootstrap();
    const { app, routes } = createApp(services);

    const request: TestApp["request"] = async (path, init = {}) => {
        const headers: Record<string, string> = { ...init.headers };
        if (init.body !== undefined) headers["content-type"] = "application/json";
        if (init.session) {
            headers.cookie = init.session.cookie;
            headers["x-csrf-token"] = init.session.csrf;
            headers.origin = ORIGIN;
        }
        if (init.token) headers.authorization = `Bearer ${init.token}`;
        const res = await app.request(`${ORIGIN}${path}`, {
            method: init.method ?? "GET",
            headers,
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        const text = await res.text();
        let body: unknown = text;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            // not JSON
        }
        return { status: res.status, body, text };
    };

    const signIn = async (username: string, password: string): Promise<Session> => {
        const res = await app.request(`${ORIGIN}/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: ORIGIN },
            body: JSON.stringify({ username, password }),
        });
        if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
        const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        const me = await request("/api/v1/me", { session: { cookie, csrf: "" } });
        return { cookie, csrf: me.body.csrf };
    };

    return { app, routes, services, request, signIn };
}

export const report = (...paths: string[]) => ({
    status: "completed",
    comments: paths.map((path, i) => ({
        path,
        content: `Problem number ${i + 1} in ${path}.`,
        severity: "high",
        category: "bug",
        start_line: 1,
        end_line: 2,
    })),
    project_summary: "",
});
