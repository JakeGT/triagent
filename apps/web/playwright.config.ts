// End-to-end tests: the real server, started from source on a free port, serving the built web app
// (run `pnpm build:web` first; `pnpm test:e2e` from the repository root does both).

import net from "node:net";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./e2e/constants";

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
const port = Number(process.env.E2E_PORT);
const origin = `http://127.0.0.1:${port}`;

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
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } } }],
    webServer: {
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
            WEB_DIST_DIR: path.resolve(import.meta.dirname, "dist"),
        },
    },
});
