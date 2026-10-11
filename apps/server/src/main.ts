// Start the server: read the configuration, open the store (migrating the database), create the first
// admin if needed, listen.

import { serve } from "@hono/node-server";
import { configureLog, flushLogs, log } from "@triagent/shared/log";
import { createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createServices } from "./services/index.ts";
import { MemoryStore } from "./store/memory.ts";
import { PostgresStore } from "./store/postgres.ts";
import type { Store } from "./store/types.ts";

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
configureLog({ ...config.log, base: { service: "server" } });

/** Say why, wait for the line to be sent on, and stop: whatever supervises the server starts it again. */
async function fail(msg: string, err?: unknown, fields: Record<string, unknown> = {}): Promise<never> {
    log.error(msg, { ...(err === undefined ? {} : { err }), ...fields });
    await flushLogs();
    process.exit(1);
}
// Something nothing was ready for: the process can't be trusted to carry on, so it's reported and stopped.
process.on("uncaughtException", (err) => void fail("Stopped by an error nothing caught", err, { unhandled: true }));
process.on("unhandledRejection", (err) => void fail("Stopped by a failure nothing handled", err, { unhandled: true }));

log.info("Starting", {
    version: config.version,
    node: process.version,
    auth: config.authMode,
    reporting: config.telemetry ? (config.telemetry.browserDsn ? "server, runners and browsers" : "server and runners") : "off",
});

let store: Store;
if (config.databaseUrl) {
    const schema = config.databaseSchema ? { schema: config.databaseSchema } : {};
    const pg = new PostgresStore(config.databaseUrl, schema);
    try {
        const applied = await migrate(pg.sql, schema);
        if (applied.length) log.info("Applied database migrations", { migrations: applied.join(", ") });
    } catch (err) {
        await pg.close().catch(() => {});
        await fail("Couldn't prepare the database", err);
    }
    store = pg;
} else {
    store = new MemoryStore();
    log.warn("Using the in-memory store: nothing is kept when the server stops. Set DATABASE_URL to keep data.");
}
const services = createServices(config, store);
// Live updates reach subscribers on every server process sharing the database.
if (store instanceof PostgresStore) {
    try {
        await services.events.connect(store.relay());
    } catch (err) {
        await store.close().catch(() => {});
        await fail("Couldn't listen for live updates from other server processes", err);
    }
}
if (!config.secretsKey)
    log.warn(
        "No TRIAGENT_SECRETS_KEY: secrets are encrypted with a throwaway key, so they can't be read after a restart. Fine for development only.",
    );

try {
    const admin = await services.accounts.bootstrap();
    if (admin) log.info("Created the instance admin from TRIAGENT_ADMIN_USER", { username: admin.username });
} catch (err) {
    log.error("Couldn't create the admin from TRIAGENT_ADMIN_USER and TRIAGENT_ADMIN_PASSWORD", { err });
}
if ((await store.users.count()) === 0)
    log.warn(
        config.oidc
            ? `No accounts yet. The first person to sign in through ${config.oidc.providerName} gets one; members of "${config.oidc.adminGroup}" are instance admins.`
            : "No accounts yet. Set TRIAGENT_ADMIN_USER and TRIAGENT_ADMIN_PASSWORD (or _FILE) and restart.",
    );

const { app } = createApp(services);
// Automatic reviews (one process polls GitHub at a time), and reviews whose runner stopped responding.
services.automation.start();
// One sweep at a time: a slow one isn't joined by the next.
let sweeping = false;
const sweep = () => {
    if (sweeping) return;
    sweeping = true;
    void services.runs
        .sweep()
        .catch((err: unknown) => log.error("Checking for reviews whose runner stopped answering failed", { err }))
        .finally(() => {
            sweeping = false;
        });
};
const sweeper = setInterval(sweep, 15_000);
sweeper.unref();
sweep();
if (!config.runnerSecret) log.warn("No TRIAGENT_RUNNER_SECRET: no runner can connect, so reviews stay queued.");
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    const host = info.address.includes(":") ? `[${info.address}]` : info.address;
    log.info("Listening", { address: `http://${host}:${info.port}`, publicOrigin: config.publicOrigin });
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        // Once: a second signal mustn't close the server and store again.
        if (stopping) return;
        stopping = true;
        log.info("Stopping", { signal });
        clearInterval(sweeper);
        services.automation.stop();
        server.close(() => {
            // What's in hand for GitHub (a status, a comment) gets to finish, within the three seconds below.
            void services.runs
                .settled()
                .then(() => Promise.allSettled([store.close(), flushLogs()]))
                .finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
