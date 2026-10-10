// Set-up for review tests: a server listening on a port (runners talk HTTP), a fake GitHub, a project
// connected to it (by token or through the GitHub App), a model key, and a runner using the fake `ocr`.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { FakeGitHub } from "../../../tests/fakes/github.ts";
import { Runner } from "../../runner/src/runner.ts";
import type { Lookup } from "../src/services/model-urls.ts";
import type { Store } from "../src/store/types.ts";
import { ADMIN_PASSWORD, type Session, type TestApp, testApp } from "./helpers.ts";

export const FAKE_OCR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fakes/ocr.ts");
export const MODEL_KEY = `sk-or-v1-${"k3y".repeat(12)}`;

export interface ReviewEnv {
    t: TestApp;
    fake: FakeGitHub;
    url: string;
    secret: string;
    admin: Session;
    runners: Runner[];
    dirs: string[];
    /** A runner using the fake ocr, started. */
    runner(extra?: { concurrency?: number }): Runner;
    close(): Promise<void>;
}

export async function reviewEnv(options: { store?: Store; env?: Record<string, string>; lookup?: Lookup } = {}): Promise<ReviewEnv> {
    const fake = await new FakeGitHub().start();
    const secret = randomBytes(32).toString("base64url");
    const t = await testApp(options.store, {
        env: { GITHUB_API_URL: fake.apiUrl, GITHUB_URL: fake.url, TRIAGENT_RUNNER_SECRET: secret, ...options.env },
        ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    const server = serve({ fetch: t.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const env: ReviewEnv = {
        t,
        fake,
        url,
        secret,
        admin,
        runners: [],
        dirs: [],
        runner(extra = {}) {
            const dir = mkdtempSync(path.join(tmpdir(), "runner-"));
            env.dirs.push(dir);
            const r = new Runner({
                serverUrl: url,
                secret,
                name: `test-runner-${env.runners.length + 1}`,
                concurrency: extra.concurrency ?? 1,
                modelParallelism: 5,
                // A model over its token budget is stopped at once, so tests of that needn't wait.
                overBudgetGraceSeconds: 0,
                cacheDir: path.join(dir, "cache"),
                workDir: path.join(dir, "work"),
                pollMs: 100,
                healthPort: null,
                ocrBin: FAKE_OCR,
                gitBin: "git",
                llmTimeout: null,
                path: process.env.PATH ?? "/usr/bin:/bin",
                warnings: [],
            });
            env.runners.push(r);
            r.start();
            return r;
        },
        async close() {
            await Promise.all(env.runners.map((r) => r.stop()));
            await t.services.runs.settled();
            t.services.automation.stop();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await fake.stop();
            for (const d of env.dirs) rmSync(d, { recursive: true, force: true });
        },
    };
    return env;
}

export const PAT = (n = 0) => `github_pat_${String(n).repeat(1)}${"a".repeat(30)}`;

/** An organisation with a project on `repo`, a model key (and model), and GitHub through a token. */
export async function patProject(env: ReviewEnv, ws: string, opts: { repo?: string; model?: string; token?: string; key?: boolean } = {}) {
    const { t, admin, fake } = env;
    const repo = opts.repo ?? "acme/app";
    const ok = (r: { status: number; text: string }, status = 200) => {
        if (r.status !== status) throw new Error(`${r.status} ${r.text}`);
    };
    ok(await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: ws } }), 201);
    ok(
        await t.request(`/api/v1/w/${ws}/projects`, {
            method: "POST",
            session: admin,
            body: { slug: "app", repoUrl: `https://github.com/${repo}` },
        }),
        201,
    );
    if (opts.key !== false) {
        ok(
            await t.request(`/api/v1/w/${ws}/settings/review-model/keys/openrouter`, {
                method: "PUT",
                session: admin,
                body: { key: MODEL_KEY },
            }),
        );
        ok(
            await t.request(`/api/v1/w/${ws}/settings/review-model`, {
                method: "PATCH",
                session: admin,
                body: { model: opts.model ?? "fake/model" },
            }),
        );
    }
    const token = opts.token ?? PAT();
    fake.pat(token, "octo", [repo]);
    ok(await t.request(`/api/v1/w/${ws}/p/app/settings/github/token`, { method: "PUT", session: admin, body: { token } }));
    return { ws, project: "app", token };
}

export async function setModel(env: ReviewEnv, ws: string, model: string) {
    const r = await env.t.request(`/api/v1/w/${ws}/settings/review-model`, { method: "PATCH", session: env.admin, body: { model } });
    if (r.status !== 200) throw new Error(r.text);
}

export async function eventually<T>(check: () => Promise<T | null | undefined | false>, what: string, ms = 15_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await check();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

/** Wait for a run to finish, and return it with its whole log. */
export async function finished(env: ReviewEnv, ws: string, id: string) {
    const run = await eventually(async () => {
        const r = await env.t.request(`/api/v1/w/${ws}/runs/${id}`, { session: env.admin });
        return ["done", "partial", "failed", "cancelled"].includes(r.body.status) ? r.body : null;
    }, `run ${id} to finish`);
    await env.t.services.runs.settled();
    return run;
}
