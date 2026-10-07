// Start the server: read the configuration, open the store, create the first admin if needed, listen.

import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createServices } from "./services/index.ts";
import { MemoryStore } from "./store/memory.ts";

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

// Postgres arrives in the next phase; until then everything is kept in memory and lost on restart.
const store = new MemoryStore();
console.warn("Using the in-memory store: nothing is kept when the server stops.");
const services = createServices(config, store);
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
    console.warn("No accounts yet. Set TRIAGENT_ADMIN_USER and TRIAGENT_ADMIN_PASSWORD (or _FILE) and restart.");

const { app } = createApp(services);
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    const host = info.address.includes(":") ? `[${info.address}]` : info.address;
    console.log(`Triagent listening on http://${host}:${info.port} (public address ${config.publicOrigin})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
