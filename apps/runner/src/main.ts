// Start a runner: read the configuration, answer health checks if asked to, and ask the server for work
// until stopped.

import { createServer } from "node:http";
import { ConfigError, loadConfig } from "./config.ts";
import { requireGit } from "./git.ts";
import { start } from "./process.ts";
import { Runner } from "./runner.ts";

let config: ReturnType<typeof loadConfig>;
try {
    config = loadConfig();
} catch (err) {
    if (err instanceof ConfigError) {
        console.error(`Configuration error: ${err.message}`);
        process.exit(1);
    }
    throw err;
}

// A git too old to read .gitattributes from the base commit would let a pull request hide its changes.
let gitVersion: string;
try {
    gitVersion = await requireGit(config.gitBin, config.path);
} catch (err) {
    console.error(`Not starting: ${(err as Error).message}`);
    process.exit(1);
}

const version = await start(config.ocrBin, ["--version"], { env: { PATH: config.path, OCR_NO_UPDATE: "1" }, timeoutMs: 15_000 }).done;
if (version.code !== 0)
    console.warn(
        `Couldn't run ${config.ocrBin} --version: ${version.stderr.trim() || `exit ${version.code}`}. Reviews will fail until it's installed.`,
    );

const runner = new Runner(config);
runner.start();
console.log(
    `Triagent runner ${config.name} (${runner.id}) working for ${config.serverUrl}, ${config.concurrency} at a time, with ${gitVersion}${version.code === 0 ? ` and ${version.stdout.trim().split("\n")[0]}` : ""}.`,
);

if (config.healthPort) {
    createServer((req, res) => {
        const ok = req.url === "/healthz";
        res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(ok ? { status: "ok", running: runner.running } : { error: "Not found" }));
    }).listen(config.healthPort, "127.0.0.1");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        console.log("Stopping: reviews in progress are stopped and reported as such.");
        setTimeout(() => process.exit(0), 20_000).unref();
        void runner.stop().finally(() => process.exit(0));
    });
}
