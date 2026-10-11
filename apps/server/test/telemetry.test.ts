// Reporting to Sentry: when it's on, what is sent, and above all what isn't. Nothing here reaches
// Sentry: the SDK is given a transport that keeps what it would have sent.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import * as Sentry from "@sentry/node";
import { addLogSink, captureLog, log } from "@triagent/shared/log";
import { ConfigError, loadConfig, parseDsn, telemetryConfig } from "../src/config.ts";
import { fromOutside, withoutMessage } from "../src/failure.ts";
import { GitHubError } from "../src/services/github/client.ts";
import { scrub, scrubEvent, sentryOptions, sentrySink, withoutQuery } from "../src/telemetry.ts";
import { ORIGIN, testApp } from "./helpers.ts";

type Integration = Parameters<typeof Sentry.addIntegration>[0];
const DSN = "https://publickey@o123.ingest.sentry.io/456";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";

describe("the settings", () => {
    test("nothing is reported unless SENTRY_DSN is set", () => {
        assert.equal(telemetryConfig({}), null);
        assert.equal(loadConfig({}).telemetry, null);
    });

    test("with a DSN: the server, the runners and the web app report, logs included, no traces", () => {
        assert.deepEqual(telemetryConfig({ SENTRY_DSN: DSN, NODE_ENV: "production", TRIAGENT_VERSION: "1f0f033" }), {
            dsn: DSN,
            browserDsn: DSN,
            environment: "production",
            release: "1f0f033",
            tracesSampleRate: 0,
            logs: true,
        });
    });

    test("the web app can have a project of its own, or be left out", () => {
        const other = "https://webkey@o123.ingest.sentry.io/789";
        assert.equal(telemetryConfig({ SENTRY_DSN: DSN, SENTRY_BROWSER_DSN: other })?.browserDsn, other);
        assert.equal(telemetryConfig({ SENTRY_DSN: DSN, SENTRY_BROWSER_DSN: other, SENTRY_BROWSER: "false" })?.browserDsn, null);
    });

    test("the DSN can come from a file, like the other secrets", () => {
        const file = path.join(mkdtempSync(path.join(tmpdir(), "triagent-dsn-")), "dsn");
        writeFileSync(file, `${DSN}\n`);
        assert.equal(telemetryConfig({ SENTRY_DSN_FILE: file })?.dsn, DSN);
    });

    test("mistakes are said plainly", () => {
        assert.throws(() => telemetryConfig({ SENTRY_DSN: "not-a-dsn" }), ConfigError);
        assert.throws(() => telemetryConfig({ SENTRY_DSN: "https://o123.ingest.sentry.io/456" }), /must be a Sentry DSN/);
        assert.throws(() => telemetryConfig({ SENTRY_BROWSER_DSN: DSN }), /needs SENTRY_DSN/);
        assert.throws(() => telemetryConfig({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: "2" }), /from 0 to 1/);
        assert.throws(() => telemetryConfig({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "has spaces" }), /SENTRY_ENVIRONMENT/);
        assert.throws(() => loadConfig({ LOG_LEVEL: "loud" }), ConfigError);
    });

    test("a DSN says where its project's envelopes go", () => {
        assert.deepEqual(parseDsn(DSN), { key: "publickey", envelopeUrl: "https://o123.ingest.sentry.io/api/456/envelope/" });
        assert.deepEqual(parseDsn("http://k@sentry.internal:9000/prefix/7"), {
            key: "k",
            envelopeUrl: "http://sentry.internal:9000/prefix/api/7/envelope/",
        });
        assert.equal(parseDsn("https://k@host/not-a-number"), null);
    });
});

describe("what is taken out before anything is sent", () => {
    test("credentials, wherever they are, and anything under a key named for one", () => {
        const out = scrub({
            message: `clone https://x-access-token:${TOKEN}@github.com/a/b failed`,
            headers: { Authorization: "Bearer tri_secret", cookie: "sid=1" },
            nested: [{ apiKey: "sk-1", password: "p", csrf: "c", tokens: 99, maxTokensBudget: 5, ok: "fine" }],
        });
        const text = JSON.stringify(out);
        for (const never of [TOKEN, "tri_secret", "sid=1", "sk-1", '"p"', '"c"']) assert.equal(text.includes(never), false, never);
        assert.deepEqual(out.nested[0], {
            apiKey: "[redacted]",
            password: "[redacted]",
            csrf: "[redacted]",
            tokens: 99,
            maxTokensBudget: 5,
            ok: "fine",
        });
    });

    test("an event keeps the method and path of its request, and the account's id: nothing else about either", () => {
        const event = scrubEvent({
            request: {
                method: "POST",
                url: "https://triagent.example/auth/callback?code=one-time-code&state=xyz",
                headers: { cookie: "triagent_sid=abc", authorization: "Bearer tri_x" },
                cookies: { triagent_sid: "abc" },
                data: { password: "hunter2hunter2" },
                query_string: "code=one-time-code",
            },
            user: { id: "u1", email: "sam@example.com", username: "sam", ip_address: "203.0.113.9" },
            exception: {
                values: [
                    {
                        type: "Error",
                        value: `bad ${TOKEN}`,
                        stacktrace: { frames: [{ filename: "a.ts", vars: { password: "hunter2hunter2" } }] },
                    },
                ],
            },
            breadcrumbs: [
                { category: "http", data: { url: "https://api.github.com/x?access_token=abc", "http.query": "access_token=abc" } },
            ],
            spans: [
                {
                    description: "GET https://openrouter.ai/api/v1/models?key=abc",
                    data: {
                        "url.full": "https://openrouter.ai/api/v1/models?key=abc",
                        "client.address": "203.0.113.9",
                        "user_agent.original": "curl",
                    },
                },
            ],
            transaction: "GET /auth/callback?code=one-time-code",
            // biome-ignore lint/suspicious/noExplicitAny: an event as loose as the SDK's own can be
        } as any);
        assert.deepEqual(event.request, { method: "POST", url: "https://triagent.example/auth/callback" });
        assert.deepEqual(event.user, { id: "u1" });
        const text = JSON.stringify(event);
        for (const never of [
            "one-time-code",
            "triagent_sid",
            "hunter2",
            TOKEN,
            "sam@example.com",
            "203.0.113.9",
            "access_token",
            "key=abc",
            "curl",
        ])
            assert.equal(text.includes(never), false, never);
        assert.equal(withoutQuery("/a/b?c=d#e"), "/a/b");
    });

    test("the SDK is told to collect none of it in the first place, and its catch-alls are off", () => {
        const options = sentryOptions({ dsn: DSN, browserDsn: DSN, environment: "test", release: null, tracesSampleRate: 0, logs: true });
        assert.deepEqual(options.dataCollection, {
            userInfo: false,
            cookies: false,
            httpHeaders: false,
            httpBodies: [],
            urlQueryParams: false,
            databaseQueryData: false,
            queues: false,
            stackFrameVariables: false,
            graphQL: { document: false, variables: false },
            genAI: { inputs: false, outputs: false },
        });
        const names = (options.integrations as (d: Integration[]) => Integration[])(Sentry.getDefaultIntegrations({})).map((i) => i.name);
        for (const off of ["Console", "LocalVariablesAsync", "OnUncaughtException", "OnUnhandledRejection", "Modules", "ChildProcess"])
            assert.equal(names.includes(off), false, off);
        for (const on of ["Http", "NodeFetch", "LinkedErrors", "ContextLines"]) assert.equal(names.includes(on), true, on);
    });
});

describe("what reaches Sentry", () => {
    // What the SDK would have sent, as text: each envelope's items.
    const sent: string[] = [];
    let now = 0;
    let removeSink: () => void;
    let restore: () => void;
    const config = { dsn: DSN, browserDsn: DSN, environment: "test", release: "abc123", tracesSampleRate: 0, logs: true };

    before(() => {
        Sentry.init({
            ...sentryOptions(config),
            transport: () => ({
                send: async (envelope) => {
                    sent.push(JSON.stringify(envelope));
                    return {};
                },
                flush: async () => true,
            }),
        });
        removeSink = addLogSink(sentrySink(config, () => now));
        // The lines themselves aren't the point here.
        restore = captureLog(() => {});
    });
    after(async () => {
        removeSink();
        restore();
        await Sentry.close(1000);
    });

    const flushed = async () => {
        await Sentry.flush(2000);
        return sent.splice(0).join("\n");
    };

    test("an error line becomes an issue, with where it was logged; a warning only a log line", async () => {
        log.warn("GitHub delivery refused", { to: "acme/app", count: 3 });
        log.error("Request failed", { request: "req-1", route: "/api/v1/me", user: "u1", err: new TypeError("x is not a function") });
        const all = await flushed();
        const events = all.split("\n").filter((e) => e.includes('"type":"event"'));
        assert.equal(events.length, 1);
        assert.match(events[0] ?? "", /"type":"TypeError","value":"x is not a function"/);
        assert.match(events[0] ?? "", /"request":"req-1"/);
        assert.match(events[0] ?? "", /"user":\{"id":"u1"\}/);
        assert.match(events[0] ?? "", /"release":"abc123"/);
        assert.match(events[0] ?? "", /telemetry\.test\.ts/);
        // Both lines are logs too.
        assert.match(all, /"body":"GitHub delivery refused"/);
        assert.match(all, /"body":"Request failed"/);
    });

    test("a seeded secret never leaves, whichever way it gets into a line", async () => {
        // Put together here, so they're in what runs and not in this file's text: a report carries a few lines of
        // the source around where an error was thrown (ours, never the code under review).
        const password = ["correct", "horse", "battery", "staple"].join("-");
        const TOKEN = `ghp_${"abcdefghijklmnopqrstuvwxyz012345".split("").reverse().join("")}`;
        log.error(`Cloning with ${TOKEN} failed`, {
            password,
            authorization: `Bearer ${TOKEN}`,
            url: `https://x-access-token:${TOKEN}@github.com/acme/app.git`,
            err: new Error(`fatal: could not read from https://x-access-token:${TOKEN}@github.com`),
        });
        const all = await flushed();
        assert.match(all, /"type":"event"/);
        assert.equal(all.includes(TOKEN), false);
        assert.equal(all.includes(password), false);
        assert.match(all, /\[redacted\]/);
    });

    test("who someone is stays in the instance's own log", async () => {
        now += 120_000;
        log.error("Sign-in went wrong", { ip: "203.0.113.9", username: "sam", email: "sam@example.com", subject: "oidc|42", user: "u7" });
        const all = await flushed();
        for (const never of ["203.0.113.9", "sam@example.com", "oidc|42", '"sam"']) assert.equal(all.includes(never), false, never);
        assert.match(all, /"user":\{"id":"u7"\}/);
    });

    test("the same error over and over is one issue a minute, though every line is kept as a log", async () => {
        now += 120_000;
        for (let i = 0; i < 5; i++) log.error("The health check failed", { err: new Error("connect ECONNREFUSED") });
        let all = await flushed();
        assert.equal(all.split('"type":"event"').length - 1, 1);
        assert.equal(all.split('"body":"The health check failed"').length - 1, 5);
        now += 61_000;
        log.error("The health check failed", { err: new Error("connect ECONNREFUSED") });
        all = await flushed();
        assert.equal(all.split('"type":"event"').length - 1, 1);
    });

    test("an error with nothing thrown is reported by its message", async () => {
        now += 120_000;
        log.error("Lost a lock: it was taken over as abandoned. Carrying on.", { target: "/cache/a.git" });
        assert.match(await flushed(), /"message":"Lost a lock: it was taken over as abandoned\. Carrying on\."/);
    });

    test("SENTRY_LOGS=false sends errors only", async () => {
        now += 120_000;
        removeSink();
        removeSink = addLogSink(sentrySink({ logs: false }, () => now));
        log.info("Listening");
        log.error("Only as an issue", { err: new Error("once") });
        const all = await flushed();
        assert.match(all, /"type":"event"/);
        assert.equal(all.includes('"type":"log"'), false);
    });
});

describe("whose fault a failure is", () => {
    test("another service saying no or being away is expected; anything else is ours", () => {
        assert.equal(fromOutside(new GitHubError(502, "GitHub answered 502")), true);
        assert.equal(fromOutside(new TypeError("fetch failed")), true);
        assert.equal(fromOutside(Object.assign(new Error("connect"), { code: "ECONNREFUSED" })), true);
        assert.equal(fromOutside(new Error("wrapped", { cause: new DOMException("timed out", "TimeoutError") })), true);
        assert.equal(fromOutside(new TypeError("x is not a function")), false);
        assert.equal(fromOutside(new Error("duplicate key value violates unique constraint")), false);
        assert.equal(fromOutside("a string"), false);
    });

    test("an error can be logged without its message, keeping what kind it is and where it was thrown", () => {
        const err = Object.assign(new Error('duplicate key: Key (title)=("their code")'), { code: "23505" });
        const out = withoutMessage(err);
        assert.equal(out.message, "message withheld (code 23505)");
        assert.equal(String(out.stack).includes("their code"), false);
        assert.match(String(out.stack), /telemetry\.test\.ts/);
    });
});

describe("requests", () => {
    test("every answer names its request, and a failure says the same name to the caller and the log", async () => {
        const t = await testApp();
        const lines: string[] = [];
        const restore = captureLog((_level, line) => lines.push(line));
        try {
            const ok = await t.app.request(`${ORIGIN}/auth/config`);
            const id = ok.headers.get("x-request-id") ?? "";
            assert.match(id, /^[\w-]{10,}$/);
            // Something unexpected while answering: nothing a caller did wrong.
            const session = await t.signIn("admin", "correct-horse-battery-staple");
            t.services.accounts.session = () => {
                throw new TypeError("boom in a route");
            };
            const res = await t.app.request(`${ORIGIN}/api/v1/workspaces`, { headers: { cookie: session.cookie } });
            assert.equal(res.status, 500);
            const body = (await res.json()) as { error: string; requestId: string };
            assert.equal(body.requestId, res.headers.get("x-request-id"));
            assert.notEqual(body.requestId, id);
            assert.ok(lines.some((l) => l.includes("ERROR Request failed: boom in a route") && l.includes(`request=${body.requestId}`)));
            assert.ok(lines.some((l) => l.includes("Request answered with an error") && l.includes("status=500")));
            // The health check failing is said too (and not every few seconds).
            t.services.store.ping = async () => {
                throw new Error("the database fell over");
            };
            const health = await t.app.request(`${ORIGIN}/healthz`);
            assert.equal(health.status, 503);
            assert.ok(lines.some((l) => l.includes("The health check failed") && l.includes("the database fell over")));
        } finally {
            restore();
        }
    });

    test("the web app's reports are passed on only from our own pages, and only to our own project", async () => {
        const calls: { url: string; body: string; headers: Headers }[] = [];
        const upstream = { status: 200, retryAfter: null as string | null };
        const fake = (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({
                url: String(url),
                body: Buffer.from(init?.body as Uint8Array).toString("utf8"),
                headers: new Headers(init?.headers),
            });
            return new Response("{}", {
                status: upstream.status,
                headers: upstream.retryAfter ? { "retry-after": upstream.retryAfter } : {},
            });
        }) as typeof fetch;
        const dir = mkdtempSync(path.join(tmpdir(), "triagent-web-"));
        mkdirSync(path.join(dir, "assets"));
        writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>Triagent</title></head><body></body></html>");
        const t = await testApp(undefined, {
            fetch: fake,
            env: { SENTRY_DSN: DSN, OPENROUTER_CATALOGUE: "false", WEB_DIST_DIR: dir, TRIAGENT_VERSION: "abc123" },
        });
        const envelope = (dsn: string) => `${JSON.stringify({ dsn })}\n{"type":"event"}\n{"message":"x"}\n`;
        const post = (body: string, headers: Record<string, string> = { origin: ORIGIN }) =>
            t.app.request(`${ORIGIN}/api/v1/telemetry`, {
                method: "POST",
                body,
                headers: { cookie: "triagent_sid=abc", "x-forwarded-for": "203.0.113.9", ...headers },
            });

        assert.equal((await post(envelope(DSN))).status, 200);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.url, "https://o123.ingest.sentry.io/api/456/envelope/");
        assert.equal(calls[0]?.body, envelope(DSN));
        // Nothing of the person's goes with it.
        assert.deepEqual([...(calls[0]?.headers.keys() ?? [])], ["content-type"]);

        assert.equal((await post(envelope(DSN), { origin: "https://elsewhere.example" })).status, 403);
        assert.equal((await post(envelope(DSN), { "sec-fetch-site": "cross-site" })).status, 403);
        assert.equal((await post(envelope("https://other@o9.ingest.sentry.io/1"))).status, 403);
        assert.equal((await post("{not json")).status, 400);
        assert.equal((await post("x".repeat(600 * 1024))).status, 413);
        assert.equal(calls.length, 1);

        // Sentry saying "slow down" is passed back, so the app's SDK does.
        upstream.status = 429;
        upstream.retryAfter = "30";
        const slow = await post(envelope(DSN));
        assert.deepEqual([slow.status, slow.headers.get("retry-after")], [429, "30"]);
        // Any other trouble upstream is no business of the page's.
        upstream.status = 500;
        assert.equal((await post(envelope(DSN))).status, 200);

        // The page is told where reports belong, and nothing the server alone needs to know.
        const page = await (await t.app.request(`${ORIGIN}/w/acme`)).text();
        assert.match(
            page,
            /<meta name="triagent-reporting" content="\{&quot;dsn&quot;:&quot;https:\/\/publickey@o123\.ingest\.sentry\.io\/456&quot;,&quot;environment&quot;:&quot;development&quot;,&quot;release&quot;:&quot;abc123&quot;\}" \/><\/head>/,
        );
    });

    test("without a DSN there is no report endpoint, and the page says nothing about one", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "triagent-web-"));
        writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head></head></html>");
        const t = await testApp(undefined, { env: { WEB_DIST_DIR: dir } });
        assert.equal(
            (await t.app.request(`${ORIGIN}/api/v1/telemetry`, { method: "POST", body: "{}", headers: { origin: ORIGIN } })).status,
            404,
        );
        assert.equal((await (await t.app.request(`${ORIGIN}/`)).text()).includes("triagent-reporting"), false);
    });

    test("a runner's own log lines are taken with the runner secret, and wanted only when there's somewhere to send them", async () => {
        const secret = "r".repeat(40);
        const runner = { id: "runner-abcdefgh", name: "runner-1", version: "0.1.0", slots: 1, capacity: 1 };
        const line = {
            time: "2026-01-01T00:00:00.000Z",
            level: "error",
            msg: "Lost a lock",
            fields: { service: "server", target: "/c/a.git" },
        };
        const send = (t: Awaited<ReturnType<typeof testApp>>, auth: string) =>
            t.request("/internal/runner/log", { method: "POST", body: { runner, records: [line] }, headers: { authorization: auth } });

        const off = await testApp(undefined, { env: { TRIAGENT_RUNNER_SECRET: secret } });
        assert.deepEqual((await send(off, `Bearer ${secret}`)).body, { wanted: false });

        const on = await testApp(undefined, { env: { TRIAGENT_RUNNER_SECRET: secret, SENTRY_DSN: DSN } });
        const got: { msg: string; fields: Record<string, unknown> }[] = [];
        const remove = addLogSink({ write: (r) => got.push(r) });
        const restore = captureLog(() => {});
        try {
            assert.deepEqual((await send(on, `Bearer ${secret}`)).body, { wanted: true });
            // Marked as the runner's, whatever the line itself claimed.
            assert.deepEqual(got.find((r) => r.msg === "Lost a lock")?.fields, {
                service: "runner",
                target: "/c/a.git",
                runner: "runner-1",
            });
            assert.equal((await send(on, "Bearer wrong")).status, 401);
            assert.ok(got.some((r) => r.msg === "A runner was refused: its secret is missing or wrong"));
        } finally {
            remove();
            restore();
        }
    });
});
