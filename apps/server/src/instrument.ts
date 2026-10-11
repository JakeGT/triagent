// Loaded before the server itself (node --import ./src/instrument.ts src/main.ts), so that error and
// trace reporting is in place before the code it watches is loaded. Does nothing unless SENTRY_DSN is set.

import { ConfigError, telemetryConfig } from "./config.ts";

try {
    const telemetry = telemetryConfig();
    // Loaded only when it's used: without a DSN the SDK is never even read from disk.
    if (telemetry) (await import("./telemetry.ts")).startTelemetry(telemetry);
} catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
}
