// An in-process server for tests: real routes and services over the in-memory store, or over Postgres
// when TRIAGENT_TEST_DATABASE_URL names a database to use (each app gets a schema of its own, dropped
// once the file's tests are done).

import { randomBytes } from "node:crypto";
import { after } from "node:test";
import { configureLog, LOG_LEVELS, type LogLevel } from "@triagent/shared/log";
import type { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import type { Route } from "../src/http/route.ts";
import { createServices, type ServiceOptions, type Services } from "../src/services/index.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { connect, type PostgresOptions, PostgresStore } from "../src/store/postgres.ts";
import type { Store } from "../src/store/types.ts";

// Tests print warnings and errors only, unless asked for more: a line for every request drowns the results.
configureLog({
    level: (LOG_LEVELS as readonly string[]).includes(process.env.LOG_LEVEL ?? "") ? (process.env.LOG_LEVEL as LogLevel) : "warn",
});

export const TEST_DATABASE_URL = process.env.TRIAGENT_TEST_DATABASE_URL || null;
const opened: PostgresStore[] = [];

/** A Postgres store in a fresh schema of its own. Needs TRIAGENT_TEST_DATABASE_URL. */
export async function postgresStore(options: Omit<PostgresOptions, "schema"> = {}): Promise<PostgresStore> {
    if (!TEST_DATABASE_URL) throw new Error("Set TRIAGENT_TEST_DATABASE_URL to test against Postgres.");
    const schema = `test_${randomBytes(8).toString("hex")}`;
    const store = new PostgresStore(TEST_DATABASE_URL, { max: 5, idleTimeout: 2, ...options, schema });
    opened.push(store);
    await migrate(store.sql, { schema });
    return store;
}

/** Another connection pool on `store`'s schema, as a second server process would have. */
export function sameDatabase(store: PostgresStore): PostgresStore {
    if (!TEST_DATABASE_URL || !store.schema) throw new Error("Only for stores made by postgresStore().");
    const other = new PostgresStore(TEST_DATABASE_URL, { max: 5, idleTimeout: 2, schema: store.schema });
    opened.push(other);
    return other;
}

/** The store tests run against: Postgres if a test database is set, otherwise memory. */
export function testStore(): Promise<Store> {
    return TEST_DATABASE_URL ? postgresStore() : Promise.resolve(new MemoryStore());
}

after(async () => {
    if (!TEST_DATABASE_URL || !opened.length) return;
    // Drop every schema even if a pool fails to close, so the test database doesn't collect them.
    await Promise.allSettled(opened.map((s) => s.close()));
    const sql = connect(TEST_DATABASE_URL, { max: 1 });
    try {
        for (const s of opened) await sql`drop schema if exists ${sql(s.schema as string)} cascade`;
    } finally {
        await sql.end();
    }
});

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

/**
 * `options` replaces the clock or OpenRouter (the catalogue is off unless a fake fetch is given: tests never
 * use the network), and `env` adds to the configuration.
 */
export async function testApp(store?: Store, options: ServiceOptions & { env?: Record<string, string> } = {}): Promise<TestApp> {
    const { env = {}, ...serviceOptions } = options;
    const config = loadConfig({
        OPENROUTER_CATALOGUE: options.fetch ? "true" : "false",
        PUBLIC_ORIGIN: ORIGIN,
        COOKIE_SECURE: "false",
        TRIAGENT_ADMIN_USER: "admin",
        TRIAGENT_ADMIN_PASSWORD: ADMIN_PASSWORD,
        TRIAGENT_SECRETS_KEY: randomBytes(32).toString("base64"),
        REQUESTS_PER_MINUTE: "1000000",
        ...env,
    });
    const services = createServices(config, store ?? (await testStore()), serviceOptions);
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
        if (!cookie) throw new Error("sign-in set no session cookie");
        const me = await request("/api/v1/me", { session: { cookie, csrf: "" } });
        if (me.status !== 200 || typeof me.body?.csrf !== "string") throw new Error(`/api/v1/me answered ${me.status}: ${me.text}`);
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
