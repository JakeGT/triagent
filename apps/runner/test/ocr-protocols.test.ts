// How the runner drives OCR for each protocol: the environment (and, for Amazon Bedrock, the config file in
// the job's own HOME), never telemetry, MCP servers, setup or key commands, and every credential redacted.
//
// With OCR_REAL_BIN set to Open Code Review's real binary (1.12.12), it's also run (`ocr llm test`) against
// a local fake provider, to check the request it actually sends for each protocol; Bedrock's goes to a
// local proxy that refuses it, so nothing reaches AWS.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { RunnerModel } from "../../../packages/shared/src/model.ts";
import { JobRun, ocrConfig, ocrEnv, writeOcrConfig } from "../src/runner.ts";

const fakeKey = () => randomBytes(24).toString("base64url");
const accessKeyId = () => `AKIA${randomBytes(8).toString("hex").toUpperCase()}`;
const config = { path: "/usr/bin:/bin", llmTimeout: null };
const ALLOWED =
    /^(PATH|HOME|TMPDIR|XDG_\w+|LANG|TZ|OCR_(NO_UPDATE|LLM_(URL|TOKEN|MODEL|PROTOCOL|AUTH_HEADER|TIMEOUT)|USE_ANTHROPIC)|AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION|EC2_METADATA_DISABLED)|GIT_\w+)$/;

const models = (): Record<"openai" | "responses" | "anthropic" | "bedrock", RunnerModel> => ({
    openai: { provider: "openai", protocol: "openai", url: "https://api.openai.com/v1", model: "gpt-5.5", apiKey: fakeKey() },
    responses: {
        provider: "azure",
        protocol: "openai-responses",
        url: "https://res.openai.azure.com/openai/v1",
        model: "deploy",
        apiKey: fakeKey(),
    },
    anthropic: {
        provider: "anthropic",
        protocol: "anthropic",
        url: "https://api.anthropic.com",
        model: "claude-opus-5-5",
        apiKey: fakeKey(),
    },
    bedrock: {
        provider: "bedrock",
        protocol: "anthropic-bedrock",
        url: "",
        model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
        apiKey: fakeKey(),
        aws: { region: "eu-west-2", accessKeyId: accessKeyId() },
    },
});

describe("OCR's environment and config, by protocol", () => {
    let saved: NodeJS.ProcessEnv;
    before(() => {
        saved = { ...process.env };
        // Whatever the runner's own environment has never reaches OCR.
        Object.assign(process.env, {
            OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test",
            OCR_ENABLE_TELEMETRY: "true",
            ANTHROPIC_API_KEY: "should-not-pass-1",
            ANTHROPIC_BASE_URL: "https://should-not-pass.test",
            AWS_PROFILE: "should-not-pass-2",
            AWS_SESSION_TOKEN: "should-not-pass-3",
        });
    });
    after(() => {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    });

    const check = (env: Record<string, string>) => {
        for (const k of Object.keys(env)) assert.match(k, ALLOWED);
        assert.ok(!JSON.stringify(env).includes("should-not-pass") && !JSON.stringify(env).includes("collector"));
    };

    test("OpenAI-compatible: the URL, key, model and protocol, never Anthropic's", () => {
        const m = models().openai;
        const env = ocrEnv(config, "/job/home", { model: m });
        check(env);
        assert.deepEqual(
            [env.OCR_LLM_URL, env.OCR_LLM_TOKEN, env.OCR_LLM_MODEL, env.OCR_LLM_PROTOCOL, env.OCR_USE_ANTHROPIC, env.OCR_LLM_AUTH_HEADER],
            [m.url, m.apiKey, "gpt-5.5", "openai", "false", undefined],
        );
        assert.equal(ocrConfig({ model: m }), null);
    });

    test("the Responses API", () => {
        const env = ocrEnv(config, "/job/home", { model: models().responses });
        check(env);
        assert.equal(env.OCR_LLM_PROTOCOL, "openai-responses");
        assert.equal(env.OCR_USE_ANTHROPIC, "false");
    });

    test("Anthropic: its protocol, and the key as x-api-key", () => {
        const m = models().anthropic;
        const env = ocrEnv(config, "/job/home", { model: m });
        check(env);
        assert.deepEqual(
            [env.OCR_LLM_URL, env.OCR_LLM_PROTOCOL, env.OCR_USE_ANTHROPIC, env.OCR_LLM_AUTH_HEADER],
            ["https://api.anthropic.com", "anthropic", "true", "x-api-key"],
        );
    });

    test("Bedrock: AWS credentials and region in the environment, the provider in a config file of nothing else", () => {
        const m = models().bedrock;
        const env = ocrEnv({ ...config, llmTimeout: "300" }, "/job/home", { model: m });
        check(env);
        assert.deepEqual(
            [env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_REGION, env.AWS_EC2_METADATA_DISABLED, env.OCR_LLM_TIMEOUT],
            [m.aws?.accessKeyId, m.apiKey, "eu-west-2", "true", "300"],
        );
        for (const k of ["OCR_LLM_URL", "OCR_LLM_TOKEN", "OCR_LLM_MODEL", "OCR_LLM_PROTOCOL", "AWS_PROFILE", "AWS_SESSION_TOKEN"])
            assert.equal(env[k], undefined, k);
        const home = mkdtempSync(path.join(tmpdir(), "ocr-home-"));
        try {
            writeOcrConfig(home, { model: m });
            const file = path.join(home, ".opencodereview", "config.json");
            const text = readFileSync(file, "utf8");
            assert.deepEqual(JSON.parse(text), {
                provider: "bedrock",
                providers: { bedrock: { aws_region: "eu-west-2", model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0" } },
            });
            // No MCP servers, setup commands or key commands; no secrets either (they're in the environment).
            for (const word of ["mcp", "setup", "api_key", "auth_token", "cmd", m.apiKey, m.aws?.accessKeyId as string])
                assert.ok(!text.includes(word), word);
            assert.equal(statSync(file).mode & 0o777, 0o600);
            assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
            // Other protocols get no config file at all.
            const plain = mkdtempSync(path.join(tmpdir(), "ocr-home-"));
            writeOcrConfig(plain, { model: models().openai });
            assert.throws(() => statSync(path.join(plain, ".opencodereview")));
            rmSync(plain, { recursive: true, force: true });
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test("every credential is redacted from what the runner sends: AWS keys, Azure's, a custom server's", () => {
        const all = models();
        for (const m of [all.bedrock, all.responses, { ...all.openai, provider: "custom" }] as RunnerModel[]) {
            const token = `ghs_${randomBytes(18).toString("hex")}`;
            const run = new JobRun(
                { id: "job-1", git: { username: "x-access-token", token }, model: m },
                { events: async () => ({ cancel: false }), heartbeat: async () => ({ cancel: false }) },
            );
            const secrets = [m.apiKey, m.aws?.accessKeyId].filter(Boolean) as string[];
            for (const s of secrets) {
                assert.equal(run.redactLine(`it was ${s}!`), "it was [redacted]!");
                assert.ok(
                    !run.redactLine(Buffer.from(`AWS4:${s}`).toString("base64")).includes(Buffer.from(s).toString("base64").slice(4, 20)),
                );
                assert.ok(!JSON.stringify(run.redactReport({ comments: [{ content: `x ${s} y` }] })).includes(s));
            }
        }
    });
});

/** A fake model provider that records each request and answers in the shape of the protocol asked for. */
function fakeProvider() {
    const seen: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
    const server = http.createServer((req, res) => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
        req.resume();
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            const url = req.url ?? "";
            if (url.includes("/messages"))
                return res.end(
                    JSON.stringify({
                        id: "m",
                        type: "message",
                        role: "assistant",
                        model: "m",
                        content: [{ type: "text", text: "ok" }],
                        stop_reason: "end_turn",
                        usage: { input_tokens: 1, output_tokens: 1 },
                    }),
                );
            if (url.includes("/responses"))
                return res.end(
                    JSON.stringify({
                        id: "r",
                        object: "response",
                        created_at: 1,
                        status: "completed",
                        model: "m",
                        output: [
                            {
                                type: "message",
                                id: "o",
                                status: "completed",
                                role: "assistant",
                                content: [{ type: "output_text", text: "ok", annotations: [] }],
                            },
                        ],
                        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                    }),
                );
            res.end(
                JSON.stringify({
                    id: "c",
                    object: "chat.completion",
                    created: 1,
                    model: "m",
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }),
            );
        });
    });
    // A forward proxy that refuses everything: Bedrock's request stops here, and says where it was going.
    const connects: string[] = [];
    server.on("connect", (req, socket) => {
        connects.push(req.url ?? "");
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    return { server, seen, connects };
}

const REAL = process.env.OCR_REAL_BIN;

describe("the real OCR binary, against a local fake provider", { skip: REAL ? false : "set OCR_REAL_BIN to run" }, () => {
    const fake = fakeProvider();
    let base = "";
    let home = "";
    before(async () => {
        await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", () => r()));
        base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    });
    after(() => {
        fake.server.close();
    });

    const llmTest = (model: RunnerModel, extra: Record<string, string> = {}) => {
        home = mkdtempSync(path.join(tmpdir(), "ocr-real-"));
        writeOcrConfig(home, { model });
        const env = { ...ocrEnv({ path: "/usr/bin:/bin", llmTimeout: "5" }, home, { model }), ...extra };
        return new Promise<string>((resolve) => {
            execFile(REAL as string, ["llm", "test"], { env, cwd: home, timeout: 60_000 }, (_err, stdout, stderr) => {
                rmSync(home, { recursive: true, force: true });
                resolve(`${stdout}${stderr}`);
            });
        });
    };

    test("openai: POST {url}/chat/completions with a bearer key", async () => {
        const m = { ...models().openai, url: `${base}/v1` };
        fake.seen.length = 0;
        const out = await llmTest(m);
        assert.match(out, /Connection test successful/, out);
        assert.equal(fake.seen[0]?.url, "/v1/chat/completions");
        assert.equal(fake.seen[0]?.headers.authorization, `Bearer ${m.apiKey}`);
    });

    test("openai-responses: POST {url}/responses", async () => {
        const m = { ...models().responses, url: `${base}/openai/v1` };
        fake.seen.length = 0;
        const out = await llmTest(m);
        assert.match(out, /Connection test successful/, out);
        assert.equal(fake.seen[0]?.url, "/openai/v1/responses");
        assert.equal(fake.seen[0]?.headers.authorization, `Bearer ${m.apiKey}`);
    });

    test("anthropic: POST {url}/v1/messages with x-api-key and no bearer token", async () => {
        const m = { ...models().anthropic, url: base };
        fake.seen.length = 0;
        const out = await llmTest(m);
        assert.match(out, /Connection test successful/, out);
        assert.equal(fake.seen[0]?.url, "/v1/messages");
        assert.equal(fake.seen[0]?.headers["x-api-key"], m.apiKey);
        assert.equal(fake.seen[0]?.headers.authorization, undefined);
        assert.equal(fake.seen[0]?.headers["anthropic-version"], "2023-06-01");
    });

    test("bedrock: from the config file, to the region's bedrock-runtime host", async () => {
        fake.connects.length = 0;
        const out = await llmTest(models().bedrock, { HTTPS_PROXY: base });
        assert.match(out, /region eu-west-2/, out);
        assert.ok(fake.connects.length > 0, out);
        assert.ok(
            fake.connects.every((c) => c === "bedrock-runtime.eu-west-2.amazonaws.com:443"),
            fake.connects.join(),
        );
    });
});
