// Several reviews at once: one fetch at a time into a repository's mirror (among a runner's own jobs
// and between runners sharing a cache directory), none waiting on another repository's, a cancel while
// waiting, a lock left by a dead process, and worktrees that only their own job removes.
//
// Fetches are held open by a stand-in for git that waits while a file exists, and writes down when each
// fetch started and ended, so the tests see exactly what overlapped.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { FakeGitHub } from "../../../tests/fakes/github.ts";
import type { ClaimedJob } from "../src/client.ts";
import { Git, mirrorPath } from "../src/git.ts";
import { LockAborted, type LockOptions, LockUnusable, PathLocks } from "../src/lock.ts";
import { Runner } from "../src/runner.ts";

const FAKE_OCR = path.resolve(import.meta.dirname, "../../../tests/fakes/ocr.ts");
const WAITING = "Waiting for another review's fetch of this repository";

async function eventually<T>(check: () => T | null | undefined | false, what: string, ms = 10_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = check();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
        await sleep(20);
    }
}

describe("the lock on a path in the cache", () => {
    let dir: string;
    before(() => {
        dir = mkdtempSync(path.join(tmpdir(), "runner-lock-"));
    });
    after(() => rmSync(dir, { recursive: true, force: true }));
    const quick: LockOptions = { staleMs: 300, pollMs: 20 };
    /** Where a holder is still alive: long enough that a busy machine delaying its refresh isn't taken for its death. */
    const patient: LockOptions = { staleMs: 5000, pollMs: 20 };

    test("one holder at a time, in turn, within a process and between two", async () => {
        const target = path.join(dir, "turns.git");
        const [a, b] = [new PathLocks(patient), new PathLocks(patient)];
        let holding = 0;
        let most = 0;
        const order: number[] = [];
        const work = (locks: PathLocks, i: number) =>
            locks.hold(target, async () => {
                most = Math.max(most, ++holding);
                order.push(i);
                await sleep(30);
                holding--;
            });
        await Promise.all([work(a, 1), work(a, 2), work(b, 3), work(a, 4), work(b, 5)]);
        assert.equal(most, 1);
        assert.equal(order.length, 5);
        // Within one process, first come first served.
        assert.deepEqual(
            order.filter((i) => [1, 2, 4].includes(i)),
            [1, 2, 4],
        );
        assert.equal(existsSync(PathLocks.dir(target)), false, "nothing is left behind");
    });

    test("a holder that takes longer than the stale time keeps its lock, because it keeps refreshing it", async () => {
        const target = path.join(dir, "slow.git");
        const brief: LockOptions = { staleMs: 500, pollMs: 20 };
        const [a, b] = [new PathLocks(brief), new PathLocks(brief)];
        let released = 0;
        let waited = false;
        const first = a.hold(target, async () => {
            await sleep(1500);
            released = Date.now();
        });
        await sleep(50);
        const got = await b.hold(target, async () => Date.now(), { onWait: () => (waited = true) });
        await first;
        assert.ok(waited);
        assert.ok(got >= released, "the second waited for the first to finish");
    });

    test("a lock left by a process that died is taken over, but not before it has gone unrefreshed for the stale time", async () => {
        const target = path.join(dir, "dead.git");
        mkdirSync(PathLocks.dir(target));
        const left = path.join(PathLocks.dir(target), "4242-deadbeef");
        writeFileSync(left, "17");
        // Its clock was a year ahead: how old the file says it is decides nothing.
        const future = new Date(Date.now() + 365 * 86_400_000);
        utimesSync(left, future, future);
        const t0 = Date.now();
        let waited = false;
        await new PathLocks(quick).hold(target, async () => {}, { onWait: () => (waited = true) });
        assert.ok(waited);
        assert.ok(Date.now() - t0 >= 300, `taken over after ${Date.now() - t0}ms`);
        assert.equal(existsSync(PathLocks.dir(target)), false);
    });

    test("two waiters taking over the same dead lock still go one at a time", async () => {
        const target = path.join(dir, "dead-two.git");
        mkdirSync(PathLocks.dir(target));
        writeFileSync(path.join(PathLocks.dir(target), "4242-deadbeef"), "17");
        let holding = 0;
        let most = 0;
        const work = () =>
            new PathLocks(quick).hold(target, async () => {
                most = Math.max(most, ++holding);
                await sleep(100);
                holding--;
            });
        await Promise.all([work(), work(), work()]);
        assert.equal(most, 1);
    });

    test("a wait that's aborted ends at once, leaves nothing behind, and doesn't let the next in line jump the holder", async () => {
        const target = path.join(dir, "abort.git");
        const [a, b] = [new PathLocks(patient), new PathLocks(patient)];
        let free = () => {};
        const held = a.hold(target, () => new Promise<void>((r) => (free = r)));
        await sleep(30);
        const order: string[] = [];
        for (const locks of [a, b]) {
            const stop = new AbortController();
            const waiting = locks.hold(target, async () => order.push("aborted one ran"), { signal: stop.signal });
            const after = locks.hold(target, async () => order.push("next"));
            await sleep(60);
            const t0 = Date.now();
            stop.abort();
            await assert.rejects(waiting, LockAborted);
            assert.ok(Date.now() - t0 < 200);
            assert.deepEqual(order, [], "the one behind still waits for the holder");
            assert.deepEqual(readdirSync(PathLocks.dir(target)).length, 1, "only the holder's file is in the lock");
            assert.deepEqual(
                readdirSync(dir).filter((n) => n.startsWith("abort.git")),
                ["abort.git.lock"],
            );
            free();
            await held;
            await after;
            assert.deepEqual(order, ["next"]);
            order.length = 0;
            // Hold it again for the second round (the other process's waiters).
            if (locks === a) void a.hold(target, () => new Promise<void>((r) => (free = r)));
            await sleep(30);
        }
        free();
        await eventually(() => !existsSync(PathLocks.dir(target)), "the lock to be released");
    });

    test("a lock that's free is taken without a word about waiting, straight after another's turn too", async () => {
        const target = path.join(dir, "free.git");
        const locks = new PathLocks(patient);
        let waited = 0;
        for (let i = 0; i < 3; i++) await locks.hold(target, async () => {}, { onWait: () => waited++ });
        assert.equal(waited, 0);
        // One that does wait still says so, once.
        let free = () => {};
        const held = locks.hold(target, () => new Promise<void>((r) => (free = r)));
        const next = locks.hold(target, async () => {}, { onWait: () => waited++ });
        await sleep(60);
        free();
        await Promise.all([held, next]);
        assert.equal(waited, 1);
    });

    test("what a process killed while taking the lock left beside it goes with the next to take it, once it's a day old", async () => {
        const target = path.join(dir, "killed.git");
        const [old, recent] = [`${PathLocks.dir(target)}.4242-dead`, `${PathLocks.dir(target)}.4243-live`];
        for (const at of [old, recent]) {
            mkdirSync(at);
            writeFileSync(path.join(at, path.basename(at).split(".").pop() as string), "0");
        }
        const then = new Date(Date.now() - 25 * 60 * 60_000);
        utimesSync(old, then, then);
        // Another path's is not this lock's to remove.
        const other = `${PathLocks.dir(path.join(dir, "killed.git2"))}.4244-dead`;
        mkdirSync(other);
        utimesSync(other, then, then);
        await new PathLocks(quick).hold(target, async () => {});
        assert.deepEqual(
            readdirSync(dir)
                .filter((n) => n.startsWith("killed.git"))
                .sort(),
            [path.basename(recent), path.basename(other)].sort(),
        );
    });

    test("already aborted: never takes the lock", async () => {
        const stop = new AbortController();
        stop.abort();
        let ran = false;
        await assert.rejects(
            new PathLocks(quick).hold(
                path.join(dir, "never.git"),
                async () => {
                    ran = true;
                },
                { signal: stop.signal },
            ),
            LockAborted,
        );
        assert.equal(ran, false);
        assert.equal(existsSync(path.join(dir, "never.git.lock")), false);
    });

    test("a cache directory that has gone is made again; one that can't be written to fails at once, saying so", async (t) => {
        const gone = path.join(dir, "gone", "cache");
        assert.equal(await new PathLocks(quick).hold(path.join(gone, "x.git"), async () => "ran"), "ran");
        if (process.getuid?.() === 0) return t.skip("root can write anywhere");
        const readOnly = path.join(dir, "read-only");
        mkdirSync(readOnly);
        chmodSync(readOnly, 0o500);
        const t0 = Date.now();
        await assert.rejects(
            new PathLocks(quick).hold(path.join(readOnly, "x.git"), async () => {}),
            (err: Error) => err instanceof LockUnusable && /can't write to its cache directory \(RUNNER_CACHE_DIR/.test(err.message),
        );
        assert.ok(Date.now() - t0 < 500);
        chmodSync(readOnly, 0o700);
    });

    test("what a failing job throws comes out as it is, and the lock is released", async () => {
        const target = path.join(dir, "throws.git");
        const locks = new PathLocks(quick);
        await assert.rejects(
            locks.hold(target, async () => {
                throw new Error("fetch failed");
            }),
            /fetch failed/,
        );
        assert.equal(await locks.hold(target, async () => 1), 1);
    });
});

describe("several reviews at once", () => {
    const token = `github_pat_${"c".repeat(30)}`;
    let fake: FakeGitHub;
    let dir: string;
    let gitBin: string;
    let http: ReturnType<typeof createServer>;
    let url: string;
    const logs = new Map<string, string[]>();
    const outcomes = new Map<string, { status: string; error?: string | null; report?: { comments?: unknown[] } }>();
    /** Jobs the server says are cancelled, the next time their runner reports in. */
    const cancelled = new Set<string>();
    const runners: Runner[] = [];

    const hold = () => writeFileSync(path.join(dir, "hold"), "");
    const release = () => rmSync(path.join(dir, "hold"), { force: true });
    /** Each fetch's start and end, in order, with the mirror it was into. */
    const fetches = () =>
        existsSync(path.join(dir, "fetch.log"))
            ? readFileSync(path.join(dir, "fetch.log"), "utf8")
                  .split("\n")
                  .filter(Boolean)
                  .map((l) => l.split(" ") as [string, string])
            : [];
    const log = (id: string) => (logs.get(id) ?? []).join("\n");

    before(async () => {
        fake = await new FakeGitHub().start();
        await fake.gitRepo("acme/app", { "src/a.ts": "export const a = 1;\n" });
        await fake.gitRepo("acme/lib", { "src/b.ts": "export const b = 2;\n" });
        fake.pat(token, "octo", ["acme/app", "acme/lib"]);
        http = createServer((req, res) => {
            let body = "";
            req.on("data", (d) => {
                body += d;
            });
            req.on("end", () => {
                const [, id, what] = /\/jobs\/([^/]+)\/(\w+)$/.exec(req.url ?? "") ?? [];
                const sent = JSON.parse(body || "{}");
                if (id && what === "events")
                    logs.set(id, [...(logs.get(id) ?? []), ...((sent.lines ?? []) as { line: string }[]).map((l) => l.line)]);
                if (id && what === "finish") outcomes.set(id, sent);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ cancel: Boolean(id && cancelled.has(id)), ok: true }));
            });
        });
        await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
        url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
        dir = mkdtempSync(path.join(tmpdir(), "runner-concurrent-"));
        // git, but a fetch waits while `hold` exists and is written down as it starts and ends.
        gitBin = path.join(dir, "git-held");
        writeFileSync(
            gitBin,
            `#!/bin/sh
dir="$(dirname "$0")"
if [ "$3" = "fetch" ]; then
    echo "start $2" >> "$dir/fetch.log"
    while [ -e "$dir/hold" ]; do sleep 0.02; done
    git "$@"
    code=$?
    echo "end $2" >> "$dir/fetch.log"
    exit $code
fi
exec git "$@"
`,
            { mode: 0o755 },
        );
    });
    afterEach(() => {
        release();
        rmSync(path.join(dir, "fetch.log"), { force: true });
    });
    after(async () => {
        await Promise.all(runners.map((r) => r.stop()));
        http.close();
        await fake.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    /** A runner with a work directory of its own, on the cache directory named. */
    const runner = (cache: string, locks: LockOptions = {}) => {
        const r = new Runner(
            {
                serverUrl: url,
                secret: "s".repeat(40),
                name: `test-${runners.length + 1}`,
                concurrency: 2,
                modelParallelism: 5,
                overBudgetGraceSeconds: 0,
                cacheDir: path.join(dir, cache),
                workDir: path.join(dir, `work-${runners.length + 1}`),
                pollMs: 1000,
                healthPort: null,
                ocrBin: FAKE_OCR,
                gitBin,
                llmTimeout: null,
                path: process.env.PATH ?? "",
                warnings: [],
                log: { level: "info", format: "text" },
                relayLogs: false,
                stopMode: "drain",
            },
            locks,
        );
        runners.push(r);
        return r;
    };
    const job = (id: string, repo = "acme/app"): ClaimedJob => ({
        id,
        kind: "full",
        title: "t",
        leaseSeconds: 60,
        repository: { fullName: repo, cloneUrl: `${fake.url}/${repo}.git` },
        git: { username: "x-access-token", token },
        pr: null,
        gitRef: "main",
        baseRef: null,
        headSha: null,
        timeoutMinutes: null,
        maxTokensBudget: null,
        model: { url: "https://llm.test/v1", model: "fake/model", apiKey: "k".repeat(20), protocol: "openai", provider: "openrouter" },
    });
    const mirrorOf = (cache: string, repo = "acme/app") => mirrorPath(path.join(dir, cache), `${fake.url}/${repo}.git`);
    /** Nothing of a finished job is left in the cache: no lock, and no record of its worktree in the mirror. */
    const tidy = (cache: string, repo = "acme/app") => {
        const mirror = mirrorOf(cache, repo);
        assert.equal(existsSync(PathLocks.dir(mirror)), false, "the lock is released");
        assert.deepEqual(existsSync(path.join(mirror, "worktrees")) ? readdirSync(path.join(mirror, "worktrees")) : [], []);
        assert.deepEqual(
            readdirSync(path.join(dir, cache)).filter((n) => !n.endsWith(".git")),
            [],
        );
    };
    /** No fetch into a mirror started while another into the same mirror was going. */
    const oneAtATime = () => {
        const going = new Set<string>();
        for (const [what, mirror] of fetches()) {
            if (what === "start") {
                assert.equal(going.has(mirror), false, `two fetches into ${mirror} at once`);
                going.add(mirror);
            } else going.delete(mirror);
        }
    };

    test("two reviews of one repository: the second waits for the first's fetch, and says so in its log", async () => {
        const r = runner("cache-same");
        hold();
        const first = r.execute(job("same-1"));
        await eventually(() => fetches().length === 1, "the first fetch to start");
        const second = r.execute(job("same-2"));
        await eventually(() => log("same-2").includes(WAITING), "the second to say it's waiting");
        assert.equal(fetches().length, 1, "the second hasn't started fetching");
        assert.equal(r.running, 2);
        release();
        await Promise.all([first, second]);
        for (const id of ["same-1", "same-2"]) {
            assert.equal(outcomes.get(id)?.status, "done", JSON.stringify(outcomes.get(id)));
            assert.equal(outcomes.get(id)?.report?.comments?.length, 1);
        }
        assert.equal(log("same-1").includes(WAITING), false);
        assert.equal(fetches().filter(([what]) => what === "start").length, 2);
        oneAtATime();
        tidy("cache-same");
    });

    test("reviews at once on one mirror each keep a worktree of their own until they end", async () => {
        const r = runner("cache-trees");
        // Both are reviewing (the fake takes two seconds) on worktrees of the same mirror at the same time.
        const slow = (id: string) => ({ ...job(id), model: { ...job(id).model, model: "fake/sleep-2" } });
        const both = [r.execute(slow("trees-1")), r.execute(slow("trees-2"))];
        const records = path.join(mirrorOf("cache-trees"), "worktrees");
        const names = await eventually(() => {
            const n = existsSync(records) ? readdirSync(records) : [];
            return n.length === 2 && n.every((x) => existsSync(path.join(records, x, "locked"))) ? n : null;
        }, "two worktrees in the mirror");
        // What `git fetch` does when it tidies, and what another runner sharing the cache might: nothing of theirs goes.
        execFileSync("git", ["--git-dir", mirrorOf("cache-trees"), "worktree", "prune"]);
        assert.deepEqual(readdirSync(records).sort(), [...names].sort());
        await Promise.all(both);
        for (const id of ["trees-1", "trees-2"]) assert.equal(outcomes.get(id)?.status, "done", JSON.stringify(outcomes.get(id)));
        tidy("cache-trees");
    });

    test("reviews of different repositories don't wait on each other", async () => {
        const r = runner("cache-different");
        hold();
        const both = [r.execute(job("diff-app", "acme/app")), r.execute(job("diff-lib", "acme/lib"))];
        // Both are fetching at once, each into its own mirror.
        await eventually(() => fetches().length === 2, "both fetches to start");
        assert.deepEqual(
            fetches().map(([what]) => what),
            ["start", "start"],
        );
        assert.notEqual(fetches()[0]?.[1], fetches()[1]?.[1]);
        release();
        await Promise.all(both);
        for (const id of ["diff-app", "diff-lib"]) {
            assert.equal(outcomes.get(id)?.status, "done", JSON.stringify(outcomes.get(id)));
            assert.equal(log(id).includes(WAITING), false);
        }
        tidy("cache-different", "acme/app");
        tidy("cache-different", "acme/lib");
    });

    test("a review cancelled while it waits for another's fetch stops at once and leaves no lock; the other is untouched", async () => {
        const r = runner("cache-cancel");
        const mirror = mirrorOf("cache-cancel");
        hold();
        const first = r.execute(job("cancel-holder"));
        await eventually(() => fetches().length === 1, "the first fetch to start");
        const second = r.execute(job("cancel-waiter"));
        await eventually(() => log("cancel-waiter").includes(WAITING), "the second to say it's waiting");
        // The server's answer to its next batch of log lines or heartbeat: stop.
        cancelled.add("cancel-waiter");
        (r as unknown as { active: Map<string, { say(line: string): void }> }).active.get("cancel-waiter")?.say("still here");
        await second;
        assert.equal(outcomes.get("cancel-waiter")?.status, "cancelled", JSON.stringify(outcomes.get("cancel-waiter")));
        assert.equal(outcomes.has("cancel-holder"), false, "the first is still fetching");
        assert.equal(fetches().length, 1, "the cancelled one never fetched");
        assert.equal(readdirSync(PathLocks.dir(mirror)).length, 1, "only the first's lock is there");
        assert.equal(r.running, 1);
        release();
        await first;
        assert.equal(outcomes.get("cancel-holder")?.status, "done", JSON.stringify(outcomes.get("cancel-holder")));
        tidy("cache-cancel");
        // And the next review of the repository has nothing to wait for.
        await r.execute(job("cancel-next"));
        assert.equal(outcomes.get("cancel-next")?.status, "done");
        assert.equal(log("cancel-next").includes(WAITING), false);
    });

    test("a review cancelled while it fetches lets the one waiting go ahead", async () => {
        const r = runner("cache-cancel-holder");
        hold();
        const first = r.execute(job("stopped-holder"));
        await eventually(() => fetches().length === 1, "the first fetch to start");
        const second = r.execute(job("stopped-waiter"));
        await eventually(() => log("stopped-waiter").includes(WAITING), "the second to say it's waiting");
        cancelled.add("stopped-holder");
        (r as unknown as { active: Map<string, { say(line: string): void }> }).active.get("stopped-holder")?.say("still here");
        await first;
        assert.equal(outcomes.get("stopped-holder")?.status, "cancelled");
        // The second takes its turn (its own fetch is then held, until released).
        await eventually(() => fetches().filter(([what]) => what === "start").length === 2, "the second fetch to start");
        release();
        await second;
        assert.equal(outcomes.get("stopped-waiter")?.status, "done", JSON.stringify(outcomes.get("stopped-waiter")));
        tidy("cache-cancel-holder");
    });

    test("a lock left by a runner that died is taken over, and the review runs", async () => {
        const r = runner("cache-stale", { staleMs: 400, pollMs: 25 });
        const mirror = mirrorOf("cache-stale");
        mkdirSync(PathLocks.dir(mirror), { recursive: true });
        writeFileSync(path.join(PathLocks.dir(mirror), "31337-0123456789abcdef"), "5");
        const t0 = Date.now();
        await r.execute(job("stale-1"));
        assert.equal(outcomes.get("stale-1")?.status, "done", JSON.stringify(outcomes.get("stale-1")));
        assert.ok(Date.now() - t0 >= 400);
        assert.ok(log("stale-1").includes(WAITING));
        tidy("cache-stale");
    });

    test("two runners sharing one cache directory fetch into a mirror one at a time", async () => {
        const [a, b] = [runner("cache-shared", { staleMs: 600, pollMs: 25 }), runner("cache-shared", { staleMs: 600, pollMs: 25 })];
        hold();
        const first = a.execute(job("shared-a"));
        await eventually(() => fetches().length === 1, "the first runner's fetch to start");
        const second = b.execute(job("shared-b"));
        await eventually(() => log("shared-b").includes(WAITING), "the second runner to say it's waiting");
        // Held for longer than the stale time: the first runner keeps its lock by refreshing it.
        await sleep(1200);
        assert.equal(fetches().length, 1, "the second runner hasn't started fetching");
        release();
        await Promise.all([first, second, a.execute(job("shared-a2")), b.execute(job("shared-b2"))]);
        for (const id of ["shared-a", "shared-b", "shared-a2", "shared-b2"])
            assert.equal(outcomes.get(id)?.status, "done", JSON.stringify(outcomes.get(id)));
        assert.equal(fetches().filter(([what]) => what === "start").length, 4);
        oneAtATime();
        tidy("cache-shared");
    });

    test("a cache directory the runner can't write to fails the review at once, saying so", async (t) => {
        if (process.getuid?.() === 0) return t.skip("root can write anywhere");
        const r = runner("cache-read-only");
        chmodSync(path.join(dir, "cache-read-only"), 0o500);
        const t0 = Date.now();
        await r.execute(job("read-only-1"));
        chmodSync(path.join(dir, "cache-read-only"), 0o700);
        assert.equal(outcomes.get("read-only-1")?.status, "failed");
        assert.match(outcomes.get("read-only-1")?.error ?? "", /can't write to its cache directory \(RUNNER_CACHE_DIR/);
        assert.ok(Date.now() - t0 < 3000);
        assert.equal(r.running, 0);
    });

    test("a runner says how many reviews it works on at once, and how many more it can take", async () => {
        const r = runner("cache-identity");
        assert.deepEqual([r.identity().slots, r.identity().capacity], [2, 2]);
        hold();
        const one = r.execute(job("identity-1"));
        await eventually(() => fetches().length === 1, "the fetch to start");
        assert.deepEqual([r.identity().slots, r.identity().capacity], [1, 2]);
        release();
        await one;
        assert.deepEqual([r.identity().slots, r.identity().capacity], [2, 2]);
    });
});

describe("worktrees in a shared mirror", () => {
    let fake: FakeGitHub;
    let dir: string;
    let git: Git;
    let mirror: string;
    let head: string;
    const token = `github_pat_${"w".repeat(30)}`;

    before(async () => {
        fake = await new FakeGitHub().start();
        await fake.gitRepo("acme/app", { "a.ts": "1\n" });
        fake.pat(token, "octo", ["acme/app"]);
        dir = mkdtempSync(path.join(tmpdir(), "runner-worktrees-"));
        git = new Git({ gitBin: "git", path: process.env.PATH ?? "", home: path.join(dir, "home") });
        mkdirSync(path.join(dir, "home"));
        mirror = path.join(dir, "mirror.git");
        const cloneUrl = `${fake.url}/acme/app.git`;
        head = (await git.fetch(mirror, { kind: "full", cloneUrl, username: "x", token, pr: null, gitRef: "main", baseRef: null })).head;
    });
    after(async () => {
        await fake.stop();
        rmSync(dir, { recursive: true, force: true });
    });
    const records = () => (existsSync(path.join(mirror, "worktrees")) ? readdirSync(path.join(mirror, "worktrees")) : []);

    test("removing one job's worktree leaves another's alone, even one whose directory this runner can't see", async () => {
        // Every job's worktree is at <its own directory>/tree: git gives each a record of its own.
        const [mine, theirs] = [path.join(dir, "job-1", "tree"), path.join(dir, "job-2", "tree")];
        await git.addWorktree(mirror, mine, head);
        await git.addWorktree(mirror, theirs, head);
        assert.equal(records().length, 2);
        // The other is in another container's work directory: from here, it doesn't exist.
        rmSync(path.join(dir, "job-2"), { recursive: true, force: true });
        await git.removeWorktree(mirror, mine);
        assert.equal(existsSync(mine), false);
        assert.equal(records().length, 1, "the other job's record is still there");
        await git.removeWorktree(mirror, theirs);
        assert.deepEqual(records(), []);
    });

    test("a worktree half made, or already deleted, still has its record removed", async () => {
        const tree = path.join(dir, "job-3", "tree");
        await git.addWorktree(mirror, tree, head);
        rmSync(tree, { recursive: true, force: true });
        await git.removeWorktree(mirror, tree);
        assert.deepEqual(records(), []);
    });

    test("records left by a runner that died go once they've not been kept for a day; a running review keeps its own", async () => {
        const [dead, alive] = [path.join(dir, "job-4", "tree"), path.join(dir, "job-5", "tree")];
        await git.addWorktree(mirror, dead, head);
        await git.addWorktree(mirror, alive, head);
        const old = new Date(Date.now() - 25 * 60 * 60_000);
        for (const name of records()) utimesSync(path.join(mirror, "worktrees", name, "locked"), old, old);
        git.keepWorktree(mirror, alive);
        assert.equal(git.sweepWorktrees(mirror), 1);
        assert.equal(records().length, 1);
        assert.equal(existsSync(path.join(alive, "a.ts")), true);
        assert.equal(execFileSync("git", ["-C", alive, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
        // A worktree someone locked by hand isn't a runner's to remove.
        const manual = path.join(dir, "manual");
        execFileSync("git", ["--git-dir", mirror, "worktree", "add", "--lock", "--detach", "--quiet", manual, head]);
        for (const name of records()) utimesSync(path.join(mirror, "worktrees", name, "locked"), old, old);
        git.keepWorktree(mirror, alive);
        assert.equal(git.sweepWorktrees(mirror), 0);
        assert.equal(records().length, 2);
        await git.removeWorktree(mirror, alive);
        execFileSync("git", ["--git-dir", mirror, "worktree", "remove", "--force", "--force", manual]);
        assert.deepEqual(records(), []);
    });

    test("records nothing keeps go too, after more than a week: unlocked, half added, or broken; a newer one stays", async () => {
        const worktrees = path.join(mirror, "worktrees");
        const add = (name: string, ...lock: string[]) => {
            const had = records();
            execFileSync("git", [
                "--git-dir",
                mirror,
                "worktree",
                "add",
                ...lock,
                "--detach",
                "--quiet",
                path.join(dir, "unkept", name, "tree"),
                head,
            ]);
            return records().find((r) => !had.includes(r)) as string;
        };
        /** Make everything in a record look `days` old. */
        const age = (name: string, days: number) => {
            const then = new Date(Date.now() - days * 24 * 60 * 60_000);
            const at = path.join(worktrees, name);
            for (const entry of readdirSync(at)) utimesSync(path.join(at, entry), then, then);
            utimesSync(at, then, then);
        };
        // An earlier version's (never locked), one git was killed while adding, and one with no `gitdir`.
        const unlocked = add("unlocked");
        const adding = add("adding", "--lock", "--reason", "initializing");
        const broken = add("broken");
        rmSync(path.join(worktrees, broken, "gitdir"));
        const recent = add("recent");
        const manual = add("manual", "--lock", "--reason", "mine");
        for (const name of [unlocked, adding, broken, manual]) age(name, 9);
        age(recent, 2);
        // Something in a record changed since: it isn't abandoned yet.
        const touched = add("touched");
        age(touched, 9);
        utimesSync(path.join(worktrees, touched, "HEAD"), new Date(), new Date());
        assert.equal(git.sweepWorktrees(mirror), 3);
        assert.deepEqual(records().sort(), [recent, manual, touched].sort());
        age(recent, 9);
        age(touched, 9);
        assert.equal(git.sweepWorktrees(mirror), 2);
        assert.deepEqual(records(), [manual]);
    });

    test("keeping a worktree says whether its record was there to keep", async () => {
        const tree = path.join(dir, "job-6", "tree");
        await git.addWorktree(mirror, tree, head);
        assert.equal(git.keepWorktree(mirror, tree), true);
        await git.removeWorktree(mirror, tree);
        assert.equal(git.keepWorktree(mirror, tree), false);
    });
});
