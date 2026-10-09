// The runner's parts: reading OCR's progress, the environment OCR gets, stopping process groups, and
// git against a fake GitHub over smart HTTP (the credential header, refused without it, and the
// review rules a change under review can't set for itself).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { FakeGitHub } from "../../../tests/fakes/github.ts";
import { ServerError } from "../src/client.ts";
import { loadConfig, secretFileWarning } from "../src/config.ts";
import { checkBranch, Git, gitVersionProblem, mirrorPath } from "../src/git.ts";
import { start } from "../src/process.ts";
import { readProgress } from "../src/progress.ts";
import { JobRun, ocrArgs, ocrEnv, Runner } from "../src/runner.ts";

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
        // A failed round that says how many rounds there are counts as failed too.
        const q = readProgress({}, '[ocr] Round 2/3 failed for group "src/db": timeout', new Set());
        assert.deepEqual([q.round, q.roundsFailed], ["2/3", 1]);
    });
});

describe("what the runner sends", () => {
    const secret = () => randomBytes(20).toString("hex");
    const job = () => ({
        id: "job-1",
        git: { username: "x-access-token", token: `ghs_${secret()}` },
        model: { url: "https://llm.test/v1", model: "m", apiKey: `sk-or-${secret()}`, protocol: "openai" as const, provider: "openrouter" },
    });

    test("log lines, progress and the report go out without the job's secrets, in any form", async () => {
        const j = job();
        const sent: { lines: { line: string }[]; progress: Record<string, unknown> | null }[] = [];
        const server = {
            events: async (_id: string, lines: { at: string; line: string }[], progress: Record<string, unknown> | null) => {
                sent.push({ lines, progress });
                return { cancel: false };
            },
            heartbeat: async () => ({ cancel: false }),
        };
        const run = new JobRun(j, server);
        const basic = Buffer.from(`user:${j.model.apiKey}`).toString("base64");
        run.log(`header ${basic}`);
        run.log(`hex ${Buffer.from(j.git.token).toString("hex")}`);
        run.setProgress({ phase: "reviewing", current: `src/${j.model.apiKey}` });
        await run.flush();
        const text = JSON.stringify(sent);
        assert.ok(!text.includes(j.model.apiKey) && !text.includes(basic.slice(8, -4)) && !text.includes(j.git.token), text);
        assert.equal(sent[0]?.progress?.current, "src/[redacted]");
        const report = run.redactReport({ comments: [{ path: "a.ts", content: `key ${j.model.apiKey}` }] });
        assert.ok(!JSON.stringify(report).includes(j.model.apiKey));
    });

    test("a batch the server refuses (4xx, not 409) is dropped rather than sent again and again", async () => {
        let fail: ServerError | null = new ServerError(400, "The request body isn't valid.");
        let calls = 0;
        const server = {
            events: async () => {
                calls++;
                if (fail) throw fail;
                return { cancel: false };
            },
            heartbeat: async () => ({ cancel: false }),
        };
        const run = new JobRun(job(), server);
        run.log("refused");
        await run.flush();
        assert.equal(run.pending, 0, "dropped");
        // The server being away, or failing, isn't a refusal: the lines wait for the next try.
        for (const status of [0, 502, 503]) {
            fail = new ServerError(status, "away");
            run.log(`kept ${status}`);
            await run.flush();
        }
        assert.equal(run.pending, 3);
        fail = null;
        await run.flush();
        assert.equal(run.pending, 0);
        // 409: the job isn't ours any more.
        fail = new ServerError(409, "lost");
        run.log("after");
        await run.flush();
        assert.equal(run.lost, true);
        assert.equal(calls, 6);
    });
});

describe("the runner's secret file", () => {
    test("is read at start-up, and a file others can read is warned about", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "secret-"));
        try {
            const file = path.join(dir, "runner_secret");
            const secret = randomBytes(32).toString("base64url");
            writeFileSync(file, `${secret}\n`, { mode: 0o644 });
            const env = { TRIAGENT_SERVER_URL: "http://server:8080", TRIAGENT_RUNNER_SECRET_FILE: file };
            let config = loadConfig(env);
            assert.equal(config.secret, secret);
            assert.match(config.warnings[0] ?? "", /can be read by users other than its owner \(mode 0644\)\. Make it 0400/);
            chmodSync(file, 0o400);
            config = loadConfig(env);
            assert.deepEqual(config.warnings, []);
            assert.equal(secretFileWarning(undefined), null);
            // OCR's model timeout: whole seconds, and never 0 (every call would time out at once).
            assert.equal(loadConfig({ ...env, OCR_LLM_TIMEOUT: "300" }).llmTimeout, "300");
            assert.throws(() => loadConfig({ ...env, OCR_LLM_TIMEOUT: "0" }), /OCR_LLM_TIMEOUT must be a whole number from 1/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("tokens from OCR's stderr", () => {
    test("the most OCR has said it used: its usage record, its text summary, or a budget stop", () => {
        const seen = new Set<string>();
        let p = {};
        const read = (line: string) => {
            p = readProgress(p, line, seen);
            return (p as { tokens?: number }).tokens;
        };
        assert.equal(read("[ocr] token budget: 20K (dispatch stops once exceeded)"), undefined);
        assert.equal(read("[ocr] token budget reached (used 12K + group est 22K = projected 34K > budget 20K) — skipping group"), 12_000);
        assert.equal(read('[ocr] Aggregate budget exceeded, skipping round 2 for group "src"'), 12_000);
        assert.equal(read("[ocr] token budget reached (used 1.5M + group est 22K = projected 1.5M > budget 1.2M) — skipping"), 1_500_000);
        p = {};
        // In JSON mode, a failed or stopped review writes its usage record to stderr, indented.
        for (const line of ["{", '  "status": "failed",', '  "summary": {', '    "files_reviewed": 5,', '    "total_tokens": 48213,'])
            read(line);
        assert.equal((p as { tokens?: number }).tokens, 48_213);
        assert.equal(read('    "total_tokens": 100,'), 48_213, "never goes down");
        assert.equal(read("[ocr] usage on failure: 3 file(s), 50000 input + 900 output = 50900 total tokens, 4 tool calls"), 50_900);
        // A finding's text in the report (stdout) never reaches here, but a line merely mentioning tokens isn't a figure.
        assert.equal(read("[ocr] estimated cost: ~5 file(s), est. 82K input + 26K output ≈ 108K total tokens (rough)"), 50_900);
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
                assert.ok(/^(PATH|HOME|TMPDIR|XDG_\w+|LANG|TZ|OCR_(NO_UPDATE|LLM_\w+|USE_ANTHROPIC)|GIT_\w+)$/.test(k), `unexpected ${k}`);
            assert.equal(env.OCR_USE_ANTHROPIC, "false");
            assert.equal(env.OCR_NO_UPDATE, "1");
            assert.equal(env.OCR_LLM_TIMEOUT, "300");
            // OCR reads its user config (MCP servers, setup commands) and global rules from $HOME/.opencodereview
            // (OCR_CONFIG_PATH isn't read by 1.12.12): HOME, and everywhere else it might look, is the job's own.
            assert.equal(env.HOME, "/work/home");
            for (const k of ["TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"])
                assert.ok(env[k]?.startsWith("/work/home/"), `${k} is ${env[k]}`);
            assert.equal(env.OCR_CONFIG_PATH, undefined);
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

    test("stopped, then the time limit passing while it ends: it was stopped, not timed out", async () => {
        const stop = new AbortController();
        // Ignores SIGTERM, so it's still there when the time limit comes.
        const p = start("sh", ["-c", "trap '' TERM; sleep 30"], {
            env: { PATH: process.env.PATH ?? "" },
            timeoutMs: 300,
            signal: stop.signal,
        });
        setTimeout(() => stop.abort(), 50);
        const exit = await p.done;
        assert.equal(exit.killed, true);
        assert.equal(exit.timedOut, false);
    });

    test("without a time limit it runs until it ends", async () => {
        const exit = await start("sh", ["-c", "sleep 0.5; echo done"], { env: { PATH: process.env.PATH ?? "" } }).done;
        assert.equal(exit.code, 0);
        assert.deepEqual([exit.timedOut, exit.stalled, exit.killed, exit.stdout.trim()], [false, false, false, "done"]);
    });

    test("one that goes quiet is stopped as stalled, which isn't the time limit", async () => {
        const lines: string[] = [];
        const t0 = Date.now();
        const exit = await start("sh", ["-c", "echo first >&2; sleep 30"], {
            env: { PATH: process.env.PATH ?? "" },
            stallMs: 300,
            timeoutMs: 20_000,
            onLine: (l) => lines.push(l),
        }).done;
        assert.deepEqual([exit.stalled, exit.timedOut, exit.killed], [true, false, true]);
        assert.deepEqual(lines, ["first"]);
        assert.ok(Date.now() - t0 < 5000);
    });

    test("one that keeps printing isn't stalled, however long it runs", async () => {
        // Two seconds of work, a line every 100ms: several times the quiet it's allowed.
        const exit = await start(
            "sh",
            ["-c", "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do echo $i >&2; sleep 0.1; done"],
            {
                env: { PATH: process.env.PATH ?? "" },
                stallMs: 600,
            },
        ).done;
        assert.equal(exit.code, 0);
        assert.deepEqual([exit.stalled, exit.killed], [false, false]);
    });

    test("cancelled while quiet: it was stopped, not stalled", async () => {
        const stop = new AbortController();
        const p = start("sh", ["-c", "trap '' TERM; sleep 30"], {
            env: { PATH: process.env.PATH ?? "" },
            stallMs: 300,
            signal: stop.signal,
        });
        setTimeout(() => stop.abort(), 50);
        const exit = await p.done;
        assert.deepEqual([exit.killed, exit.stalled], [true, false]);
    });

    test("a character split across stderr chunks arrives whole", async () => {
        const lines: string[] = [];
        await start("sh", ["-c", "printf '\\303' >&2; sleep 0.2; printf '\\251 done\\n' >&2"], {
            env: { PATH: process.env.PATH ?? "" },
            onLine: (l) => lines.push(l),
        }).done;
        assert.deepEqual(lines, ["\u00e9 done"]);
    });
});

describe("stopping git", () => {
    test("cancelling a review, or losing it, stops a git fetch or worktree add under way", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "slow-git-"));
        try {
            // A git that takes its time over everything, and says when it's started.
            const slowGit = path.join(dir, "git");
            writeFileSync(slowGit, `#!/bin/sh\necho started >> ${dir}/log\nexec sleep 20\n`, { mode: 0o755 });
            const git = new Git({ gitBin: slowGit, path: process.env.PATH ?? "", home: dir });
            const job = {
                kind: "pr" as const,
                cloneUrl: "https://github.example/acme/app.git",
                username: "x-access-token",
                token: "not-a-real-token",
                pr: 1,
                gitRef: null,
                baseRef: "main",
            };
            for (const step of ["fetch", "worktree"] as const) {
                const stop = new AbortController();
                const t0 = Date.now();
                const pending =
                    step === "fetch"
                        ? git.fetch(path.join(dir, `m-${step}`), job, stop.signal)
                        : git.addWorktree(path.join(dir, "m"), path.join(dir, "tree"), "a".repeat(40), null, stop.signal);
                setTimeout(() => stop.abort(), 200);
                await assert.rejects(pending, /stopped/);
                assert.ok(Date.now() - t0 < 5000, `${step} took ${Date.now() - t0}ms to stop`);
            }
            // And a JobRun stops it when it's cancelled or lost.
            const run = new JobRun(
                {
                    id: "j",
                    git: { username: "x", token: "t".repeat(10) },
                    model: { url: "u", model: "m", apiKey: "k".repeat(10), protocol: "openai", provider: "p" },
                },
                { events: async () => ({ cancel: false }), heartbeat: async () => ({ cancel: false }) },
            );
            assert.equal(run.signal.aborted, false);
            run.cancel();
            assert.equal(run.signal.aborted, true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
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

    test("a change's .gitignore files, root and nested, are put back as the base has them", async () => {
        const mirror = mirrorPath(path.join(work, "cache"), job().cloneUrl);
        await fake.commit("acme/app", "ignores-base", { "src/sub/.gitignore": "*.log\n" }, "Nested ignore", "main");
        await fake.commit(
            "acme/app",
            "ignores",
            { ".gitignore": "backdoor.ts\n", "src/sub/.gitignore": "*.ts\n", "src/backdoor.ts": "x\n", "src/sub/n.ts": "y\n" },
            "Ignore my own files",
            "ignores-base",
        );
        const got = await git.fetch(mirror, job({ kind: "changes", pr: null, gitRef: "ignores", baseRef: "ignores-base" }));
        const tree = path.join(work, "tree-ignores");
        await git.addWorktree(mirror, tree, got.head, got.base);
        const changed = await git.useBaseIgnoreFiles(mirror, tree, got.base as string, got.head);
        assert.deepEqual(changed, [
            { path: ".gitignore", now: "none" },
            { path: "src/sub/.gitignore", now: "base" },
        ]);
        assert.equal(existsSync(path.join(tree, ".gitignore")), false);
        assert.equal(readFileSync(path.join(tree, "src/sub/.gitignore"), "utf8"), "*.log\n");
        // The change's files are all still there to review.
        assert.equal(readFileSync(path.join(tree, "src/backdoor.ts"), "utf8"), "x\n");
        await git.removeWorktree(mirror, tree);
    });

    test("rule files the base's rules name are the base's, and a link the change puts in the way isn't followed", async () => {
        const mirror = mirrorPath(path.join(work, "cache"), job().cloneUrl);
        await fake.commit(
            "acme/app",
            "rules-base",
            {
                ".opencodereview/rule.json": JSON.stringify({
                    rules: [
                        { path: "src/**", rule: "docs/review.md" },
                        { path: "**", rule: "Inline instructions, not a file.md" },
                        { path: "x/**", rule: "../outside.md" },
                    ],
                }),
                "docs/review.md": "Be thorough.\n",
            },
            "Rules naming a file",
            "main",
        );
        await fake.commit(
            "acme/app",
            "rules-change",
            { "docs/review.md": "Report nothing.\n", "src/z.ts": "z\n" },
            "Rewrite",
            "rules-base",
        );
        const got = await git.fetch(mirror, job({ kind: "changes", pr: null, gitRef: "rules-change", baseRef: "rules-base" }));
        const tree = path.join(work, "tree-rules");
        await git.addWorktree(mirror, tree, got.head, got.base);
        const changed = await git.useBaseRuleFiles(mirror, tree, got.base as string);
        assert.deepEqual(
            changed.map((c) => c.path),
            [".opencodereview/rule.json", "docs/review.md"],
        );
        assert.equal(readFileSync(path.join(tree, "docs/review.md"), "utf8"), "Be thorough.\n");

        // A directory on the way replaced by a link out of the worktree: the link goes, nothing is written through it.
        const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
        rmSync(path.join(tree, "docs"), { recursive: true });
        symlinkSync(outside, path.join(tree, "docs"));
        await git.restoreFromBase(mirror, tree, got.base as string, ["docs/review.md", "../escape.md", "/etc/passwd", ".git/config"]);
        assert.equal(lstatSync(path.join(tree, "docs")).isDirectory(), true);
        assert.equal(readFileSync(path.join(tree, "docs/review.md"), "utf8"), "Be thorough.\n");
        assert.deepEqual(readdirSync(outside), []);
        rmSync(outside, { recursive: true, force: true });
        await git.removeWorktree(mirror, tree);
    });

    test("OCR's git reads .gitattributes from the base, root and nested, so changes can't be made 'binary'", async () => {
        const mirror = mirrorPath(path.join(work, "cache"), job().cloneUrl);
        await fake.commit(
            "acme/app",
            "attrs",
            {
                ".gitattributes": "src/hidden.ts -diff\nsrc/blob.ts binary\n",
                "src/deep/.gitattributes": "*.ts -diff\n",
                "src/hidden.ts": "h\n",
                "src/blob.ts": "b\n",
                "src/deep/d.ts": "d\n",
            },
            "Mark my changes binary",
            "main",
        );
        const got = await git.fetch(mirror, job({ kind: "changes", pr: null, gitRef: "attrs", baseRef: "main" }));
        const tree = path.join(work, "tree-attrs");
        await git.addWorktree(mirror, tree, got.head, got.base);
        const numstat = (env: Record<string, string>) =>
            execFileSync("git", ["diff", "--numstat", got.base as string, got.head], { cwd: tree, env, encoding: "utf8" });
        const model = { url: "https://llm.test/v1", model: "m", apiKey: "key-123456", protocol: "openai" as const, provider: "openrouter" };
        // Without the base's attributes the change's own make its files "binary" (how OCR skips them)...
        const own = numstat(ocrEnv({ path: process.env.PATH ?? "", llmTimeout: null }, work, { model }));
        assert.match(own, /^-\t-\tsrc\/hidden\.ts$/m);
        // ...with them, every change is text.
        const env = ocrEnv({ path: process.env.PATH ?? "", llmTimeout: null }, work, { model }, got.base);
        assert.equal(env.GIT_ATTR_SOURCE, got.base);
        const fixed = numstat(env);
        for (const f of ["src/hidden.ts", "src/blob.ts", "src/deep/d.ts"])
            assert.match(fixed, new RegExp(`^1\t0\t${f.replace(/\./g, "\\.")}$`, "m"));
        assert.doesNotMatch(fixed, /^-\t/m);
        await git.removeWorktree(mirror, tree);
    });

    test("git older than 2.42 can't run reviews", () => {
        assert.equal(gitVersionProblem("git version 2.42.0\n"), null);
        assert.equal(gitVersionProblem("git version 2.55.0.windows.1"), null);
        assert.equal(gitVersionProblem("git version 3.0.1"), null);
        assert.match(gitVersionProblem("git version 2.41.2") ?? "", /git 2\.41 is too old: reviews need git 2\.42 or later/);
        assert.match(gitVersionProblem("git version 1.9.5") ?? "", /too old/);
        assert.match(gitVersionProblem("not git") ?? "", /Couldn't tell which version of git/);
    });

    test("branch names are checked by git's own rules, so valid ones like fix#12 get through", () => {
        const names = [
            "main",
            "fix#12",
            "feature/x",
            "release-1.2",
            "a+b",
            "user@fix",
            "ünïcode",
            "a{b}",
            "x!y",
            "it's",
            "",
            "-x",
            "HEAD",
            "a..b",
            "a//b",
            "/x",
            "x/",
            ".x",
            "a/.b",
            "x.",
            "x.lock",
            "a/b.lock/c",
            "a b",
            "a~b",
            "a^b",
            "a:b",
            "a?b",
            "a*b",
            "a[b",
            "a\\b",
            "a@{b",
            "tab\tname",
            "del\u007f",
        ];
        for (const name of names) {
            const gitSays = (() => {
                try {
                    execFileSync("git", ["check-ref-format", "--branch", name], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
                    return true;
                } catch {
                    return false;
                }
            })();
            const oursSays = (() => {
                try {
                    checkBranch(name, "branch");
                    return true;
                } catch {
                    return false;
                }
            })();
            assert.equal(oursSays, gitSays, `${JSON.stringify(name)}: git says ${gitSays ? "valid" : "invalid"}`);
        }
        // git's --branch reads "@" as the branch checked out, not as a name: refused here.
        assert.throws(() => checkBranch("@", "branch"), /unusable branch/);
    });

    test("branch names from the server are checked before they reach git", async () => {
        const mirror = mirrorPath(path.join(work, "cache"), job().cloneUrl);
        await assert.rejects(git.fetch(mirror, job({ kind: "full", pr: null, gitRef: "--upload-pack=evil" })), /unusable branch/);
        await assert.rejects(git.fetch(mirror, job({ kind: "changes", pr: null, gitRef: "a", baseRef: "../x" })), /unusable/);
    });

    test("only an http(s) clone URL is fetched: never a protocol that runs commands", async () => {
        const mirror = mirrorPath(path.join(work, "cache"), job().cloneUrl);
        await assert.rejects(git.fetch(mirror, job({ cloneUrl: "ext::sh -c touch% /tmp/pwned" })), /isn't http/);
        await assert.rejects(git.fetch(mirror, job({ cloneUrl: "file:///etc" })), /isn't http/);
    });

    test("a branch with no history in common with its base says so", async () => {
        const mirror = mirrorPath(path.join(work, "cache"), job().cloneUrl);
        await fake.commit("acme/app", "orphan", { "o.ts": "o\n" }, "Unrelated");
        await assert.rejects(
            git.fetch(mirror, job({ kind: "changes", pr: null, gitRef: "orphan", baseRef: "main" })),
            /orphan has no history in common with main/,
        );
    });

    test("however many .gitignore files a change touches, every one is put back", async () => {
        const mirror = mirrorPath(path.join(work, "cache"), job().cloneUrl);
        await fake.commit("acme/app", "many-base", {}, "Base", "main");
        // Names that sort before the root's, to push it past any limit on how many are looked at.
        const files: Record<string, string> = { ".gitignore": "backdoor.ts\n", "backdoor.ts": "x\n" };
        for (let i = 0; i < 250; i++) files[`-pad${String(i).padStart(3, "0")}/.gitignore`] = "x\n";
        await fake.commit("acme/app", "many", files, "Lots of ignores", "many-base");
        const got = await git.fetch(mirror, job({ kind: "changes", pr: null, gitRef: "many", baseRef: "many-base" }));
        const tree = path.join(work, "tree-many");
        await git.addWorktree(mirror, tree, got.head, got.base);
        const changed = await git.useBaseIgnoreFiles(mirror, tree, got.base as string, got.head);
        assert.equal(changed.length, 251);
        assert.equal(existsSync(path.join(tree, ".gitignore")), false);
        await git.removeWorktree(mirror, tree);
    });
});

describe("a job's life", () => {
    test("every log line left at the end is sent, not just the last batch", async () => {
        let sent = 0;
        let away = true;
        const run = new JobRun(
            {
                id: "j",
                git: { username: "x", token: "t".repeat(10) },
                model: { url: "u", model: "m", apiKey: "k".repeat(10), protocol: "openai", provider: "p" },
            },
            {
                events: async (_id: string, lines: unknown[]) => {
                    if (away) throw new ServerError(503, "away");
                    sent += lines.length;
                    return { cancel: false };
                },
                heartbeat: async () => ({ cancel: false }),
            },
        );
        // The server is away while 1,200 lines come in, then back for the end.
        for (let i = 0; i < 1200; i++) run.log(`line ${i}`);
        await run.flush();
        assert.equal(run.pending, 1200);
        away = false;
        await run.end();
        assert.equal(run.pending, 0);
        assert.equal(sent, 1200);
    });

    test("a job that can't even start is reported once (a refusal isn't retried) and frees its slot", async () => {
        const finishes: string[] = [];
        const http = createServer((req, res) => {
            if (req.url?.endsWith("/finish")) finishes.push(req.url);
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "No." }));
        });
        await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
        const dir = mkdtempSync(path.join(tmpdir(), "runner-life-"));
        try {
            const runner = new Runner({
                serverUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
                secret: "s".repeat(40),
                name: "test",
                concurrency: 1,
                cacheDir: path.join(dir, "cache"),
                workDir: path.join(dir, "work"),
                pollMs: 1000,
                healthPort: null,
                ocrBin: "ocr",
                gitBin: "git",
                llmTimeout: null,
                path: process.env.PATH ?? "",
                warnings: [],
            });
            // The work directory has gone, so not even the job's own directory can be made.
            rmSync(path.join(dir, "work"), { recursive: true, force: true });
            const t0 = Date.now();
            await runner.execute({
                id: "job-x",
                kind: "full",
                title: "t",
                leaseSeconds: 60,
                repository: { fullName: "acme/app", cloneUrl: "https://github.example/acme/app.git" },
                git: { username: "x", token: "t".repeat(10) },
                pr: null,
                gitRef: "main",
                baseRef: null,
                headSha: null,
                timeoutMinutes: 1,
                maxTokensBudget: null,
                model: { url: "u", model: "m", apiKey: "k".repeat(10), protocol: "openai", provider: "p" },
            });
            assert.equal(runner.running, 0);
            assert.deepEqual(finishes, ["/internal/runner/jobs/job-x/finish"]);
            assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
        } finally {
            http.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("time limits and stalled reviews", () => {
    const FAKE_OCR = path.resolve(import.meta.dirname, "../../../tests/fakes/ocr.ts");
    const token = `github_pat_${"s".repeat(30)}`;
    let fake: FakeGitHub;
    let dir: string;
    let runner: Runner;
    let http: ReturnType<typeof createServer>;
    /** What the runner told the server: each job's log, and how it ended. */
    const logs = new Map<string, string[]>();
    const outcomes = new Map<string, { status: string; error?: string | null; report?: { comments?: unknown[] }; parts?: unknown[] }>();

    before(async () => {
        fake = await new FakeGitHub().start();
        await fake.gitRepo("acme/app", { "src/a.ts": "export const a = 1;\n" });
        fake.pat(token, "octo", ["acme/app"]);
        http = createServer((req, res) => {
            let body = "";
            req.on("data", (d) => {
                body += d;
            });
            req.on("end", () => {
                const [, id, what] = /\/jobs\/([^/]+)\/(\w+)$/.exec(req.url ?? "") ?? [];
                const sent = JSON.parse(body || "{}");
                if (id && what === "events")
                    logs.set(id, [...(logs.get(id) ?? []), ...(sent.lines as { line: string }[]).map((l) => l.line)]);
                if (id && what === "finish") outcomes.set(id, sent);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ cancel: false, ok: true }));
            });
        });
        await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
        dir = mkdtempSync(path.join(tmpdir(), "runner-limits-"));
        runner = new Runner({
            serverUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
            secret: "s".repeat(40),
            name: "test",
            concurrency: 1,
            cacheDir: path.join(dir, "cache"),
            workDir: path.join(dir, "work"),
            pollMs: 1000,
            healthPort: null,
            ocrBin: FAKE_OCR,
            gitBin: "git",
            llmTimeout: null,
            path: process.env.PATH ?? "",
            warnings: [],
        });
    });
    after(async () => {
        http.close();
        await fake.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    /** Run a full scan with the fake `ocr` behaving as `model` says, and return how the runner said it went. */
    const scan = async (id: string, model: string, limits: { timeoutMinutes?: number | null; stallMinutes?: number | null }) => {
        await runner.execute({
            id,
            kind: "full",
            title: "t",
            leaseSeconds: 60,
            repository: { fullName: "acme/app", cloneUrl: `${fake.url}/acme/app.git` },
            git: { username: "x-access-token", token },
            pr: null,
            gitRef: "main",
            baseRef: null,
            headSha: null,
            maxTokensBudget: null,
            model: { url: "https://llm.test/v1", model, apiKey: "k".repeat(20), protocol: "openai", provider: "openrouter" },
            ...limits,
        });
        const outcome = outcomes.get(id);
        assert.ok(outcome, `${id} was reported`);
        return { outcome, log: (logs.get(id) ?? []).join("\n") };
    };

    test("with no limits a review runs to the end, and a server that sends none means none", async () => {
        const { outcome, log } = await scan("none", "fake/silent-1", { timeoutMinutes: null, stallMinutes: null });
        assert.equal(outcome.status, "done", outcome.error ?? "");
        assert.equal(outcome.report?.comments?.length, 1);
        assert.match(log, /with fake\/silent-1 via openrouter\. No time limit\.$/m);
        const absent = await scan("absent", "fake/model", {});
        assert.equal(absent.outcome.status, "done", absent.outcome.error ?? "");
        assert.match(absent.log, /No time limit\.$/m);
    });

    test("a review that prints nothing for the stall time is stopped as stalled, not as over its time limit", async () => {
        const t0 = Date.now();
        // 0.01 minutes: 600ms of silence, in a review allowed 5 minutes.
        const { outcome, log } = await scan("silent", "fake/silent-30", { timeoutMinutes: 5, stallMinutes: 0.01 });
        assert.equal(outcome.status, "failed");
        assert.match(outcome.error ?? "", /^Stalled: Open Code Review printed nothing for 0\.01 minutes, so it was stopped/);
        assert.doesNotMatch(outcome.error ?? "", /time limit/);
        assert.equal(outcome.report, undefined);
        assert.match(log, /Time limit: 5 minutes\. Stopped as stalled if it prints nothing for 0\.01 minutes\.$/m);
        assert.match(log, /\[triagent\] Stalled: /);
        assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0}ms`);
    });

    test("a review that keeps printing isn't stalled, however long it takes", async () => {
        // Two seconds of work, a few lines every 100ms, with 600ms of silence allowed.
        const { outcome } = await scan("chatty", "fake/sleep-2", { timeoutMinutes: null, stallMinutes: 0.01 });
        assert.equal(outcome.status, "done", outcome.error ?? "");
        assert.equal(outcome.report?.comments?.length, 1);
    });

    test("the time limit still stops a review that keeps printing", async () => {
        const { outcome } = await scan("slow", "fake/sleep-30", { timeoutMinutes: 0.01, stallMinutes: 30 });
        assert.equal(outcome.status, "failed");
        assert.match(outcome.error ?? "", /^Stopped after 0\.01 minutes, the project's time limit/);
    });

    test("with several models, a stalled one fails and the others' findings are kept", async () => {
        const model = (name: string) => ({
            url: "https://llm.test/v1",
            model: name,
            apiKey: "k".repeat(20),
            protocol: "openai" as const,
            provider: "openrouter",
            label: name,
        });
        await runner.execute({
            id: "several",
            kind: "full",
            title: "t",
            leaseSeconds: 60,
            repository: { fullName: "acme/app", cloneUrl: `${fake.url}/acme/app.git` },
            git: { username: "x-access-token", token },
            pr: null,
            gitRef: "main",
            baseRef: null,
            headSha: null,
            maxTokensBudget: null,
            timeoutMinutes: null,
            stallMinutes: 0.01,
            model: model("fake/silent-30"),
            models: [model("fake/silent-30"), model("fake/model")],
        });
        const outcome = outcomes.get("several");
        assert.equal(outcome?.status, "done");
        const parts = outcome?.parts as { status: string; error?: string }[];
        assert.deepEqual(
            parts.map((p) => p.status),
            ["failed", "done"],
        );
        assert.match(parts[0]?.error ?? "", /^Stalled: /);
    });

    test("a model with a token budget of its own is given that; the others, the job's", async () => {
        const model = (name: string, extra: object = {}) => ({
            url: "https://llm.test/v1",
            model: name,
            apiKey: "k".repeat(20),
            protocol: "openai" as const,
            provider: "openrouter",
            label: name,
            ...extra,
        });
        await runner.execute({
            id: "budgets",
            kind: "full",
            title: "t",
            leaseSeconds: 60,
            repository: { fullName: "acme/app", cloneUrl: `${fake.url}/acme/app.git` },
            git: { username: "x-access-token", token },
            pr: null,
            gitRef: "main",
            baseRef: null,
            headSha: null,
            maxTokensBudget: 30_000,
            model: model("fake/model"),
            models: [model("fake/model"), model("fake/a", { maxTokensBudget: 12_000 }), model("fake/b", { maxTokensBudget: null })],
        });
        assert.equal(outcomes.get("budgets")?.status, "done");
        const args = (logs.get("budgets") ?? [])
            .filter((l) => l.includes("[fake-ocr] args: "))
            .map((l) => l.replace(/^.*--color never ?/, ""));
        assert.deepEqual(args, ["--max-tokens-budget 30000", "--max-tokens-budget 12000", ""]);
    });
});
