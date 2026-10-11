// The logger (packages/shared/src/log.ts): what a line looks like, what never gets into one, and what
// sinks are handed.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
    addLogSink,
    captureLog,
    configureLog,
    formatText,
    type LogLevel,
    type LogRecord,
    log,
    logError,
    logOptionsFromEnv,
    relayLog,
    setLogContext,
} from "@triagent/shared/log";

describe("the logger", () => {
    let lines: { level: LogLevel; line: string }[];
    let restore: () => void;
    let records: LogRecord[];
    let removeSink: () => void;

    beforeEach(() => {
        lines = [];
        records = [];
        restore = captureLog((level, line) => lines.push({ level, line }));
        removeSink = addLogSink({ write: (r) => records.push(r) });
        configureLog({ level: "info", format: "text", base: { service: "test" } });
    });
    afterEach(() => {
        restore();
        removeSink();
        setLogContext(null);
        configureLog({ level: "warn", format: "text", base: {} });
    });

    test("a line has its time, level, message and fields, with values that could run on quoted", () => {
        log.info("Review queued", { run: "job-1", pr: 12, note: "two words", gone: undefined, none: null });
        assert.equal(lines.length, 1);
        assert.match(lines[0]?.line ?? "", /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO {2}Review queued run=job-1 pr=12 note="two words" none=null$/);
    });

    test("a line can't be made to look like two: new lines in a message or a value are written out", () => {
        log.warn("Failed sign-in\n2026-01-01T00:00:00.000Z INFO  Signed in user=admin", { ip: "1.2.3.4\nERROR forged" });
        assert.equal(lines.length, 1);
        assert.equal(lines[0]?.line.includes("\n"), false);
        assert.match(lines[0]?.line ?? "", /Failed sign-in\\n2026/);
        assert.match(lines[0]?.line ?? "", /ip="1\.2\.3\.4\\nERROR forged"/);
    });

    test("credentials are taken out of messages, values and errors, and fields named for one are never printed", () => {
        const token = "ghp_abcdefghijklmnopqrstuvwxyz012345";
        log.error(`Fetching with ${token} failed`, {
            url: `https://x-access-token:${token}@github.com/acme/app.git`,
            password: "correct horse",
            apiKey: "sk-live-1",
            runnerSecret: "s3cret",
            authorization: "Bearer abc",
            tokens: 1234,
            err: new Error(`remote said: Authorization: Bearer ${token}`),
        });
        const all = JSON.stringify([lines, records]);
        for (const never of [token, "correct horse", "sk-live-1", "s3cret", "Bearer abc"]) assert.equal(all.includes(never), false, never);
        // A count of tokens is a figure, not a credential.
        assert.equal(records[0]?.fields.tokens, 1234);
        assert.equal(records[0]?.fields.password, "[redacted]");
    });

    test("a credential inside an object, or under any name that says it is one, is taken out; figures are kept", () => {
        log.info("Settings saved", {
            change: { provider: "openai", apiKey: "sk-live-nested", nested: [{ refresh_tokens: ["rt-1"], maxTokens: 4000 }] },
            sessionId: "sess-123",
            auth_tokens: "at-1",
            tokensUsed: 250,
        });
        const all = JSON.stringify([lines, records]);
        for (const never of ["sk-live-nested", "rt-1", "sess-123", "at-1"]) assert.equal(all.includes(never), false, never);
        assert.equal(records[0]?.fields.tokensUsed, 250);
        assert.match(String(records[0]?.fields.change), /"provider":"openai".*"maxTokens":4000/);
    });

    test("a field can't pass itself off as part of a JSON line", () => {
        configureLog({ format: "json" });
        log.info("Real message", { msg: "forged", level: "error", time: "never" });
        const line = JSON.parse(lines[0]?.line ?? "{}");
        assert.deepEqual([line.msg, line.level, line._msg, line._level], ["Real message", "info", "forged", "error"]);
        assert.notEqual(line.time, "never");
    });

    test("an error's stack is printed for an error, and only its message for a warning", () => {
        const err = new TypeError("x is not a function");
        log.warn("Couldn't reach GitHub", { err });
        log.error("Request failed", { err });
        assert.equal(lines[0]?.line.includes("\n"), false);
        assert.match(lines[0]?.line ?? "", /WARN {2}Couldn't reach GitHub: x is not a function$/);
        assert.match(lines[1]?.line ?? "", /ERROR Request failed: x is not a function\n\s+at /);
        assert.equal(records[1]?.error?.name, "TypeError");
        assert.match(records[1]?.error?.stack ?? "", /log\.test\.ts/);
    });

    test("what was thrown is written down whatever it was, with what caused it", () => {
        assert.deepEqual(logError("just a string"), { name: "Thrown", message: "just a string" });
        assert.equal(logError({ odd: true }).message, '{"odd":true}');
        const e = logError(Object.assign(new Error("outer", { cause: new Error("inner") }), { code: "ECONNRESET" }));
        assert.equal(e.code, "ECONNRESET");
        assert.equal(e.cause?.message, "inner");
        // Something that can't be written as JSON, and something that never ends.
        log.info("Odd value", { odd: { big: 1n } });
        assert.equal(records.at(-1)?.fields.odd, "[unprintable]");
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        log.info("Odd value", { loop });
        assert.match(String(records.at(-1)?.fields.loop), /\[redacted\]/);
    });

    test("LOG_LEVEL decides what's printed; sinks get everything but debug lines", () => {
        configureLog({ level: "warn" });
        log.debug("Detail");
        log.info("Listening");
        log.warn("Careful");
        assert.deepEqual(
            lines.map((l) => l.level),
            ["warn"],
        );
        assert.deepEqual(
            records.map((r) => r.msg),
            ["Listening", "Careful"],
        );
    });

    test("LOG_FORMAT=json prints one object a line, with which program wrote it", () => {
        configureLog({ format: "json" });
        log.error("Request failed", { request: "abc", err: new Error("boom") });
        const line = JSON.parse(lines[0]?.line ?? "{}");
        assert.equal(lines[0]?.line.includes("\n"), false);
        assert.deepEqual(
            { level: line.level, msg: line.msg, service: line.service, request: line.request, error: line.error.message },
            { level: "error", msg: "Request failed", service: "test", request: "abc", error: "boom" },
        );
        assert.match(line.error.stack, /log\.test\.ts/);
    });

    test("lines carry the fields of the request they were written in, and of the logger they came from", () => {
        setLogContext(() => ({ request: "req-1", user: undefined }));
        log.child({ run: "job-9" }).info("Review started", { models: 2 });
        assert.deepEqual(records[0]?.fields, { service: "test", request: "req-1", run: "job-9", models: 2 });
        // Which program it is goes to sinks and JSON, not onto every line a person reads.
        assert.equal(lines[0]?.line.includes("service="), false);
    });

    test("a sink that throws, or a context that does, doesn't stop the line or the program", () => {
        const remove = addLogSink({
            write() {
                throw new Error("sink down");
            },
        });
        setLogContext(() => {
            throw new Error("no context");
        });
        log.info("Still here");
        remove();
        assert.equal(lines.length, 1);
        assert.equal(records.length, 1);
    });

    test("another program's line goes to the sinks as it is, without being printed again", () => {
        relayLog(
            { time: "2026-01-01T00:00:00.000Z", level: "error", msg: "Lost a lock", fields: { service: "server" } },
            { service: "runner" },
        );
        assert.equal(lines.length, 0);
        assert.deepEqual(records[0]?.fields, { service: "runner" });
    });

    test("LOG_LEVEL and LOG_FORMAT are checked", () => {
        assert.deepEqual(logOptionsFromEnv({}), { level: "info", format: "text" });
        assert.deepEqual(logOptionsFromEnv({ LOG_LEVEL: "debug", LOG_FORMAT: "json" }), { level: "debug", format: "json" });
        assert.throws(() => logOptionsFromEnv({ LOG_LEVEL: "verbose" }), /LOG_LEVEL must be one of/);
        assert.throws(() => logOptionsFromEnv({ LOG_FORMAT: "xml" }), /LOG_FORMAT must be/);
    });

    test("long values are cut, saying so", () => {
        const text = formatText({ time: "t", level: "info", msg: "m", fields: { a: "x" }, error: { name: "E", message: "why" } });
        assert.equal(text, "t INFO  m: why a=x");
        log.info("Big", { blob: "y".repeat(5000) });
        assert.match(String(records.at(-1)?.fields.blob), /^y{2000}… \(3000 more characters\)$/);
    });
});
