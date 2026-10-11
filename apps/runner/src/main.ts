// Start a runner: read the configuration, answer health checks if asked to, and ask the server for work
// until stopped.

import { createServer } from "node:http";
import { configureLog, flushLogs, log } from "../../../packages/shared/src/log.ts";
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

configureLog({ ...config.log, base: { service: "runner", runner: config.name } });

/** Say why, wait for the line to reach the server, and stop: whatever supervises the runner starts it again. */
async function fail(msg: string, err?: unknown, fields: Record<string, unknown> = {}): Promise<never> {
    log.error(msg, { ...(err === undefined ? {} : { err }), ...fields });
    await flushLogs();
    process.exit(1);
}
// Something nothing was ready for: the process can't be trusted to carry on, so it's reported and stopped.
process.on("uncaughtException", (err) => void fail("Stopped by an error nothing caught", err, { unhandled: true }));
process.on("unhandledRejection", (err) => void fail("Stopped by a failure nothing handled", err, { unhandled: true }));

for (const warning of config.warnings) log.warn(warning);

// A git too old to read .gitattributes from the base commit would let a pull request hide its changes.
const gitVersion = await requireGit(config.gitBin, config.path).catch((err: unknown) => fail("Not starting: git can't be used", err));

const version = await start(config.ocrBin, ["--version"], { env: { PATH: config.path, OCR_NO_UPDATE: "1" }, timeoutMs: 15_000 }).done;
if (version.code !== 0)
    log.error("Couldn't run Open Code Review: reviews will fail until it's installed", {
        bin: config.ocrBin,
        reason: version.stderr.trim().slice(0, 300) || `exit ${version.code}`,
    });

const runner = new Runner(config);
runner.start();
log.info("Started", {
    id: runner.id,
    server: new URL(config.serverUrl).origin,
    concurrency: config.concurrency,
    modelParallelism: config.modelParallelism,
    git: gitVersion,
    ocr: version.code === 0 ? (version.stdout.trim().split("\n")[0] ?? "") : "unavailable",
    node: process.version,
    version: /^[\w.+-]{1,64}$/.test(process.env.TRIAGENT_VERSION ?? "") ? process.env.TRIAGENT_VERSION : undefined,
});

if (config.healthPort) {
    createServer((req, res) => {
        const ok = req.url === "/healthz";
        res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(ok ? { status: "ok", running: runner.running } : { error: "Not found" }));
    })
        .on("error", (err) => void fail("Not starting: can't answer health checks", err, { port: config.healthPort }))
        .listen(config.healthPort, "127.0.0.1");
}

// The first signal lets the reviews in hand finish (unless RUNNER_STOP=cancel); a second stops them now. Whatever
// stops the runner must give it the time: `docker stop` kills after ten seconds unless told to wait longer
// (stop_grace_period in Compose).
let signals = 0;
const cancel = () => {
    log.info("Stopping: reviews in progress are stopped and reported as such", { running: runner.running });
    setTimeout(() => process.exit(0), 20_000).unref();
    // stop() sends the runner's last lines to the server itself, once the reviews have been stopped.
    void runner.stop().finally(() => process.exit(0));
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        signals++;
        if (signals > 1 || config.stopMode === "cancel" || !runner.running) return cancel();
        log.info("Asked to stop: finishing the reviews in hand first. A second signal stops them now.", {
            signal,
            running: runner.running,
        });
        // drain() sends the runner's last lines to the server itself, once its reviews have finished.
        void runner.drain().finally(() => process.exit(0));
    });
}
