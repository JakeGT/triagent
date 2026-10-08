// End-to-end tests: the real server, started from source on a free port, serving the built web app
// (run `pnpm build:web` first; `pnpm test:e2e` from the repository root does both). Most tests use
// passwords (AUTH_MODE=local); oidc.spec.ts runs against a second server signing in through a fake
// OpenID provider (apps/server/test/fake-oidc-server.ts), on a different host name so the trip there
// and back is cross-site, as it is in production.

import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, OIDC_CLIENT_SECRET } from "./e2e/constants";

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

// Workers load this file again: they inherit the port chosen by the runner through the environment.
process.env.E2E_PORT ??= String(await freePort());
process.env.E2E_OIDC_PORT ??= String(await freePort());
process.env.E2E_PROVIDER_PORT ??= String(await freePort());
process.env.E2E_GITHUB_PORT ??= String(await freePort());
process.env.E2E_RUNNER_PORT ??= String(await freePort());
process.env.E2E_TUTORIAL_PORT ??= String(await freePort());
// Made up for each run: shared by the end-to-end server and its runner.
process.env.E2E_RUNNER_SECRET ??= randomBytes(32).toString("base64url");
const RUNNER_SECRET = process.env.E2E_RUNNER_SECRET;
const port = Number(process.env.E2E_PORT);
const origin = `http://127.0.0.1:${port}`;
const oidcOrigin = `http://127.0.0.1:${process.env.E2E_OIDC_PORT}`;
// The first-run tutorial starts by itself only on its own server: elsewhere accounts start with it done.
const tutorialOrigin = `http://127.0.0.1:${process.env.E2E_TUTORIAL_PORT}`;
// The provider is on "localhost": another site from the app's 127.0.0.1, as a real provider would be.
const issuer = `http://localhost:${process.env.E2E_PROVIDER_PORT}/application/o/triagent/`;
process.env.E2E_PROVIDER_ISSUER = issuer;
// Reviews: a fake GitHub (API, app pages and git), and a runner using a fake `ocr`.
const github = `http://127.0.0.1:${process.env.E2E_GITHUB_PORT}`;
process.env.E2E_GITHUB_URL = github;

export default defineConfig({
    testDir: "e2e",
    outputDir: "test-results",
    fullyParallel: false,
    workers: process.env.CI ? 2 : 3,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
    timeout: 30_000,
    expect: { timeout: 7_000 },
    use: {
        baseURL: origin,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [
        {
            name: "chromium",
            testIgnore: /(oidc|tutorial)\.spec\.ts/,
            use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } },
        },
        {
            name: "oidc",
            testMatch: /oidc\.spec\.ts/,
            use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 }, baseURL: oidcOrigin },
        },
        {
            name: "tutorial",
            testMatch: /tutorial\.spec\.ts/,
            use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 }, baseURL: tutorialOrigin },
        },
    ],
    webServer: [
        {
            command: "node ../server/src/main.ts",
            cwd: import.meta.dirname,
            url: `${origin}/healthz`,
            reuseExistingServer: false,
            timeout: 30_000,
            stdout: "ignore",
            stderr: "pipe",
            env: {
                HOST: "127.0.0.1",
                PORT: String(port),
                PUBLIC_ORIGIN: origin,
                COOKIE_SECURE: "false",
                TRIAGENT_ADMIN_USER: ADMIN_USER,
                TRIAGENT_ADMIN_PASSWORD: ADMIN_PASSWORD,
                REQUESTS_PER_MINUTE: "100000",
                // Never reach OpenRouter from tests: the catalogue is served by the tests that need it.
                OPENROUTER_CATALOGUE: "false",
                WEB_DIST_DIR: path.resolve(import.meta.dirname, "dist"),
                GITHUB_API_URL: `${github}/api`,
                GITHUB_URL: github,
                TRIAGENT_RUNNER_SECRET: RUNNER_SECRET,
                REVIEW_CONCURRENCY: "4",
                // The model provider tests serve a fake provider on 127.0.0.1 (providers.spec.ts).
                ALLOW_PRIVATE_MODEL_URLS: "true",
                // Test accounts start with the tutorial done; tutorial.spec.ts has a server of its own.
                TUTORIAL_AUTO_START: "false",
            },
        },
        {
            command: "node ../server/src/main.ts",
            cwd: import.meta.dirname,
            url: `${tutorialOrigin}/healthz`,
            reuseExistingServer: false,
            timeout: 30_000,
            stdout: "ignore",
            stderr: "pipe",
            env: {
                HOST: "127.0.0.1",
                PORT: String(process.env.E2E_TUTORIAL_PORT),
                PUBLIC_ORIGIN: tutorialOrigin,
                COOKIE_SECURE: "false",
                TRIAGENT_ADMIN_USER: ADMIN_USER,
                TRIAGENT_ADMIN_PASSWORD: ADMIN_PASSWORD,
                REQUESTS_PER_MINUTE: "100000",
                OPENROUTER_CATALOGUE: "false",
                WEB_DIST_DIR: path.resolve(import.meta.dirname, "dist"),
            },
        },
        {
            command: "node ../../tests/fakes/github-server.ts",
            cwd: import.meta.dirname,
            url: `${github}/_fake/health`,
            reuseExistingServer: false,
            timeout: 30_000,
            stdout: "ignore",
            stderr: "pipe",
            env: { FAKE_GITHUB_PORT: String(process.env.E2E_GITHUB_PORT) },
        },
        {
            command: "node ../runner/src/main.ts",
            cwd: import.meta.dirname,
            url: `http://127.0.0.1:${process.env.E2E_RUNNER_PORT}/healthz`,
            reuseExistingServer: false,
            timeout: 30_000,
            stdout: "ignore",
            stderr: "pipe",
            env: {
                TRIAGENT_SERVER_URL: origin,
                TRIAGENT_RUNNER_SECRET: RUNNER_SECRET,
                RUNNER_NAME: "e2e-runner",
                RUNNER_CONCURRENCY: "4",
                RUNNER_POLL_SECONDS: "1",
                RUNNER_HEALTH_PORT: String(process.env.E2E_RUNNER_PORT),
                OCR_BIN: path.resolve(import.meta.dirname, "../../tests/fakes/ocr.ts"),
            },
        },
        {
            command: "node ../server/test/fake-oidc-server.ts",
            cwd: import.meta.dirname,
            url: `${issuer}.well-known/openid-configuration`,
            reuseExistingServer: false,
            timeout: 30_000,
            stdout: "ignore",
            stderr: "pipe",
            env: {
                FAKE_OIDC_PORT: String(process.env.E2E_PROVIDER_PORT),
                FAKE_OIDC_ISSUER: issuer,
                FAKE_OIDC_REDIRECT_URI: `${oidcOrigin}/auth/callback`,
                FAKE_OIDC_CLIENT_SECRET: OIDC_CLIENT_SECRET,
            },
        },
        {
            command: "node ../server/src/main.ts",
            cwd: import.meta.dirname,
            url: `${oidcOrigin}/healthz`,
            reuseExistingServer: false,
            timeout: 30_000,
            stdout: "ignore",
            stderr: "pipe",
            env: {
                HOST: "127.0.0.1",
                PORT: String(process.env.E2E_OIDC_PORT),
                PUBLIC_ORIGIN: oidcOrigin,
                COOKIE_SECURE: "false",
                AUTH_MODE: "oidc",
                OIDC_ISSUER: issuer,
                OIDC_CLIENT_ID: "triagent",
                OIDC_CLIENT_SECRET,
                OIDC_PROVIDER_NAME: "Test ID",
                TUTORIAL_AUTO_START: "false",
                INVITE_HINT: "Ask the administrator to add your address to the sign-in allowlist.",
                REQUESTS_PER_MINUTE: "100000",
                // Never reach OpenRouter from tests: the catalogue is served by the tests that need it.
                OPENROUTER_CATALOGUE: "false",
                WEB_DIST_DIR: path.resolve(import.meta.dirname, "dist"),
            },
        },
    ],
});
