// Shared set-up for the end-to-end tests: API helpers that sign in and seed data, and a guard on every
// test that fails it if the browser reported any Content Security Policy violation.

import { readFileSync } from "node:fs";
import path from "node:path";
import { type APIRequestContext, test as base, expect, type Page, request } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, PASSWORD } from "./constants";

export const REPORT = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/report.json"), "utf8")) as {
    comments: { path: string; content: string; severity: string }[];
};

/** A signed-in API client (cookie session plus its CSRF token), like the browser uses. */
export class Api {
    readonly ctx: APIRequestContext;
    readonly csrf: string;

    constructor(ctx: APIRequestContext, csrf: string) {
        this.ctx = ctx;
        this.csrf = csrf;
    }

    static async signIn(baseURL: string, username: string, password: string): Promise<Api> {
        const ctx = await request.newContext({ baseURL });
        const res = await ctx.post("/auth/login", { data: { username, password } });
        expect(res.status(), await res.text()).toBe(200);
        const me = await (await ctx.get("/api/v1/me")).json();
        return new Api(ctx, me.csrf);
    }

    private async call(method: string, url: string, data?: unknown) {
        const res = await this.ctx.fetch(url, {
            method,
            headers: { "x-csrf-token": this.csrf, ...(data !== undefined ? { "content-type": "application/json" } : {}) },
            ...(data !== undefined ? { data } : {}),
        });
        const text = await res.text();
        if (!res.ok()) throw new Error(`${method} ${url}: ${res.status()} ${text}`);
        return text ? JSON.parse(text) : null;
    }

    get = (url: string) => this.call("GET", url);
    post = (url: string, data: unknown = {}) => this.call("POST", url, data);
    patch = (url: string, data: unknown) => this.call("PATCH", url, data);
    put = (url: string, data: unknown) => this.call("PUT", url, data);
    delete = (url: string, data?: unknown) => this.call("DELETE", url, data);
}

let counter = 0;
/** A name no other test uses (tests share one server). */
export const unique = (prefix: string) =>
    `${prefix}-${process.pid.toString(36)}${(counter++).toString(36)}${Date.now().toString(36).slice(-4)}`;

/** A local account that has already chosen its own password. */
export async function createUser(admin: Api, baseURL: string, username: string): Promise<Api> {
    const created = await admin.post("/api/v1/instance/users", { username });
    const temp = created.password as string;
    const user = await Api.signIn(baseURL, username, temp);
    await user.post("/api/v1/me/password", { current: temp, password: PASSWORD });
    return user;
}

/** An organisation with a project and the fixture report uploaded to main. */
export async function seedProject(api: Api, opts: { ws?: string; project?: string } = {}) {
    const ws = opts.ws ?? unique("org");
    const project = opts.project ?? "app";
    if (!opts.ws) await api.post("/api/v1/workspaces", { slug: ws, name: `Org ${ws}` });
    await api.post(`/api/v1/w/${ws}/projects`, { slug: project, name: "App", repoUrl: "https://github.com/example/app" });
    await api.post(`/api/v1/w/${ws}/p/${project}/reports`, { branch: "main", fileName: "code_review.json", report: REPORT });
    return { ws, project };
}

/** Sign the page's browser context in (the cookie is shared with the page). */
export async function signInPage(page: Page, username: string, password: string) {
    const res = await page.request.post("/auth/login", { data: { username, password } });
    expect(res.status(), await res.text()).toBe(200);
}

type Fixtures = { admin: Api; cspViolations: string[] };

export const test = base.extend<Fixtures>({
    admin: async ({ baseURL }, use) => {
        const api = await Api.signIn(baseURL as string, ADMIN_USER, ADMIN_PASSWORD);
        await use(api);
        await api.ctx.dispose();
    },
    // Runs for every test: any CSP violation, from any page the test visits, fails it.
    cspViolations: [
        async ({ page }, use) => {
            const violations: string[] = [];
            await page.exposeFunction("__reportCspViolation", (text: string) => violations.push(text));
            await page.addInitScript(() => {
                document.addEventListener("securitypolicyviolation", (e) => {
                    (window as unknown as { __reportCspViolation(t: string): void }).__reportCspViolation(
                        `${e.violatedDirective} blocked ${e.blockedURI || "inline"} (${e.sourceFile}:${e.lineNumber})`,
                    );
                });
            });
            page.on("console", (msg) => {
                if (msg.type() === "error" && /Content Security Policy|Refused to (apply|load|execute)/i.test(msg.text()))
                    violations.push(msg.text());
            });
            await use(violations);
            expect(violations, "Content Security Policy violations").toEqual([]);
        },
        { auto: true },
    ],
});

export { expect };
