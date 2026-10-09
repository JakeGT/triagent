// When reviews run, with a fake GitHub: a pull request's first review waits for its checks, later pushes
// wait to be asked (a `/review` comment, the `review` label), a rebase with the same changes isn't
// reviewed again, skipped paths, bots and labels, checks that can't be read, and scheduled scans of a
// branch that hasn't changed. The decisions themselves are in review-triggers.test.ts.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { GithubState } from "../src/services/github/automation.ts";
import { COMMENT_MARKER } from "../src/services/github/service.ts";
import type { Project } from "../src/store/types.ts";
import { eventually, finished, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const REPO = "acme/app";
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

interface Item {
    number: number;
    status: string;
    reviewed: boolean;
    reviewedSha: string | null;
    headSha: string;
    lastDecision: { action: string; code: string; why: string };
}

/** What every suite here needs: the project, its pull requests page, a check, and what's queued. */
function tools(env: () => ReviewEnv) {
    const project = async () => {
        const w = await env().t.services.store.workspaces.bySlug("acme");
        return (await env().t.services.store.projects.bySlug(w?.id as string, "app")) as Project;
    };
    const page = async () => (await env().t.request("/api/v1/w/acme/p/app/pull-requests", { session: env().admin })).body;
    return {
        project,
        page,
        automation: (body: object) =>
            env().t.request("/api/v1/w/acme/p/app/settings/automation", { method: "PATCH", session: env().admin, body }),
        /** Check now, wait for what it tells GitHub, and return a pull request as the page shows it. */
        async check(number: number, at?: Date): Promise<Item> {
            await env().t.services.automation.checkPulls(await project(), at ? { at } : {});
            await env().t.services.runs.settled();
            return (await page()).items.find((p: Item) => p.number === number);
        },
        async item(number: number): Promise<Item> {
            return (await page()).items.find((p: Item) => p.number === number);
        },
        active: async () => env().t.services.store.jobs.list({ statuses: ["queued", "running"] }, 20),
        state: async () => env().t.services.automation.state(await project()) as Promise<GithubState>,
        statuses: (sha: string) =>
            env()
                .fake.repo(REPO)
                .statuses.filter((s) => s.sha === sha && s.context === "Triagent")
                .map((s) => `${s.state}: ${s.description}`),
        /** Triagent's own comment on a pull request. */
        ours: (number: number) =>
            (env().fake.repo(REPO).comments.get(number) ?? []).find((c) => c.body.startsWith(COMMENT_MARKER))?.body ?? "",
        /** Run the queued review of a pull request to its end. */
        async review(number: number) {
            const job = (await env().t.services.store.jobs.list({ statuses: ["queued", "running"] }, 20)).find(
                (j) => j.pr?.number === number,
            );
            assert.ok(job, `a review of #${number} is queued`);
            const run = await finished(env(), "acme", job.id);
            assert.equal(run.status, "done", run.error);
            return run;
        },
    };
}

describe("a pull request, from opened to reviewed and beyond", () => {
    let env: ReviewEnv;
    let hook: string;
    let secret: string;
    const t = tools(() => env);
    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme");
        await env.fake.gitRepo(REPO, { "src/a.ts": "a\n" });
        const s = await env.t.request("/api/v1/w/acme/p/app/settings/github/webhook-secret", {
            method: "POST",
            session: env.admin,
            body: {},
        });
        secret = s.body.webhookSecret;
        hook = s.body.url.replace("http://triagent.test", env.url);
        assert.equal((await t.automation({ enabled: true })).body.firstReview, "checks");
        // The baseline, with nothing open.
        await env.t.services.automation.checkPulls(await t.project());
        env.runner();
    });
    after(() => env.close());

    let first: string;

    test("opened with checks running: it waits, saying for how many, and says so on the commit once", async () => {
        first = await env.fake.commit(REPO, "feat", { "src/feat.ts": "one\n" }, "feat", "main");
        await env.fake.openPull(REPO, { number: 1, headRef: "feat", title: "A feature" });
        env.fake.checkRun(REPO, first, "build", "in_progress");
        env.fake.checkRun(REPO, first, "lint", "completed", "success");
        env.fake.status(REPO, first, "ci/deploy-preview", "pending");
        let pr = await t.check(1);
        assert.equal(pr.status, "waiting for checks (2 of 3)");
        assert.deepEqual([pr.lastDecision.action, pr.lastDecision.why], ["waiting", "waiting for 2 of 3 checks"]);
        assert.deepEqual(await t.active(), []);
        // Triagent's own pending status isn't one of the checks it waits for, and isn't posted again.
        pr = await t.check(1);
        assert.equal(pr.status, "waiting for checks (2 of 3)");
        assert.deepEqual(t.statuses(first), ["pending: Waiting for checks to pass"]);
    });

    test("a check fails: not reviewed, saying which; it passes on a re-run, and GitHub's event starts the one review", async () => {
        env.fake.checkRun(REPO, first, "build", "completed", "failure");
        env.fake.status(REPO, first, "ci/deploy-preview", "success");
        const failed = await t.check(1);
        assert.equal(failed.status, "checks failed");
        assert.match(failed.lastDecision.why, /^checks failed \(build\)/);
        assert.equal(t.statuses(first).at(-1), "error: Not reviewed: checks failed");
        assert.deepEqual(await t.active(), []);

        // Triagent's own status comes back as an event: nothing is done about it.
        const own = await env.fake.deliver(
            hook,
            "status",
            { sha: first, context: "Triagent", state: "error", repository: { full_name: REPO } },
            secret,
        );
        assert.equal(own.body.ignored, true);
        // A check that has only started changes nothing either.
        const started = await env.fake.deliver(
            hook,
            "check_run",
            { action: "created", check_run: { head_sha: first }, repository: { full_name: REPO } },
            secret,
        );
        assert.equal(started.body.ignored, true);
        // Nor one for a commit no pull request is waiting on.
        const other = await env.fake.deliver(
            hook,
            "check_run",
            { action: "completed", check_run: { head_sha: "c".repeat(40) }, repository: { full_name: REPO } },
            secret,
        );
        assert.match(String(other.body.note), /No open pull request here is waiting on that commit's checks/);

        env.fake.checkRun(REPO, first, "build", "completed", "success");
        const passed = await env.fake.deliver(
            hook,
            "check_run",
            { action: "completed", check_run: { head_sha: first }, repository: { full_name: REPO } },
            secret,
        );
        assert.equal(passed.status, 200);
        assert.equal(passed.body.ignored, undefined);
        await env.t.services.runs.settled();
        const queued = (await t.active()).filter((j) => j.pr?.number === 1);
        assert.deepEqual(
            queued.map((j) => [j.headSha, j.source]),
            [[first, "automation"]],
        );
        assert.match((await t.item(1)).lastDecision.why, /its 3 checks have passed/);
        await t.review(1);
        const pr = await t.item(1);
        assert.equal(pr.reviewed, true);
        assert.match(
            t.ours(1),
            /To have this pull request reviewed again, comment `\/review`, add the `review` label, or use \[Review now in Triagent\]/,
        );
        // Checking again queues nothing more.
        await t.check(1);
        assert.deepEqual(await t.active(), []);
    });

    test("later pushes aren't reviewed: the page and Triagent's comment say how many commits since", async () => {
        await env.fake.commit(REPO, "feat", { "src/feat.ts": "two\n" }, "two");
        const head = await env.fake.commit(REPO, "feat", { "src/feat.ts": "three\n" }, "three");
        env.fake.checkRun(REPO, head, "build", "completed", "success");
        const pr = await t.check(1);
        assert.equal(pr.status, `reviewed at ${first.slice(0, 7)}, 2 commits since`);
        assert.equal(pr.lastDecision.action, "skipped");
        assert.match(pr.lastDecision.why, /^2 commits since the last review/);
        assert.deepEqual(await t.active(), []);
        assert.match(
            t.ours(1),
            new RegExp(`\\*\\*2 commits since this review\\*\\* \\(the pull request is now at \`${head.slice(0, 7)}\`\\)`),
        );
        assert.match(t.ours(1), /1 finding in this pull request/);
        // No status on the new commit, and GitHub isn't asked about it again while nothing changes.
        assert.deepEqual(t.statuses(head), []);
        const asked = env.fake.log.length;
        await t.check(1);
        assert.deepEqual(
            env.fake.log.slice(asked).map((l) => l.path.split("?")[0]),
            ["/repos/acme/app/pulls", "/repos/acme/app/issues/comments"],
        );
    });

    test("/review from a stranger is ignored, with one reply however often they ask", async () => {
        env.fake.comment(REPO, 1, "/review", "mallory", "NONE");
        await t.check(1);
        env.fake.comment(REPO, 1, "/review now!", "mallory", "FIRST_TIME_CONTRIBUTOR");
        await t.check(1);
        assert.deepEqual(await t.active(), []);
        const replies = (env.fake.repo(REPO).comments.get(1) ?? []).filter((c) => /Only people with write access/.test(c.body));
        assert.equal(replies.length, 1);
        assert.equal(replies[0]?.user, "octo");
    });

    test("/review from a collaborator starts a review, noted on Triagent's own comment", async () => {
        // Not a first line starting with /review: nothing.
        env.fake.comment(REPO, 1, "Could someone /review this?", "alice", "COLLABORATOR");
        await t.check(1);
        assert.deepEqual(await t.active(), []);
        const comments = (env.fake.repo(REPO).comments.get(1) ?? []).length;
        env.fake.comment(REPO, 1, "/review\nI fixed the thing.", "alice", "COLLABORATOR");
        await t.check(1);
        const queued = await t.active();
        assert.deepEqual(
            queued.map((j) => [j.pr?.number, j.requestedBy.name, j.source]),
            [[1, "alice (GitHub)", "person"]],
        );
        assert.match(t.ours(1), /was asked for by alice with `\/review`, and is queued/);
        // No new comment for the request, and the same comment isn't answered twice.
        assert.equal((env.fake.repo(REPO).comments.get(1) ?? []).length, comments + 1);
        await t.review(1);
        await t.check(1);
        assert.deepEqual(await t.active(), []);
        assert.equal((await t.item(1)).reviewed, true);
    });

    test("/review arriving by webhook is answered at once, and not again by the next check", async () => {
        const head = await env.fake.commit(REPO, "feat", { "src/feat.ts": "four\n" }, "four");
        const c = env.fake.comment(REPO, 1, "/review", "alice", "OWNER");
        const payload = {
            action: "created",
            issue: { number: 1, pull_request: {} },
            comment: { id: c.id, body: c.body, author_association: "OWNER", user: { login: "alice" } },
            repository: { full_name: REPO },
        };
        assert.equal((await env.fake.deliver(hook, "issue_comment", payload, "wrong")).status, 401);
        const ok = await env.fake.deliver(hook, "issue_comment", payload, secret);
        assert.equal(ok.status, 200);
        await env.t.services.runs.settled();
        assert.deepEqual(
            (await t.active()).map((j) => j.headSha),
            [head],
        );
        // A comment on an issue, an edit, or anything not starting with /review: ignored.
        for (const p of [
            { ...payload, issue: { number: 1 } },
            { ...payload, action: "edited" },
            { ...payload, comment: { ...payload.comment, body: "looks good" } },
        ])
            assert.equal((await env.fake.deliver(hook, "issue_comment", p, secret)).body.ignored, true);
        await t.review(1);
        await t.check(1);
        assert.deepEqual(await t.active(), []);
    });

    test("the review label starts a review, and is taken off", async () => {
        const head = await env.fake.commit(REPO, "feat", { "src/feat.ts": "five\n" }, "five");
        assert.match((await t.check(1)).status, /1 commit since/);
        env.fake.label(REPO, 1, "review");
        // Other labels mean nothing; this one is checked at once.
        const other = await env.fake.deliver(
            hook,
            "pull_request",
            { action: "labeled", number: 1, label: { name: "bug" }, pull_request: { number: 1 }, repository: { full_name: REPO } },
            secret,
        );
        assert.equal(other.body.ignored, true);
        const labeled = await env.fake.deliver(
            hook,
            "pull_request",
            { action: "labeled", number: 1, label: { name: "review" }, pull_request: { number: 1 }, repository: { full_name: REPO } },
            secret,
        );
        assert.equal(labeled.body.ignored, undefined);
        await env.t.services.runs.settled();
        assert.deepEqual(
            (await t.active()).map((j) => [j.headSha, j.requestedBy.name]),
            [[head, "the review label (GitHub)"]],
        );
        assert.deepEqual(env.fake.repo(REPO).pulls.get(1)?.labels, []);
        await t.review(1);
    });

    test("a rebase with the same changes moves the review to the new commit, with its status, and no new review", async () => {
        const reviewed = (await t.item(1)).reviewedSha as string;
        assert.equal(reviewed, (await t.item(1)).headSha);
        assert.match((await t.state()).prs["1"]?.reviewedFingerprint ?? "", /^[0-9a-f]{64}$/);
        // The base moves on, and the branch gets a commit that changes nothing of its own.
        await env.fake.commit(REPO, "main", { "src/elsewhere.ts": "x\n" }, "elsewhere");
        const head = await env.fake.commit(REPO, "feat", {}, "Merge main");
        assert.notEqual(head, reviewed);
        const pr = await t.check(1);
        assert.equal(pr.status, "same changes as the reviewed commit");
        assert.match(pr.lastDecision.why, /same changes as the reviewed commit/);
        assert.equal(pr.reviewedSha, head);
        assert.equal(pr.reviewed, true);
        assert.deepEqual(await t.active(), []);
        // The pull request's check isn't missing on the new commit.
        assert.deepEqual(t.statuses(head), [t.statuses(reviewed).at(-1)]);
        assert.match(t.ours(1), /with the same changes as the reviewed commit/);
        // And a real change after that is a later push again.
        await env.fake.commit(REPO, "feat", { "src/feat.ts": "six\n" }, "six");
        assert.match((await t.check(1)).status, /^reviewed at [0-9a-f]{7}, 1 commit since$/);
    });
});

describe("pull requests that aren't reviewed by themselves", () => {
    let env: ReviewEnv;
    const t = tools(() => env);
    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme");
        await env.fake.gitRepo(REPO, { "src/a.ts": "a\n", "docs/index.md": "# Docs\n" });
        await t.automation({ enabled: true });
        await env.t.services.automation.checkPulls(await t.project());
    });
    after(() => env.close());

    const open = async (number: number, branch: string, files: Record<string, string>, extra: object = {}) => {
        const sha = await env.fake.commit(REPO, branch, files, branch, "main");
        await env.fake.openPull(REPO, { number, headRef: branch, ...extra });
        env.fake.checkRun(REPO, sha, "build", "completed", "success");
        return sha;
    };

    test("skip paths are validated: a few short patterns", async () => {
        assert.equal((await t.automation({ skipPaths: ["docs/**", "*.md", " **/*.lock "] })).body.skipPaths[2], "**/*.lock");
        assert.equal((await t.automation({ skipPaths: ["a".repeat(201)] })).status, 400);
        assert.equal((await t.automation({ skipPaths: ["a\nb"] })).status, 400);
        assert.equal((await t.automation({ skipPaths: [""] })).status, 400);
        assert.equal((await t.automation({ skipPaths: Array.from({ length: 51 }, (_, i) => `p${i}`) })).status, 400);
        assert.equal((await t.automation({ firstReview: "sometimes" })).status, 400);
        const saved = (await env.t.request("/api/v1/w/acme/p/app/settings/automation", { session: env.admin })).body;
        assert.deepEqual([saved.firstReview, saved.skipBots, saved.skipPaths.length], ["checks", true, 3]);
    });

    test("only skipped paths, a bot's, and the label skip-review: each says why, and none asks GitHub about checks", async () => {
        await open(1, "docs", { "docs/guide.md": "guide\n", "NOTES.md": "notes\n" });
        await open(2, "deps", { "package.json": "{}\n" }, { author: "dependabot[bot]" });
        await open(3, "wip", { "src/wip.ts": "wip\n" }, { labels: ["skip-review"] });
        await open(4, "mixed", { "docs/more.md": "more\n", "src/code.ts": "code\n" });
        const asked = env.fake.log.length;
        assert.equal((await t.check(1)).status, "skipped: only docs/**, *.md");
        assert.equal((await t.item(2)).status, "skipped: opened by a bot");
        assert.match((await t.item(2)).lastDecision.why, /opened by a bot \(dependabot\[bot\]\)/);
        assert.equal((await t.item(3)).status, "skipped: label skip-review");
        // One with code in it too is reviewed.
        assert.deepEqual(
            (await t.active()).map((j) => j.pr?.number),
            [4],
        );
        const four = env.fake.repo(REPO).pulls.get(4)?.headSha as string;
        const checks = env.fake.log.slice(asked).filter((l) => /check-runs|\/status$/.test(l.path.split("?")[0] as string));
        assert.deepEqual(
            checks.map((l) => l.path.includes(four)),
            [true, true],
        );
        // A second check with nothing changed asks only for the list (and new comments).
        const again = env.fake.log.length;
        await t.check(1);
        assert.equal(env.fake.log.length - again, 2);
    });

    test("asking still works for each, and bots are reviewed when the project says so", async () => {
        const now = await env.t.request("/api/v1/w/acme/p/app/reviews", {
            method: "POST",
            session: env.admin,
            body: { kind: "pr", number: 2 },
        });
        assert.equal(now.status, 201, now.text);
        env.fake.comment(REPO, 3, "/review", "alice", "MEMBER");
        await t.check(3);
        assert.deepEqual((await t.active()).map((j) => j.pr?.number).sort(), [2, 3, 4]);
        for (const j of await t.active())
            await env.t.request(`/api/v1/w/acme/runs/${j.id}/cancel`, { method: "POST", session: env.admin, body: {} });
        await env.t.services.runs.settled();
        await open(5, "more-deps", { "package.json": "{ }\n" }, { author: "renovate[bot]" });
        await t.automation({ skipBots: false });
        assert.equal((await t.check(5)).lastDecision.action, "queued");
    });
});

describe("checks that aren't there, or can't be read", () => {
    let env: ReviewEnv;
    let token: string;
    const t = tools(() => env);
    before(async () => {
        env = await reviewEnv();
        ({ token } = await patProject(env, "acme"));
        await env.fake.gitRepo(REPO, { "src/a.ts": "a\n" });
        await t.automation({ enabled: true });
        await env.t.services.automation.checkPulls(await t.project());
    });
    after(() => env.close());

    test("a repository with no checks: reviewed once none have appeared for two minutes", async () => {
        await env.fake.commit(REPO, "quiet", { "src/q.ts": "q\n" }, "q", "main");
        await env.fake.openPull(REPO, { number: 1, headRef: "quiet" });
        let pr = await t.check(1);
        assert.equal(pr.status, "waiting for checks to start");
        assert.equal(pr.lastDecision.action, "waiting");
        pr = await t.check(1, later(1));
        assert.equal(pr.status, "waiting for checks to start");
        assert.deepEqual(await t.active(), []);
        // The poller comes back for it when the two minutes are up, though it checked a moment ago.
        await env.t.services.automation.tick(later(2.1));
        pr = await t.item(1);
        assert.equal(pr.lastDecision.action, "queued");
        assert.match(pr.lastDecision.why, /no checks appeared on the commit within two minutes/);
        assert.equal((await t.active()).length, 1);
    });

    test("a token GitHub won't show check runs: reviewed when ready, and the pages say so", async () => {
        assert.equal((await t.page()).checksReadable, true);
        env.fake.pat(token, "octo", [REPO], { noChecks: true });
        await env.fake.commit(REPO, "blind", { "src/b.ts": "b\n" }, "b", "main");
        await env.fake.openPull(REPO, { number: 2, headRef: "blind" });
        const pr = await t.check(2);
        assert.deepEqual([pr.lastDecision.action, pr.lastDecision.why], ["queued", "can't see checks, so reviewing when ready"]);
        assert.equal((await t.page()).checksReadable, false);
        assert.equal((await env.t.request("/api/v1/w/acme/p/app/settings/github", { session: env.admin })).body.checksReadable, false);

        // Commit statuses can still be read, and still count.
        const sha = await env.fake.commit(REPO, "half", { "src/h.ts": "h\n" }, "h", "main");
        await env.fake.openPull(REPO, { number: 3, headRef: "half" });
        env.fake.status(REPO, sha, "ci/test", "failure");
        assert.equal((await t.check(3)).status, "checks failed");
        // Failed checks are asked about again every ten minutes (or when GitHub says one finished).
        env.fake.status(REPO, sha, "ci/test", "pending");
        assert.equal((await t.check(3)).status, "checks failed");
        assert.equal((await t.check(3, later(11))).status, "waiting for checks (1 of 1)");

        // Readable again: said so too.
        env.fake.pat(token, "octo", [REPO]);
        assert.equal((await t.check(3)).status, "waiting for checks (1 of 1)");
        assert.equal((await t.page()).checksReadable, true);
    });

    test("GitHub failing to answer about checks is never a pass: it's asked again", async () => {
        const sha = await env.fake.commit(REPO, "flaky", { "src/f.ts": "f\n" }, "f", "main");
        await env.fake.openPull(REPO, { number: 4, headRef: "flaky" });
        env.fake.checkRun(REPO, sha, "build", "completed", "success");
        const before = (await t.active()).length;
        const github = env.t.services.github;
        const githubFor = github.githubFor.bind(github);
        github.githubFor = async (...args) => {
            const gh = await githubFor(...args);
            const checks = Object.create(gh.client) as typeof gh.client;
            checks.checkRuns = async () => {
                throw new Error("GitHub said 502: Bad gateway.");
            };
            return { ...gh, checks };
        };
        try {
            const pr = await t.check(4);
            assert.equal(pr.lastDecision.action, "waiting");
            assert.match(pr.lastDecision.why, /couldn't ask GitHub about its checks \(GitHub said 502/);
            assert.equal((await t.active()).length, before);
        } finally {
            github.githubFor = githubFor;
        }
        assert.equal((await t.check(4)).lastDecision.action, "queued");
    });
});

describe("a review asked for while one is running", () => {
    let env: ReviewEnv;
    let hook: string;
    let secret: string;
    const t = tools(() => env);
    before(async () => {
        env = await reviewEnv({ env: { REVIEW_CONCURRENCY: "2", REVIEW_CONCURRENCY_PER_WORKSPACE: "2" } });
        await patProject(env, "acme");
        await env.fake.gitRepo(REPO, { "src/a.ts": "a\n" });
        const s = await env.t.request("/api/v1/w/acme/p/app/settings/github/webhook-secret", {
            method: "POST",
            session: env.admin,
            body: {},
        });
        secret = s.body.webhookSecret;
        hook = s.body.url.replace("http://triagent.test", env.url);
        await t.automation({ enabled: true });
        await env.t.services.automation.checkPulls(await t.project());
    });
    after(() => env.close());

    test("it waits for the one running, which is never stopped; a request for the commit already running returns that run", async () => {
        const runs = env.t.services.runs;
        const hello = (n: number) => ({ id: `runner-manual-000${n}`, name: `manual-${n}`, version: "1", slots: 1 });
        const first = await env.fake.commit(REPO, "feat", { "src/f.ts": "1\n" }, "f", "main");
        await env.fake.openPull(REPO, { number: 1, headRef: "feat" });
        const start = () =>
            env.t.request("/api/v1/w/acme/p/app/reviews", { method: "POST", session: env.admin, body: { kind: "pr", number: 1 } });
        const started = await start();
        const running = await runs.claim(hello(1));
        assert.equal(running?.id, started.body.id);
        // Asked again for the same commit: the run there is.
        assert.equal((await start()).body.id, started.body.id);
        const comment = (body: string) => {
            const c = env.fake.comment(REPO, 1, body, "alice", "MEMBER");
            return env.fake.deliver(
                hook,
                "issue_comment",
                {
                    action: "created",
                    issue: { number: 1, pull_request: {} },
                    comment: { id: c.id, body, author_association: "MEMBER", user: { login: "alice" } },
                    repository: { full_name: REPO },
                },
                secret,
            );
        };
        await comment("/review");
        await runs.settled();
        assert.equal((await t.active()).length, 1);

        // A push while it runs isn't reviewed by itself, and doesn't stop it.
        const second = await env.fake.commit(REPO, "feat", { "src/f.ts": "2\n" }, "f2");
        env.fake.checkRun(REPO, second, "build", "completed", "success");
        const pr = await t.check(1);
        assert.match(pr.lastDecision.why, /a review of an earlier commit \([0-9a-f]{7}\) is running/);
        assert.equal((await t.active()).length, 1);

        // Asked for: queued behind the one running, though there's a free slot.
        await comment("/review");
        await runs.settled();
        const active = await t.active();
        assert.deepEqual(active.map((j) => [j.status, j.headSha]).sort(), [
            ["queued", second],
            ["running", first],
        ]);
        assert.equal(await runs.claim(hello(2)), null);
        const list = (await env.t.request("/api/v1/w/acme/runs", { session: env.admin })).body;
        assert.equal(list.queued[0].waiting, "Waiting for the review of the same thing that's running to finish.");
        await runs.finish(hello(1), started.body.id, { status: "done", report: { comments: [] } });
        await runs.settled();
        const next = await runs.claim(hello(2));
        assert.equal(next?.headSha, second);
        await runs.finish(hello(2), next?.id as string, { status: "cancelled" });
        await runs.settled();
    });
});

describe("scheduled scans", () => {
    let env: ReviewEnv;
    const t = tools(() => env);
    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme");
        await env.fake.gitRepo(REPO, { "src/a.ts": "a\n" });
        env.runner();
    });
    after(() => env.close());

    test("skipped while the branch is at the commit of its last finished full scan, and said so", async () => {
        const day = (n: number) => later(n * 24 * 60);
        await t.automation({ enabled: true, nightlyHourUtc: day(0).getUTCHours() });
        const scans = async () => (await env.t.services.store.jobs.list({}, 50)).filter((j) => j.kind === "full");
        await env.t.services.automation.tick(day(0));
        assert.equal((await scans()).length, 1);
        assert.equal((await t.page()).scheduledScan.action, "queued");
        await eventually(async () => (await scans())[0]?.status === "done", "the scan to finish");
        const main = env.fake.repo(REPO).branches.get("main") as string;
        assert.equal((await scans())[0]?.headSha, main);

        // The next night: nothing has been pushed.
        await env.t.services.automation.tick(day(1));
        assert.equal((await scans()).length, 1);
        const skipped = (await t.page()).scheduledScan;
        assert.equal(skipped.action, "skipped");
        assert.match(
            skipped.why,
            new RegExp(`^main is still at ${main.slice(0, 7)}, the commit of its last full scan \\(\\d{4}-\\d\\d-\\d\\d\\)$`),
        );
        // Once that night, like a scan.
        const asked = env.fake.log.filter((l) => l.path === "/repos/acme/app/branches/main").length;
        await env.t.services.automation.tick(day(1));
        assert.equal(env.fake.log.filter((l) => l.path === "/repos/acme/app/branches/main").length, asked);

        // A push, and the night after it's scanned again.
        await env.fake.commit(REPO, "main", { "src/b.ts": "b\n" }, "b");
        await env.t.services.automation.tick(day(2));
        assert.equal((await scans()).length, 2);
        assert.equal((await t.page()).scheduledScan.action, "queued");
    });
});
