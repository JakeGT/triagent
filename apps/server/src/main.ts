// Start the server: read the configuration, open the store (migrating the database), create the first
// admin if needed, listen.

import { serve } from "@hono/node-server";
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

let store: Store;
if (config.databaseUrl) {
    const schema = config.databaseSchema ? { schema: config.databaseSchema } : {};
    const pg = new PostgresStore(config.databaseUrl, schema);
    try {
        const applied = await migrate(pg.sql, schema);
        if (applied.length) console.log(`Applied database migrations: ${applied.join(", ")}.`);
    } catch (err) {
        console.error(`Couldn't prepare the database: ${(err as Error).message}`);
        await pg.close().catch(() => {});
        process.exit(1);
    }
    store = pg;
} else {
    store = new MemoryStore();
    console.warn("Using the in-memory store: nothing is kept when the server stops. Set DATABASE_URL to keep data.");
}
const services = createServices(config, store);
// Live updates reach subscribers on every server process sharing the database.
if (store instanceof PostgresStore) await services.events.connect(store.relay());
if (!config.secretsKey)
    console.warn(
        "No TRIAGENT_SECRETS_KEY: secrets are encrypted with a throwaway key, so they can't be read after a restart. Fine for development only.",
    );

try {
    const admin = await services.accounts.bootstrap();
    if (admin) console.log(`Created instance admin "${admin.username}" from TRIAGENT_ADMIN_USER.`);
} catch (err) {
    console.error(`Couldn't create the admin from TRIAGENT_ADMIN_USER/TRIAGENT_ADMIN_PASSWORD: ${(err as Error).message}`);
}
if ((await store.users.count()) === 0)
    console.warn(
        config.oidc
            ? `No accounts yet. The first person to sign in through ${config.oidc.providerName} gets one; members of "${config.oidc.adminGroup}" are instance admins.`
            : "No accounts yet. Set TRIAGENT_ADMIN_USER and TRIAGENT_ADMIN_PASSWORD (or _FILE) and restart.",
    );

const { app } = createApp(services);
// Automatic reviews (one process polls GitHub at a time), and reviews whose runner stopped responding.
services.automation.start();
const sweeper = setInterval(
    () => void services.runs.sweep().catch((err: Error) => console.error(`Checking review leases: ${err.message}`)),
    15_000,
);
sweeper.unref();
void services.runs.sweep().catch(() => {});
if (!config.runnerSecret) console.warn("No TRIAGENT_RUNNER_SECRET: no runner can connect, so reviews stay queued.");
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    const host = info.address.includes(":") ? `[${info.address}]` : info.address;
    console.log(`Triagent listening on http://${host}:${info.port} (public address ${config.publicOrigin})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        services.automation.stop();
        server.close(() => {
            store.close().finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
