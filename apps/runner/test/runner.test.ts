// The runner's parts: reading OCR's progress, the environment OCR gets, stopping process groups, and
// git against a fake GitHub over smart HTTP (the credential header, refused without it, and the
// review rules a change under review can't set for itself).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { FakeGitHub } from "../../../tests/fakes/github.ts";
import { Git, mirrorPath } from "../src/git.ts";
import { start } from "../src/process.ts";
import { readProgress } from "../src/progress.ts";
import { ocrArgs, ocrEnv } from "../src/runner.ts";

describe("progress from OCR's stderr", () => {
    test("files, groups, rounds, tool calls and phases", () => {
        const seen = new Set<string>();
        let p = {};
        for (const line of [
            "[ocr] 12 file(s) changed, reviewing 10 in /work/tree",
            '[ocr] Planning phase for group "src/db"',
            '[ocr] Round 1/2 for group "src/db"',
            "[ocr]   ▶ file_read path=src/db/a.ts",
            "[ocr]   ✔ file_read (4ms)",
            "[ocr]   ▶ code_search q=x",
            "[ocr]   ✘ code_search failed: nope",
            '[ocr] Round 2 failed for group "src/api": LLM completion error',
            "[ocr] Writing the summary",
        ])
            p = readProgress(p, line, seen);
        assert.deepEqual(p, {
            filesChanged: 12,
            files: 10,
            groups: 2,
            current: "src/api",
            round: "2/2",
            roundsFailed: 1,
            toolCalls: 2,
            toolFailures: 1,
            phase: "summarising",
        });
    });
});

describe("OCR's environment", () => {
    test("is built from an allowlist: no telemetry, nothing of Anthropic's, nothing else of the runner's", () => {
        const before = { ...process.env };
        Object.assign(process.env, {
            OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test",
            OCR_ENABLE_TELEMETRY: "true",
            ANTHROPIC_API_KEY: "sk-ant-should-not-pass",
            TRIAGENT_RUNNER_SECRET: "x".repeat(40),
            AWS_SECRET_ACCESS_KEY: "nope",
        });
        try {
            const env = ocrEnv({ path: "/usr/bin:/bin", llmTimeout: "300" }, "/work/home", {
                model: { url: "https://llm.test/v1", model: "m", apiKey: "key-123456", protocol: "openai", provider: "openrouter" },
            });
            for (const k of Object.keys(env))
                assert.ok(
                    /^(PATH|HOME|TMPDIR|XDG_\w+|LANG|TZ|OCR_(CONFIG_PATH|NO_UPDATE|LLM_\w+|USE_ANTHROPIC)|GIT_\w+)$/.test(k),
                    `unexpected ${k}`,
                );
            assert.equal(env.OCR_USE_ANTHROPIC, "false");
            assert.equal(env.OCR_NO_UPDATE, "1");
            assert.equal(env.OCR_LLM_TIMEOUT, "300");
            assert.equal(env.HOME, "/work/home");
            assert.ok(env.OCR_CONFIG_PATH?.startsWith("/work/home/") && !existsSync(env.OCR_CONFIG_PATH));
            assert.ok(!JSON.stringify(env).includes("should-not-pass") && !JSON.stringify(env).includes("collector"));
            // Hooks stay off for any git OCR runs.
            const keys = Object.entries(env).filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"));
            const i = keys.find(([, v]) => v === "core.hooksPath")?.[0].replace("KEY", "VALUE") as string;
            assert.equal(env[i], "/dev/null");
        } finally {
            for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
        }
    });

    test("arguments for each kind of review", () => {
        assert.deepEqual(ocrArgs({ kind: "pr", maxTokensBudget: 50_000 }, "a".repeat(40), "b".repeat(40)), [
            "review",
            "--from",
            "a".repeat(40),
            "--to",
            "b".repeat(40),
            "--format",
            "json",
            "--audience",
            "human",
            "--color",
            "never",
            "--max-tokens-budget",
            "50000",
        ]);
        assert.deepEqual(ocrArgs({ kind: "full", maxTokensBudget: null }, null, "b".repeat(40)).slice(0, 3), ["scan", "--format", "json"]);
    });
});

describe("process groups", () => {
    test("stopping a process stops what it started, too", async () => {
        const out: string[] = [];
        const p = start("sh", ["-c", "sleep 300 & echo child $!; wait"], { env: { PATH: process.env.PATH ?? "" } });
        let child = 0;
        const deadline = Date.now() + 5000;
        // The child's pid is on stdout once the shell has started it.
        while (!child && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 20));
            const proc = `/proc/${p.pid}/task/${p.pid}/children`;
            if (existsSync(proc)) child = Number(readFileSync(proc, "utf8").trim().split(" ")[0]) || 0;
        }
        assert.ok(child > 0, "the grandchild started");
        p.stop();
        const exit = await p.done;
        out.push(exit.stdout);
        assert.equal(exit.killed, true);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(
            existsSync(`/proc/${child}`) && !readFileSync(`/proc/${child}/stat`, "utf8").includes(") Z "),
            false,
            "the grandchild is gone",
        );
    });

    test("a time limit stops it", async () => {
        const exit = await start("sleep", ["30"], { env: { PATH: process.env.PATH ?? "" }, timeoutMs: 200 }).done;
        assert.equal(exit.timedOut, true);
    });
});

describe("git against a fake GitHub", () => {
    let fake: FakeGitHub;
    let work: string;
    const token = `github_pat_${"r".repeat(30)}`;
    let git: Git;

    before(async () => {
        fake = await new FakeGitHub().start();
        work = mkdtempSync(path.join(tmpdir(), "runner-test-"));
        git = new Git({ gitBin: "git", path: process.env.PATH ?? "", home: work });
        await fake.gitRepo("acme/app", {
            "src/a.ts": "export const a = 1;\n",
            ".opencodereview/rule.json": JSON.stringify({ focus: "base" }),
        });
        fake.pat(token, "octo", ["acme/app"]);
    });
    after(async () => {
        await fake.stop();
        rmSync(work, { recursive: true, force: true });
    });

    const job = (extra: object = {}) => ({
        kind: "pr" as const,
        cloneUrl: `${fake.url}/acme/app.git`,
        username: "x-access-token",
        token,
        pr: 1,
        gitRef: null,
        baseRef: "main",
        ...extra,
    });

    test("fetches a pull request with the token in a header (never in the URL), and works out the base", async () => {
        const base = fake.repo("acme/app").branches.get("main") as string;
        const head = await fake.commit("acme/app", "feature", { "src/b.ts": "export const b = 2;\n" }, "Add b", "main");
        await fake.openPull("acme/app", { number: 1, headRef: "feature" });
        const mirror = mirrorPath(path.join(work, "cache"), job().cloneUrl);
        const got = await git.fetch(mirror, job());
        assert.equal(got.head, head);
        assert.equal(got.base, base);
        assert.ok(
            fake.gitLog.some((g) => g.token === token),
            "the token was sent as git's Authorization header",
        );
        // Nothing about the credential is kept in the mirror's config.
        assert.ok(!readFileSync(path.join(mirror, "config"), "utf8").includes(token));
    });

    test("a wrong token is refused", async () => {
        const mirror = mirrorPath(path.join(work, "cache2"), job().cloneUrl);
        await assert.rejects(git.fetch(mirror, job({ token: `github_pat_${"w".repeat(30)}` })), /fetch failed|Authentication/);
    });

    test("a change under review can't bring its own review rules: the base's are used, or none", async () => {
        const mirror = mirrorPath(path.join(work, "cache"), job().cloneUrl);
        // The pull request rewrites the rules to exclude what it changes.
        await fake.commit(
            "acme/app",
            "sneaky",
            { ".opencodereview/rule.json": JSON.stringify({ exclude: ["src/**"] }), "src/c.ts": "x\n" },
            "Hide",
            "main",
        );
        await fake.openPull("acme/app", { number: 2, headRef: "sneaky" });
        const got = await git.fetch(mirror, job({ pr: 2 }));
        const tree = path.join(work, "tree-2");
        await git.addWorktree(mirror, tree, got.head);
        assert.match(readFileSync(path.join(tree, ".opencodereview/rule.json"), "utf8"), /exclude/);
        assert.equal(await git.useBaseReviewRules(mirror, tree, got.base as string), "replaced");
        assert.deepEqual(JSON.parse(readFileSync(path.join(tree, ".opencodereview/rule.json"), "utf8")), { focus: "base" });
        await git.removeWorktree(mirror, tree);
        assert.equal(existsSync(tree), false);

        // A base without rules: the change's rules are removed.
        await fake.commit("acme/app", "norules", { ".opencodereview/rule.json": null }, "No rules", "main");
        await fake.commit(
            "acme/app",
            "adds-rules",
            { ".opencodereview/rule.json": JSON.stringify({ exclude: ["src/"] }) },
            "Add rules",
            "norules",
        );
        const fetched = await git.fetch(mirror, job({ kind: "changes", pr: null, gitRef: "adds-rules", baseRef: "norules" }));
        const tree2 = path.join(work, "tree-3");
        await git.addWorktree(mirror, tree2, fetched.head);
        assert.equal(await git.useBaseReviewRules(mirror, tree2, fetched.base as string), "removed");
        assert.equal(existsSync(path.join(tree2, ".opencodereview")), false);
        await git.removeWorktree(mirror, tree2);
    });

    test("branch names from the server are checked before they reach git", async () => {
        const mirror = mirrorPath(path.join(work, "cache"), job().cloneUrl);
        await assert.rejects(git.fetch(mirror, job({ kind: "full", pr: null, gitRef: "--upload-pack=evil" })), /unusable branch/);
        await assert.rejects(git.fetch(mirror, job({ kind: "changes", pr: null, gitRef: "a", baseRef: "../x" })), /unusable/);
    });
});
