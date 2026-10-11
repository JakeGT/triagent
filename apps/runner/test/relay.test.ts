// The runner's log lines on their way to the server (relay.ts): sent in batches, kept while the server
// is away, and dropped quietly when the server has no use for them.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { LogRecord } from "../../../packages/shared/src/log.ts";
import { loadConfig } from "../src/config.ts";
import { LogRelay } from "../src/relay.ts";

const line = (msg: string, level: LogRecord["level"] = "info"): LogRecord => ({ time: "2026-01-01T00:00:00.000Z", level, msg, fields: {} });

describe("passing the runner's log lines to the server", () => {
    test("lines are sent together, in order, a hundred at a time", async () => {
        const batches: string[][] = [];
        const relay = new LogRelay(async (records) => {
            batches.push(records.map((r) => r.msg));
            return { wanted: true };
        });
        for (let i = 0; i < 150; i++) relay.write(line(`line ${i}`));
        await relay.flush(1000);
        assert.deepEqual(
            batches.map((b) => b.length),
            [100, 50],
        );
        assert.equal(batches[1]?.[49], "line 149");
    });

    test("an error doesn't wait for company", async () => {
        const sent: string[] = [];
        const relay = new LogRelay(async (records) => {
            sent.push(...records.map((r) => r.msg));
            return { wanted: true };
        });
        relay.write(line("Lost a lock", "error"));
        await sleep(300);
        assert.deepEqual(sent, ["Lost a lock"]);
    });

    test("while the server is away the lines are kept (the newest 500), and sent once it's back", async () => {
        let up = false;
        const sent: string[] = [];
        const relay = new LogRelay(async (records) => {
            if (!up) throw Object.assign(new Error("Couldn't reach the server"), { status: 0 });
            sent.push(...records.map((r) => r.msg));
            return { wanted: true };
        });
        for (let i = 0; i < 600; i++) relay.write(line(`line ${i}`));
        await relay.flush(1000);
        assert.deepEqual(sent, []);
        up = true;
        for (let i = 0; i < 6; i++) await relay.flush(1000);
        assert.equal(sent.length, 500);
        assert.equal(sent[0], "line 100");
        assert.equal(sent.at(-1), "line 599");
    });

    test("a server with nowhere to send them, or too old to take them, isn't sent more for a while", async () => {
        for (const answer of [
            async () => ({ wanted: false }),
            async () => Promise.reject(Object.assign(new Error("Nothing at POST"), { status: 404 })),
        ]) {
            let calls = 0;
            let now = 1_000_000;
            const relay = new LogRelay(
                async () => {
                    calls++;
                    return answer();
                },
                () => now,
            );
            relay.write(line("one"));
            await relay.flush(1000);
            relay.write(line("two"));
            await relay.flush(1000);
            assert.equal(calls, 1);
            // Asked again later: the server may have been set up to report by then.
            now += 11 * 60_000;
            relay.write(line("three"));
            await relay.flush(1000);
            assert.equal(calls, 2);
        }
    });

    test("flush gives up after its time, rather than hold up the runner stopping", async () => {
        const relay = new LogRelay(() => new Promise(() => {}));
        relay.write(line("stuck"));
        const began = Date.now();
        await relay.flush(100);
        assert.ok(Date.now() - began < 1000);
    });
});

describe("the runner's logging settings", () => {
    const base = { TRIAGENT_SERVER_URL: "http://server:8080", TRIAGENT_RUNNER_SECRET: "s".repeat(40) };

    test("lines go to the server unless told otherwise", () => {
        assert.deepEqual([loadConfig(base).relayLogs, loadConfig(base).log], [true, { level: "info", format: "text" }]);
        assert.equal(loadConfig({ ...base, RUNNER_RELAY_LOGS: "false" }).relayLogs, false);
        assert.deepEqual(loadConfig({ ...base, LOG_LEVEL: "debug", LOG_FORMAT: "json" }).log, { level: "debug", format: "json" });
    });

    test("mistakes are said plainly", () => {
        assert.throws(() => loadConfig({ ...base, RUNNER_RELAY_LOGS: "yes" }), /RUNNER_RELAY_LOGS must be true or false/);
        assert.throws(() => loadConfig({ ...base, LOG_LEVEL: "loud" }), /LOG_LEVEL must be one of/);
    });
});
