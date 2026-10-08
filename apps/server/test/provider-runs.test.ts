// Reviews with providers other than OpenRouter: the claim hands the runner this job's protocol and
// credentials, a person-given URL is checked again when the review starts, and a Bedrock review runs end to
// end (the runner writes OCR's config for it) with every one of its secrets kept out of the log.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Actor } from "../src/services/core.ts";
import type { Lookup } from "../src/services/model-urls.ts";
import { type RunnerHello, specForBranch } from "../src/services/runs.ts";
import type { Project } from "../src/store/types.ts";
import { finished, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const ADMIN: Actor = { name: "admin", userId: null, via: "web" };
const runner: RunnerHello = { id: "runner-prov-0000", name: "prov", version: "1", slots: 1 };
const fakeKey = () => randomBytes(24).toString("base64url");
const accessKeyId = () => `AKIA${randomBytes(8).toString("hex").toUpperCase()}`;

const hosts: Record<string, string[]> = { "gateway.example.com": ["93.184.215.14"] };
const lookup: Lookup = async (h) => (hosts[h] ?? []).map((address) => ({ address, family: 4 }));

describe("claims, by provider", () => {
    let env: ReviewEnv;
    let project: Project;
    before(async () => {
        env = await reviewEnv({ lookup, env: { REVIEW_CONCURRENCY: "2", REVIEW_CONCURRENCY_PER_WORKSPACE: "2" } });
        await patProject(env, "acme", { key: false });
        const w = await env.t.services.store.workspaces.bySlug("acme");
        project = (await env.t.services.store.projects.bySlug(w?.id as string, "app")) as Project;
    });
    after(() => env.close());

    const configure = async (body: object, keys: Record<string, string>) => {
        const r = await env.t.request("/api/v1/w/acme/settings/review-model", { method: "PATCH", session: env.admin, body });
        assert.equal(r.status, 200, r.text);
        for (const [path, key] of Object.entries(keys))
            assert.equal(
                (
                    await env.t.request(`/api/v1/w/acme/settings/review-model/keys/${path}`, {
                        method: "PUT",
                        session: env.admin,
                        body: { key },
                    })
                ).status,
                200,
            );
    };

    test("a custom server: its protocol, URL and key, and only those", async () => {
        const key = fakeKey();
        await configure(
            { provider: "custom", url: "https://gateway.example.com/v1", model: "big-model", protocol: "openai-responses" },
            { custom: key },
        );
        const job = await env.t.services.runs.enqueue(ADMIN, project, specForBranch("full", "custom", null));
        const claimed = await env.t.services.runs.claim(runner);
        assert.equal(claimed?.id, job.id);
        assert.deepEqual(claimed?.model, {
            provider: "custom",
            protocol: "openai-responses",
            url: "https://gateway.example.com/v1",
            model: "big-model",
            apiKey: key,
        });
        // Its key is redacted from what the runner sends.
        await env.t.services.runs.events(runner, job.id, { lines: [{ line: `oops ${key}` }] });
        assert.deepEqual(
            (await env.t.services.store.jobs.log(job.id, 0, 10)).map((l) => l.line),
            ["oops [redacted]"],
        );
        await env.t.services.runs.finish(runner, job.id, { status: "failed", error: "test" });
    });

    test("a URL that resolves inside the network by the time a review starts fails it, saying why", async () => {
        hosts["gateway.example.com"] = ["10.20.30.40"];
        const job = await env.t.services.runs.enqueue(ADMIN, project, specForBranch("full", "moved", null));
        assert.equal(await env.t.services.runs.claim(runner), null);
        const failed = await env.t.services.store.jobs.get(job.id);
        assert.equal(failed?.status, "failed");
        assert.match(failed?.error ?? "", /private or loopback address \(gateway\.example\.com\)/);
        hosts["gateway.example.com"] = ["93.184.215.14"];
    });

    test("Bedrock: the AWS access key ID and secret are both this job's secrets", async () => {
        const id = accessKeyId();
        const secret = fakeKey();
        await configure(
            { provider: "bedrock", region: "eu-west-2", model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0" },
            {
                bedrock: secret,
                "bedrock/access-key-id": id,
            },
        );
        const job = await env.t.services.runs.enqueue(ADMIN, project, specForBranch("full", "bedrock", null));
        const claimed = await env.t.services.runs.claim(runner);
        assert.deepEqual(claimed?.model, {
            provider: "bedrock",
            protocol: "anthropic-bedrock",
            url: "",
            model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
            apiKey: secret,
            aws: { region: "eu-west-2", accessKeyId: id },
        });
        await env.t.services.runs.events(runner, job.id, { lines: [{ line: `AWS_ACCESS_KEY_ID=${id} AWS_SECRET_ACCESS_KEY=${secret}` }] });
        assert.deepEqual(
            (await env.t.services.store.jobs.log(job.id, 0, 10)).map((l) => l.line),
            ["AWS_ACCESS_KEY_ID=[redacted] AWS_SECRET_ACCESS_KEY=[redacted]"],
        );
        await env.t.services.runs.finish(runner, job.id, { status: "failed", error: `signing with ${secret} failed` });
        assert.equal((await env.t.services.store.jobs.get(job.id))?.error, "signing with [redacted] failed");
    });
});

describe("a Bedrock review end to end", () => {
    let env: ReviewEnv;
    const id = accessKeyId();
    const secret = fakeKey();
    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme", { key: false });
        await env.fake.gitRepo("acme/app", { "src/a.ts": "export const a = 1;\n" });
        await env.t.request("/api/v1/w/acme/settings/review-model", {
            method: "PATCH",
            session: env.admin,
            body: { provider: "bedrock", region: "eu-west-2", model: "fake/model" },
        });
        for (const [path, key] of [
            ["bedrock", secret],
            ["bedrock/access-key-id", id],
        ] as const)
            await env.t.request(`/api/v1/w/acme/settings/review-model/keys/${path}`, { method: "PUT", session: env.admin, body: { key } });
        env.runner();
    });
    after(() => env.close());

    test("OCR gets a config naming the provider, region and model, AWS credentials in its environment, and no OCR_LLM_*", async () => {
        const start = await env.t.request("/api/v1/w/acme/p/app/reviews", {
            method: "POST",
            session: env.admin,
            body: { kind: "full", branch: "main" },
        });
        assert.equal(start.status, 201, start.text);
        const run = await finished(env, "acme", start.body.id);
        const lines: string[] = run.logLines.map((l: { line: string }) => l.line);
        const text = lines.join("\n");
        assert.equal(run.status, "done", text);
        assert.ok(
            lines.includes(
                '[fake-ocr] config: {"provider":"bedrock","providers":{"bedrock":{"aws_region":"eu-west-2","model":"fake/model"}}}',
            ),
            text,
        );
        const envLine = lines.find((l) => l.startsWith("[fake-ocr] env: ")) ?? "";
        const names = envLine.replace("[fake-ocr] env: ", "").split(",");
        for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_EC2_METADATA_DISABLED"])
            assert.ok(names.includes(k), k);
        assert.ok(!names.some((k) => k.startsWith("OCR_LLM_") && k !== "OCR_LLM_TIMEOUT"), envLine);
        // Both of the job's AWS secrets are redacted wherever they appear.
        assert.ok(lines.includes("[fake-ocr] key: [redacted]"), text);
        assert.ok(lines.includes("[fake-ocr] aws access key id: [redacted]"), text);
        assert.ok(!text.includes(secret) && !text.includes(id));
    });
});
