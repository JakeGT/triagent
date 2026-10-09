// GitHub, with a fake GitHub: webhooks for a project's token and for the GitHub App (signatures checked,
// events routed to the right workspace's projects), automatic reviews and their baseline, creating the
// app and linking installations (refused unless GitHub confirms the person can see the installation),
// branch sync, the nightly scan, and the MCP tools for reviews.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { COMMENT_MARKER } from "../src/services/github/service.ts";
import { specForBranch } from "../src/services/runs.ts";
import { ADMIN_PASSWORD, type Session, testApp } from "./helpers.ts";
import { eventually, finished, PAT, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe("pull requests with a token: webhooks, checks and the baseline", () => {
    let env: ReviewEnv;
    let hook: string;
    let secret: string;
    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme");
        await env.fake.gitRepo("acme/app", { "src/a.ts": "a\n" });
        const s = await env.t.request("/api/v1/w/acme/p/app/settings/github/webhook-secret", {
            method: "POST",
            session: env.admin,
            body: {},
        });
        secret = s.body.webhookSecret;
        hook = s.body.url.replace("http://triagent.test", env.url);
    });
    after(() => env.close());

    const prs = async () => (await env.t.request("/api/v1/w/acme/p/app/pull-requests", { session: env.admin })).body;
    const automation = (body: object) =>
        env.t.request("/api/v1/w/acme/p/app/settings/automation", { method: "PATCH", session: env.admin, body });

    test("switching automatic reviews on lists open pull requests without reviewing them; new pushes are reviewed", async () => {
        await env.fake.commit("acme/app", "one", { "src/one.ts": "1\n" }, "one", "main");
        await env.fake.openPull("acme/app", { number: 1, headRef: "one", title: "First" });
        await env.fake.commit("acme/app", "two", { "src/two.ts": "2\n" }, "two", "main");
        await env.fake.openPull("acme/app", { number: 2, headRef: "two", title: "Second" });
        await env.fake.openPull("acme/app", { number: 3, headRef: "one", title: "Draft", draft: true });

        // Off: a check lists them, and says why nothing was queued.
        const off = await env.t.request("/api/v1/w/acme/p/app/pull-requests/check", { method: "POST", session: env.admin, body: {} });
        assert.equal(off.status, 200, off.text);
        assert.ok(off.body.lastCheck.decisions.every((d: { action: string }) => d.action === "skipped"));
        assert.match(off.body.items.find((p: { number: number }) => p.number === 1).lastDecision.why, /automatic reviews are off/);

        // Reviewed as soon as they're ready: waiting for checks has tests of its own (review-triggers.test.ts).
        assert.equal((await automation({ enabled: true, pollMinutes: 1, firstReview: "ready" })).status, 200);
        await env.t.services.automation.tick(later(2));
        let page = await prs();
        const one = page.items.find((p: { number: number }) => p.number === 1);
        assert.equal(one.status, "not reviewed (was already open)");
        assert.match(one.lastDecision.why, /already open when automatic reviews were switched on/);
        assert.equal(page.items.find((p: { number: number }) => p.number === 3).lastDecision.why, "it's a draft");
        assert.equal((await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10)).length, 0);

        // A push to #1 is reviewed; #2, untouched, still isn't.
        await env.fake.commit("acme/app", "one", { "src/one.ts": "1b\n" }, "more");
        await env.t.services.automation.tick(later(4));
        page = await prs();
        assert.equal(page.items.find((p: { number: number }) => p.number === 1).lastDecision.action, "queued");
        assert.equal(page.items.find((p: { number: number }) => p.number === 2).lastDecision.action, "skipped");
        const queued = await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10);
        assert.deepEqual(
            queued.map((j) => [j.pr?.number, j.source]),
            [[1, "automation"]],
        );
        // "Review now" for #2.
        const now = await env.t.request("/api/v1/w/acme/p/app/reviews", {
            method: "POST",
            session: env.admin,
            body: { kind: "pr", number: 2 },
        });
        assert.equal(now.status, 201, now.text);
        assert.equal(now.body.source, "person");
        // Checking again doesn't queue #1 twice.
        await env.t.services.automation.tick(later(6));
        assert.equal((await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10)).length, 2);
        assert.match((await prs()).items.find((p: { number: number }) => p.number === 1).lastDecision.why, /already queued/);
        // A queued PR review set a pending status on its commit.
        await env.t.services.runs.settled();
        assert.ok(
            env.fake
                .repo("acme/app")
                .statuses.some((s) => s.state === "pending" && s.description === "Queued: reviews are waiting (see Triagent)"),
        );
        for (const j of await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10))
            await env.t.request(`/api/v1/w/acme/runs/${j.id}/cancel`, { method: "POST", session: env.admin, body: {} });
    });

    test("the project's webhook: signature checked, pull request events checked at once, deliveries recorded", async () => {
        const body = { action: "opened", number: 4, pull_request: { number: 4 }, repository: { full_name: "acme/app" } };
        assert.equal((await env.fake.deliver(hook, "pull_request", body, "wrong")).status, 401);
        assert.equal((await env.fake.deliver(hook, "pull_request", body, null)).status, 401);
        await env.fake.commit("acme/app", "four", { "src/four.ts": "4\n" }, "four", "main");
        await env.fake.openPull("acme/app", { number: 4, headRef: "four" });
        const ok = await env.fake.deliver(hook, "pull_request", body, secret);
        assert.equal(ok.status, 200);
        assert.match(String(ok.body.note), /Checking pull requests now/);
        await env.t.services.runs.settled();
        const queued = await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10);
        assert.deepEqual(
            queued.map((j) => j.pr?.number),
            [4],
        );
        // Another repository's delivery is ignored.
        const elsewhere = await env.fake.deliver(hook, "pull_request", { ...body, repository: { full_name: "evil/app" } }, secret);
        assert.equal(elsewhere.body.ignored, true);
        // Deliveries without a good signature (anyone can send them) are counted, not kept: they can't push the real ones out.
        const page = await prs();
        assert.deepEqual(
            page.deliveries.map((d: { outcome: string }) => d.outcome),
            ["ignored", "received"],
        );
        assert.equal(page.refused.count, 2);
        assert.equal(page.refused.lastReason, "No signature: set the secret in the webhook's settings on GitHub.");
        for (let i = 0; i < 60; i++) await env.fake.deliver(hook, "pull_request", body, "wrong");
        const after = await prs();
        assert.equal(after.refused.count, 62);
        assert.deepEqual(
            after.deliveries.map((d: { outcome: string }) => d.outcome),
            ["ignored", "received"],
        );
        await env.t.request(`/api/v1/w/acme/runs/${queued[0]?.id}/cancel`, { method: "POST", session: env.admin, body: {} });
    });
});

describe("more than a page of pull requests, and a project that moves to another repository", () => {
    let env: ReviewEnv;
    let token: string;
    before(async () => {
        env = await reviewEnv();
        ({ token } = await patProject(env, "acme"));
        await env.fake.gitRepo("acme/app", { "src/a.ts": "a\n" });
        await env.fake.gitRepo("acme/other", { "src/o.ts": "o\n" });
        env.fake.pat(token, "octo", ["acme/app", "acme/other"]);
    });
    after(() => env.close());

    const project = async () => {
        const w = await env.t.services.store.workspaces.bySlug("acme");
        return (await env.t.services.store.projects.bySlug(w?.id as string, "app")) as NonNullable<
            Awaited<ReturnType<typeof env.t.services.store.projects.bySlug>>
        >;
    };

    test("every open pull request is checked, not just the first 100", async () => {
        for (let n = 1; n <= 130; n++) env.fake.pull("acme/app", { number: n, headRef: `b${n}` });
        assert.equal(
            (
                await env.t.request("/api/v1/w/acme/p/app/settings/automation", {
                    method: "PATCH",
                    session: env.admin,
                    body: { enabled: true, firstReview: "ready" },
                })
            ).status,
            200,
        );
        // The baseline: all of them listed, none reviewed.
        const first = await env.t.services.automation.checkPulls(await project());
        assert.equal(first?.openPulls, 130);
        const page = (await env.t.request("/api/v1/w/acme/p/app/pull-requests", { session: env.admin })).body;
        assert.equal(page.items.length, 130);
        assert.ok(page.items.every((p: { baseline?: boolean }) => p.baseline));
        // A push to the 130th is noticed and reviewed; the others still aren't.
        const pr = env.fake.repo("acme/app").pulls.get(130);
        if (pr) pr.headSha = randomBytes(20).toString("hex");
        const second = await env.t.services.automation.checkPulls(await project());
        assert.deepEqual(
            second?.decisions.filter((d) => d.action === "queued").map((d) => d.number),
            [130],
        );
        for (const j of await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10))
            await env.t.request(`/api/v1/w/acme/runs/${j.id}/cancel`, { method: "POST", session: env.admin, body: {} });
        await env.t.request("/api/v1/w/acme/p/app/settings/automation", { method: "PATCH", session: env.admin, body: { enabled: false } });
        for (let n = 1; n <= 130; n++) env.fake.repo("acme/app").pulls.delete(n);
    });

    test("a review finishing during a check keeps its outcome", async () => {
        const pr = env.fake.pull("acme/app", { number: 501, headRef: "during" });
        const p = await project();
        await env.t.services.automation.checkPulls(p);
        const jobs = env.t.services.store.jobs;
        const list = jobs.list;
        // The review of the head commit finishes while the check is deciding.
        jobs.list = async (...args) => {
            jobs.list = list;
            await env.t.services.store.transaction(async (tx) => {
                const s = structuredClone(await tx.githubState.get(p.id)) as { prs: Record<string, Record<string, unknown>> };
                Object.assign(s.prs["501"] as object, { reviewedSha: pr.headSha, status: "reviewed", baseline: false });
                await tx.githubState.put(p.id, s);
            });
            return list.apply(jobs, args);
        };
        try {
            await env.t.services.automation.checkPulls(p);
        } finally {
            jobs.list = list;
        }
        const after = (await env.t.services.automation.state(p)).prs["501"];
        assert.equal(after?.reviewedSha, pr.headSha);
        assert.equal(after?.status, "reviewed");
        env.fake.repo("acme/app").pulls.delete(501);
    });

    test("a check that fails rejects for its caller only, with no unhandled rejection", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        const settings = env.t.services.settings;
        const original = settings.automation;
        settings.automation = async () => {
            throw new Error("store down");
        };
        try {
            await assert.rejects(env.t.services.automation.checkPulls(await project()), /store down/);
            await new Promise((resolve) => setImmediate(resolve));
            assert.deepEqual(unhandled, []);
        } finally {
            settings.automation = original;
            process.off("unhandledRejection", onUnhandled);
        }
        // And the next check runs as usual.
        assert.ok(await env.t.services.automation.checkPulls(await project()));
    });

    test("a review reports only to the repository it reviewed: if the project moves, nothing is posted elsewhere", async () => {
        const runs = env.t.services.runs;
        const admin = { name: "admin", userId: null, via: "web" } as const;
        const hello = { id: "runner-moved-0000", name: "moved", version: "1", slots: 1 };
        for (const repo of ["acme/app", "acme/other"]) {
            await env.fake.commit(repo, "feat", { "src/f.ts": "f\n" }, "f", "main");
            await env.fake.openPull(repo, { number: 7, headRef: "feat" });
        }
        const spec = (await import("../src/services/runs.ts")).specForPull({
            number: 7,
            title: "Seven",
            state: "open",
            html_url: "https://github.com/acme/app/pull/7",
            user: { login: "octo" },
            head: { ref: "feat", sha: env.fake.repo("acme/app").branches.get("feat") as string, repo: { full_name: "acme/app" } },
            base: { ref: "main", sha: "0".repeat(40), repo: { full_name: "acme/app" } },
        });

        // Started on acme/app; the project then moves to acme/other before the review finishes.
        let job = await runs.enqueue(admin, await project(), spec);
        assert.deepEqual(job.repository, { id: null, fullName: "acme/app" });
        let claimed = await runs.claim(hello);
        assert.ok(claimed);
        await env.t.services.projects.update(admin, await project(), { repoUrl: "https://github.com/acme/other" });
        await runs.finish(hello, claimed.id, { status: "done", report: { comments: [{ path: "src/f.ts", content: "A finding here." }] } });
        await runs.settled();
        const other = env.fake.repo("acme/other");
        assert.equal(other.comments.get(7), undefined, "nothing was posted on the other repository's #7");
        assert.equal(other.statuses.length, 0);
        const log = (await env.t.request(`/api/v1/w/acme/runs/${claimed.id}?after=0`, { session: env.admin })).body.logLines.map(
            (l: { line: string }) => l.line,
        );
        assert.ok(
            log.some((l: string) => /Not reporting to GitHub: this project now uses acme\/other, and this review was of acme\/app/.test(l)),
        );

        // Queued for acme/app, still waiting when the project moves: it never starts on acme/other's code.
        await env.t.services.projects.update(admin, await project(), { repoUrl: "https://github.com/acme/app" });
        job = await runs.enqueue(admin, await project(), { ...spec, headSha: randomBytes(20).toString("hex") });
        await env.t.services.projects.update(admin, await project(), { repoUrl: "https://github.com/acme/other" });
        claimed = await runs.claim(hello);
        assert.equal(claimed, null);
        const failed = await env.t.services.store.jobs.get(job.id);
        assert.equal(failed?.status, "failed");
        assert.match(failed?.error ?? "", /This project now uses acme\/other, but this review was queued for acme\/app/);
        await runs.settled();
        assert.equal(other.statuses.length, 0);
    });

    test("a run whose ending can't be recorded still finishes on GitHub, not left pending", async () => {
        const runs = env.t.services.runs;
        const admin = { name: "admin", userId: null, via: "web" } as const;
        const hello = { id: "runner-unrecorded-0000", name: "unrecorded", version: "1", slots: 1 };
        await env.t.services.projects.update(admin, await project(), { repoUrl: "https://github.com/acme/app" });
        const headSha = randomBytes(20).toString("hex");
        const spec = (await import("../src/services/runs.ts")).specForPull({
            number: 8,
            title: "Eight",
            state: "open",
            html_url: "https://github.com/acme/app/pull/8",
            user: { login: "octo" },
            head: { ref: "feat", sha: headSha, repo: { full_name: "acme/app" } },
            base: { ref: "main", sha: "0".repeat(40), repo: { full_name: "acme/app" } },
        });
        await runs.enqueue(admin, await project(), spec);
        const claimed = await runs.claim(hello);
        assert.ok(claimed);
        const finished: string[] = [];
        const onFinished = runs.onFinished;
        runs.onFinished = (job, p) => {
            finished.push(job.id);
            onFinished(job, p);
        };
        // Recording the ending fails (here: reading the project's settings), so the fallback ends it.
        const settings = env.t.services.settings;
        const automation = settings.automation;
        settings.automation = async () => {
            throw new Error("settings unreadable");
        };
        try {
            await runs.finish(hello, claimed.id, { status: "failed", error: "boom" });
        } finally {
            settings.automation = automation;
        }
        await runs.settled();
        runs.onFinished = onFinished;
        assert.equal((await env.t.services.store.jobs.get(claimed.id))?.status, "failed");
        assert.deepEqual(finished, [claimed.id]);
        const statuses = env.fake.repo("acme/app").statuses.filter((s) => s.sha === headSha);
        assert.ok(statuses.length > 0 && statuses.at(-1)?.state !== "pending", JSON.stringify(statuses));
    });
});

describe("pull requests from people outside the repository", () => {
    let env: ReviewEnv;
    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme");
        await env.fake.gitRepo("acme/app", { "src/a.ts": "a\n" });
    });
    after(() => env.close());

    const page = async () => (await env.t.request("/api/v1/w/acme/p/app/pull-requests", { session: env.admin })).body;
    const check = async () =>
        (await env.t.request("/api/v1/w/acme/p/app/pull-requests/check", { method: "POST", session: env.admin, body: {} })).body;
    type Item = { number: number; status: string; lastDecision: { action: string; why: string } };
    const item = (p: { items: Item[] }, n: number) => p.items.find((x) => x.number === n) as Item;

    test("wait for someone who can start reviews, unless the project says to review everyone's", async () => {
        const settings = await env.t.request("/api/v1/w/acme/p/app/settings/automation", {
            method: "PATCH",
            session: env.admin,
            body: { enabled: true, firstReview: "ready" },
        });
        assert.equal(settings.body.reviewPullRequestsFrom, "collaborators");
        await check(); // the baseline, with nothing open

        // From a branch of the repository itself: reviewed, whoever opened it.
        await env.fake.commit("acme/app", "inside", { "src/in.ts": "in\n" }, "in", "main");
        await env.fake.openPull("acme/app", { number: 1, headRef: "inside", author: "newcomer", association: "NONE" });
        // From forks: a stranger's waits; a collaborator's and an organisation member's are reviewed.
        env.fake.pull("acme/app", { number: 2, headRef: "patch", fork: true, author: "stranger", association: "FIRST_TIME_CONTRIBUTOR" });
        env.fake.pull("acme/app", { number: 3, headRef: "fix", fork: true, author: "colleague", association: "COLLABORATOR" });
        env.fake.pull("acme/app", { number: 4, headRef: "tweak", fork: true, author: "staff", association: "MEMBER" });
        env.fake.pull("acme/app", { number: 5, headRef: "more", fork: true, author: "passer-by", association: "CONTRIBUTOR" });
        const checked = await check();
        const queued = (await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10)).map((j) => j.pr?.number).sort();
        assert.deepEqual(queued, [1, 3, 4]);
        for (const n of [2, 5]) {
            const pr = item(checked, n);
            assert.equal(pr.status, "waiting for approval");
            assert.equal(pr.lastDecision.action, "skipped");
            assert.match(
                pr.lastDecision.why,
                /from a fork, by .+, who isn't a collaborator on acme\/app: someone who can start reviews can use Review now/,
            );
        }
        assert.equal(item(await page(), 2).status, "waiting for approval");

        // Someone who can start reviews looks at it and starts one.
        const now = await env.t.request("/api/v1/w/acme/p/app/reviews", {
            method: "POST",
            session: env.admin,
            body: { kind: "pr", number: 2 },
        });
        assert.equal(now.status, 201, now.text);
        // A new push waits again: it's new code.
        const pr2 = env.fake.repo("acme/app").pulls.get(2);
        if (pr2) pr2.headSha = randomBytes(20).toString("hex");
        assert.equal(item(await check(), 2).status, "waiting for approval");

        // Reviewing everyone's: the next push is queued without waiting (once nothing earlier of it is queued:
        // a push after a review that's queued or done waits to be asked for).
        for (const j of await env.t.services.store.jobs.list({ statuses: ["queued"] }, 20))
            await env.t.request(`/api/v1/w/acme/runs/${j.id}/cancel`, { method: "POST", session: env.admin, body: {} });
        await env.t.services.runs.settled();
        await env.t.request("/api/v1/w/acme/p/app/settings/automation", {
            method: "PATCH",
            session: env.admin,
            body: { reviewPullRequestsFrom: "everyone" },
        });
        if (pr2) pr2.headSha = randomBytes(20).toString("hex");
        assert.equal(item(await check(), 2).lastDecision.action, "queued");
        for (const j of await env.t.services.store.jobs.list({ statuses: ["queued"] }, 20))
            await env.t.request(`/api/v1/w/acme/runs/${j.id}/cancel`, { method: "POST", session: env.admin, body: {} });
    });
});

describe("branches on GitHub, and the nightly scan", () => {
    let env: ReviewEnv;
    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme");
        await env.fake.gitRepo("acme/app", { "src/a.ts": "a\n" });
    });
    after(() => env.close());

    const upload = (branch: string, commit: string) =>
        env.t.request("/api/v1/w/acme/p/app/reports", {
            method: "POST",
            session: env.admin,
            body: {
                branch,
                commit,
                report: { comments: [{ path: "src/a.ts", content: `Something on ${branch} needs fixing.` }] },
                confirm: true,
            },
        });

    test("reports are marked out of date with how far behind, unreviewed branches listed, deleted ones archived", async () => {
        const fake = env.fake;
        const main = fake.repo("acme/app").branches.get("main") as string;
        const feature = await fake.commit("acme/app", "feature", { "src/f.ts": "f\n" }, "f", "main");
        const gone = await fake.commit("acme/app", "gone", { "src/g.ts": "g\n" }, "g", "main");
        // A branch name that's also an Object property: still just a branch.
        const odd = await fake.commit("acme/app", "constructor", { "src/c.ts": "c\n" }, "c", "main");
        await fake.commit("acme/app", "fresh", { "src/n.ts": "n\n" }, "n", "main");
        assert.equal((await upload("main", main)).status, 200);
        assert.equal((await upload("feature", feature)).status, 200);
        assert.equal((await upload("gone", gone)).status, 200);
        assert.equal((await upload("constructor", odd)).status, 200);
        await fake.commit("acme/app", "feature", { "src/f2.ts": "x\n" }, "f2");
        await fake.commit("acme/app", "feature", { "src/f3.ts": "x\n" }, "f3");
        await env.t.request("/api/v1/w/acme/p/app/settings/automation", {
            method: "PATCH",
            session: env.admin,
            body: { archiveDeletedBranches: true },
        });
        const project = (await env.t.services.store.projects.bySlug(
            (
                await env.t.services.store.workspaces.bySlug("acme")
            )?.id as string,
            "app",
        )) as never;
        assert.equal(await env.t.services.automation.syncBranches(project), true);

        let list = (await env.t.request("/api/v1/w/acme/p/app/branches", { session: env.admin })).body;
        const by = (n: string) => list.items.find((b: { name: string }) => b.name === n);
        assert.deepEqual(by("main").github, { onGitHub: true, current: true, githubSha: main, behind: null, diverged: false });
        assert.equal(by("feature").github.current, false);
        assert.equal(by("feature").github.behind, 2);
        assert.deepEqual(list.github.notReviewed, ["fresh"]);

        // Deleted on GitHub: archived here (never the default branch, even if that goes too).
        fake.deleteBranch("acme/app", "gone");
        fake.deleteBranch("acme/app", "constructor");
        fake.deleteBranch("acme/app", "main");
        await env.t.services.automation.syncBranches(project);
        list = (await env.t.request("/api/v1/w/acme/p/app/branches", { session: env.admin })).body;
        assert.equal(by("gone"), undefined);
        assert.equal(by("constructor"), undefined);
        assert.equal(by("main").github.onGitHub, false);
        const history = (await env.t.request("/api/v1/w/acme/p/app/reports?branch=gone", { session: env.admin })).body;
        assert.equal(history.archived[0].reason, "deleted");
        fake.repo("acme/app").branches.set("main", main);
    });

    test("the nightly full scan is queued once, at its hour", async () => {
        const hour = later(0).getUTCHours();
        await env.t.request("/api/v1/w/acme/p/app/settings/automation", {
            method: "PATCH",
            session: env.admin,
            body: { enabled: true, nightlyHourUtc: hour },
        });
        await env.t.services.automation.tick(later(0));
        await env.t.services.automation.tick(later(1));
        const jobs = (await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10)).filter((j) => j.kind === "full");
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.title, "Full scan of main (nightly)");
        assert.equal(jobs[0]?.source, "automation");
    });
});

describe("the GitHub App", () => {
    let env: ReviewEnv;
    let mallory: Session;
    before(async () => {
        env = await reviewEnv();
        // Two organisations; acme's admin is "admin", evil's is mallory.
        await patProject(env, "acme", { token: PAT(1) });
        await env.t.request("/api/v1/instance/users", {
            method: "POST",
            session: env.admin,
            body: { username: "mallory", password: "hunter2-hunter2-one" },
        });
        const first = await env.t.signIn("mallory", "hunter2-hunter2-one");
        await env.t.request("/api/v1/me/password", {
            method: "POST",
            session: first,
            body: { current: "hunter2-hunter2-one", password: "hunter2-hunter2-two" },
        });
        mallory = await env.t.signIn("mallory", "hunter2-hunter2-two");
        await env.t.request("/api/v1/workspaces", { method: "POST", session: mallory, body: { slug: "evil" } });
        await env.t.request("/api/v1/w/evil/projects", { method: "POST", session: mallory, body: { slug: "app" } });
        await env.t.request("/api/v1/w/evil/settings/review-model/keys/openrouter", {
            method: "PUT",
            session: mallory,
            body: { key: `sk-or-${randomBytes(12).toString("hex")}` },
        });
        await env.fake.gitRepo("acme/app", { "src/a.ts": "a\n" });
        await env.fake.gitRepo("evil/app", { "src/e.ts": "e\n" });
    });
    after(() => env.close());

    test("an instance admin creates it with GitHub's manifest flow; its secrets are kept, never shown", async () => {
        const start = await env.t.request("/api/v1/instance/github-app/manifest", {
            method: "POST",
            session: env.admin,
            body: { name: "Triagent test", public: true, org: "acme", ws: "acme" },
        });
        assert.equal(start.status, 200, start.text);
        const form = await env.t.app.request(`http://triagent.test${start.body.formUrl}`, { headers: { cookie: env.admin.cookie } });
        assert.equal(form.status, 200);
        assert.match(form.headers.get("content-security-policy") ?? "", new RegExp(`form-action ${env.fake.url}`));
        const html = await form.text();
        const action = /action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&") as string;
        assert.ok(action.startsWith(`${env.fake.url}/organizations/acme/settings/apps/new?state=`));
        const manifest = JSON.parse(
            (/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
        );
        assert.equal(manifest.hook_attributes.url, "http://triagent.test/api/v1/github/app/webhook");
        assert.equal(manifest.request_oauth_on_install, true);
        assert.deepEqual(manifest.default_permissions, {
            contents: "read",
            metadata: "read",
            members: "read",
            pull_requests: "write",
            statuses: "write",
            checks: "read",
        });
        assert.deepEqual(manifest.default_events, ["pull_request", "push", "create", "delete", "check_suite", "check_run", "status"]);
        // Someone else can't use the admin's form.
        assert.equal((await env.t.request(start.body.formUrl, { session: mallory })).status, 403);

        const state = new URL(action).searchParams.get("state") as string;
        const code = env.fake.manifestCode(manifest);
        const created = await env.t.app.request(
            `http://triagent.test/api/v1/instance/github-app/created?code=${code}&state=${encodeURIComponent(state)}`,
            {
                headers: { cookie: env.admin.cookie },
            },
        );
        assert.equal(created.status, 302);
        assert.equal(created.headers.get("location"), "/w/acme/settings/github-app?created=1");
        const status = (await env.t.request("/api/v1/instance/github-app", { session: env.admin })).body;
        assert.equal(status.configured, true);
        assert.equal(status.app.slug, env.fake.app?.slug);
        const text = JSON.stringify(status);
        for (const s of [env.fake.app?.clientSecret, env.fake.app?.webhookSecret, "PRIVATE KEY"]) assert.ok(!text.includes(s as string));
        assert.equal((await env.t.request("/api/v1/instance/github-app", { session: mallory })).status, 403);
    });

    async function link(session: Session, ws: string, installation: number, login: string, opts: { state?: string; setup?: boolean } = {}) {
        const started = await env.t.request(`/api/v1/w/${ws}/github/installations`, {
            method: "POST",
            session,
            body: { project: "app", ...(opts.setup ? { setup: true } : {}) },
        });
        assert.equal(started.status, 200, started.text);
        const url = new URL(started.body.url);
        assert.equal(url.pathname, `/apps/${env.fake.app?.slug}/installations/new`);
        const state = opts.state ?? (url.searchParams.get("state") as string);
        const code = env.fake.oauthCode(login);
        const res = await env.t.app.request(
            `http://triagent.test/api/v1/github/app/installed?code=${code}&installation_id=${installation}&setup_action=install&state=${encodeURIComponent(state)}`,
            { headers: { cookie: session.cookie } },
        );
        return { location: res.headers.get("location") ?? "", state: url.searchParams.get("state") as string };
    }

    test("linking an installation needs GitHub to confirm the person can see it", async () => {
        const acme = env.fake.install("acme", ["acme/app"], ["alice"]);
        const evil = env.fake.install("evil", ["evil/app"], ["mal"]);
        env.fake.orgRole("acme", "alice", "admin");
        env.fake.orgRole("evil", "mal", "admin");
        // Mallory claims acme's installation id: GitHub says her account can't see it.
        let r = await link(mallory, "evil", acme.id, "mal");
        assert.match(r.location, /\?github=not-yours$/);
        assert.equal(await env.t.services.store.githubInstallations.get(acme.id), null);
        // A bare installation id, without a state Triagent signed, links nothing.
        const bare = await env.t.app.request(
            `http://triagent.test/api/v1/github/app/installed?installation_id=${acme.id}&setup_action=install`,
            {
                headers: { cookie: mallory.cookie },
            },
        );
        assert.equal(bare.headers.get("location"), "/");
        // Someone else's state doesn't work either.
        const admins = await link(env.admin, "acme", acme.id, "nobody");
        r = await link(mallory, "evil", acme.id, "alice", { state: admins.state });
        assert.match(r.location, /\?github=not-you$/);
        assert.equal(await env.t.services.store.githubInstallations.get(acme.id), null);

        // The real owners link their own.
        r = await link(env.admin, "acme", acme.id, "alice");
        assert.equal(r.location, "/w/acme/p/app/settings/github?github=linked");
        assert.equal((await env.t.services.store.githubInstallations.get(acme.id))?.accountLogin, "acme");
        // Started from the project's guided setup: back into it.
        r = await link(mallory, "evil", evil.id, "mal", { setup: true });
        assert.equal(r.location, "/w/evil/p/app/settings/github?github=linked&setup=project");
        // An installation already linked to a workspace can't be taken by another, even by an admin of it.
        env.fake.installations.get(acme.id)?.users.add("mal");
        env.fake.orgRole("acme", "mal", "admin");
        r = await link(mallory, "evil", acme.id, "mal");
        assert.match(r.location, /github=taken$/);
        assert.equal(
            (await env.t.services.store.githubInstallations.get(acme.id))?.workspaceId,
            (await env.t.services.store.workspaces.bySlug("acme"))?.id,
        );
        // Only people who manage secrets start an installation.
        const token = await env.t.request("/api/v1/w/acme/settings/tokens", {
            method: "POST",
            session: env.admin,
            body: { name: "m", scope: "manage" },
        });
        assert.equal(
            (
                await env.t.request("/api/v1/w/acme/github/installations", {
                    method: "POST",
                    token: token.body.token,
                    body: { project: "app" },
                })
            ).status,
            403,
        );

        // Each project picks a repository from its own workspace's installations.
        const acmeRepo = env.fake.repo("acme/app");
        const list = (await env.t.request("/api/v1/w/acme/github/installations", { session: env.admin })).body;
        assert.deepEqual(
            list.items[0].repositories.map((x: { fullName: string }) => x.fullName),
            ["acme/app"],
        );
        const pick = await env.t.request("/api/v1/w/acme/p/app/settings/github/repository", {
            method: "PUT",
            session: env.admin,
            body: { installationId: acme.id, repositoryId: acmeRepo.id },
        });
        assert.equal(pick.status, 200, pick.text);
        const wrong = await env.t.request("/api/v1/w/evil/p/app/settings/github/repository", {
            method: "PUT",
            session: mallory,
            body: { installationId: acme.id, repositoryId: acmeRepo.id },
        });
        assert.equal(wrong.status, 404);
        assert.equal(
            (
                await env.t.request("/api/v1/w/evil/p/app/settings/github/repository", {
                    method: "PUT",
                    session: mallory,
                    body: { installationId: evil.id, repositoryId: env.fake.repo("evil/app").id },
                })
            ).status,
            200,
        );
        const settings = (await env.t.request("/api/v1/w/acme/p/app/settings/github", { session: env.admin })).body;
        assert.equal(settings.mode, "app");
        assert.equal(settings.repository.fullName, "acme/app");
        const tested = await env.t.request("/api/v1/w/acme/p/app/settings/github/test", { method: "POST", session: env.admin, body: {} });
        assert.equal(tested.body.mode, "app");
    });

    test("an organisation's installation is linked only by one of its admins; a personal account's, only by that account", async () => {
        // Bob can see corp's installation (he's a member), but doesn't administer corp.
        const corp = env.fake.install("corp", ["corp/app"], ["bob"]);
        env.fake.orgRole("corp", "bob", "member");
        let r = await link(env.admin, "acme", corp.id, "bob");
        assert.match(r.location, /\?github=not-admin$/);
        assert.equal(await env.t.services.store.githubInstallations.get(corp.id), null);
        // An invitation to be an admin isn't the same as being one.
        env.fake.orgRole("corp", "bob", "admin", "pending");
        r = await link(env.admin, "acme", corp.id, "bob");
        assert.match(r.location, /\?github=not-admin$/);
        env.fake.orgRole("corp", "bob", "admin");
        r = await link(env.admin, "acme", corp.id, "bob");
        assert.match(r.location, /\?github=linked$/);

        // A personal account's installation: Dave can see it (a collaborator), but it isn't his account.
        const carol = env.fake.install("carol", ["carol/tool"], ["carol", "dave"], { account: { login: "carol", type: "User" } });
        r = await link(env.admin, "acme", carol.id, "dave");
        assert.match(r.location, /\?github=not-account$/);
        assert.equal(await env.t.services.store.githubInstallations.get(carol.id), null);
        r = await link(env.admin, "acme", carol.id, "carol");
        assert.match(r.location, /\?github=linked$/);
        for (const id of [corp.id, carol.id])
            assert.equal(
                (await env.t.request(`/api/v1/w/acme/github/installations/${id}`, { method: "DELETE", session: env.admin })).status,
                200,
            );
    });

    test("losing the right to manage secrets while GitHub is being asked links nothing", async () => {
        const late = env.fake.install("late", ["late/app"], ["alice"]);
        env.fake.orgRole("late", "alice", "admin");
        const store = env.t.services.store;
        const workspace = await store.workspaces.bySlug("acme");
        const user = await store.users.byUsername("admin");
        const before = workspace && user ? await store.memberships.get(workspace.id, user.id) : null;
        assert.ok(before);
        const app = env.t.services.github.app;
        const original = app.installation.bind(app);
        // Demoted between the first check and the link.
        app.installation = async (id: number) => {
            await store.transaction((tx) => tx.memberships.put({ ...before, role: "viewer" }));
            return original(id);
        };
        try {
            const r = await link(env.admin, "acme", late.id, "alice");
            assert.match(r.location, /\?github=not-allowed$/);
            assert.equal(await store.githubInstallations.get(late.id), null);
        } finally {
            app.installation = original;
            await store.transaction((tx) => tx.memberships.put(before));
        }
    });

    test("the app's webhook: verified, then routed by installation and repository to the right workspace's project", async () => {
        const secret = env.fake.app?.webhookSecret as string;
        const hook = `${env.url}/api/v1/github/app/webhook`;
        const acme = [...env.fake.installations.values()].find((i) => i.account.login === "acme") as { id: number };
        const evilInst = [...env.fake.installations.values()].find((i) => i.account.login === "evil") as { id: number };
        for (const ws of ["acme", "evil"])
            await env.t.request(`/api/v1/w/${ws}/p/app/settings/automation`, {
                method: "PATCH",
                session: ws === "acme" ? env.admin : mallory,
                body: { enabled: true, firstReview: "ready" },
            });
        // A first check sets the baseline (nothing open yet).
        for (const ws of ["acme", "evil"]) {
            const w = await env.t.services.store.workspaces.bySlug(ws);
            await env.t.services.automation.checkPulls((await env.t.services.store.projects.bySlug(w?.id as string, "app")) as never);
        }
        await env.fake.commit("acme/app", "feat", { "src/f.ts": "f\n" }, "f", "main");
        await env.fake.openPull("acme/app", { number: 1, headRef: "feat" });
        await env.fake.commit("evil/app", "feat", { "src/f.ts": "f\n" }, "f", "main");
        await env.fake.openPull("evil/app", { number: 1, headRef: "feat" });

        const payload = (inst: number, repo: string) => ({
            action: "opened",
            number: 1,
            pull_request: { number: 1 },
            installation: { id: inst },
            repository: { id: env.fake.repo(repo).id, full_name: repo },
        });
        assert.equal((await env.fake.deliver(hook, "pull_request", payload(acme.id, "acme/app"), "nope")).status, 401);
        const ok = await env.fake.deliver(hook, "pull_request", payload(acme.id, "acme/app"), secret);
        assert.equal(ok.status, 200);
        await env.t.services.runs.settled();
        const queued = await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10);
        const acmeWs = (await env.t.services.store.workspaces.bySlug("acme"))?.id;
        assert.deepEqual(
            queued.map((j) => j.workspaceId),
            [acmeWs],
        );
        // A repository id that belongs to another installation goes nowhere.
        const crossed = await env.fake.deliver(hook, "pull_request", payload(acme.id, "evil/app"), secret);
        assert.match(String(crossed.body.note), /No project in the workspace uses that repository/);
        const unknown = await env.fake.deliver(hook, "pull_request", payload(999_999, "evil/app"), secret);
        assert.equal(unknown.body.ignored, true);

        // Installation events keep the table current; a suspended installation can't be used.
        await env.fake.deliver(hook, "installation", { action: "suspend", installation: { id: evilInst.id } }, secret);
        assert.equal((await env.t.services.store.githubInstallations.get(evilInst.id))?.suspended, true);
        const start = await env.t.request("/api/v1/w/evil/p/app/reviews", { method: "POST", session: mallory, body: { kind: "full" } });
        assert.equal(start.status, 400);
        assert.match(start.body.error, /suspended/);
        await env.fake.deliver(hook, "installation", { action: "deleted", installation: { id: evilInst.id } }, secret);
        assert.equal(await env.t.services.store.githubInstallations.get(evilInst.id), null);
        const status = (await env.t.request("/api/v1/instance/github-app", { session: env.admin })).body;
        assert.ok(!status.deliveries.some((d: { outcome: string }) => d.outcome === "refused"));
        assert.equal(status.refused.count, 1);
        assert.match(status.refused.lastReason, /^Bad signature/);
    });

    test("a review through the app: a token narrowed to the repository, read-only for the runner", async () => {
        await env.t.request("/api/v1/w/acme/settings/review-model/keys/openrouter", {
            method: "PUT",
            session: env.admin,
            body: { key: `sk-or-${randomBytes(12).toString("hex")}` },
        });
        await env.t.request("/api/v1/w/acme/settings/review-model", { method: "PATCH", session: env.admin, body: { model: "fake/model" } });
        // The project's old token is cleared: everything goes through the app.
        await env.t.request("/api/v1/w/acme/p/app/settings/github/token", { method: "DELETE", session: env.admin });
        for (const j of await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10))
            await env.t.request(`/api/v1/w/acme/runs/${j.id}/cancel`, { method: "POST", session: env.admin, body: {} });
        // A comment someone else wrote, carrying Triagent's marker, isn't Triagent's to edit.
        const planted = { id: 1, body: `Looks fine to me ${COMMENT_MARKER}`, user: "mallory" };
        env.fake.repo("acme/app").comments.set(1, [planted]);
        env.runner();
        const logged = env.fake.log.length;
        const started = await env.t.request("/api/v1/w/acme/p/app/reviews", {
            method: "POST",
            session: env.admin,
            body: { kind: "pr", number: 1 },
        });
        assert.equal(started.status, 201, started.text);
        const run = await finished(env, "acme", started.body.id);
        assert.equal(run.status, "done", run.error);
        const repoId = env.fake.repo("acme/app").id;
        const mints = env.fake.log.slice(logged).filter((l) => /\/access_tokens$/.test(l.path));
        assert.ok(mints.length >= 1);
        for (const m of mints) assert.deepEqual((m.body as { repository_ids: number[] }).repository_ids, [repoId]);
        // The runner's token: minted for this review alone, reading contents only, and revoked when it ended.
        const forJob = mints.filter(
            (m) => JSON.stringify((m.body as { permissions: object }).permissions) === JSON.stringify({ contents: "read" }),
        );
        assert.equal(forJob.length, 1);
        const fetched = [...new Set(env.fake.gitLog.filter((g) => g.token.startsWith("ghs_")).map((g) => g.token))];
        assert.equal(fetched.length, 1);
        assert.ok(env.fake.revoked.has(fetched[0] as string), "the review's token was revoked");
        // The server's own token, for statuses and comments, is another, and still works.
        assert.ok(env.fake.installationTokens.size > 0);
        assert.ok(![...env.fake.installationTokens.keys()].some((t) => env.fake.revoked.has(t)));
        assert.ok(env.fake.repo("acme/app").statuses.every((s) => s.by === "installation"));
        const comments = env.fake.repo("acme/app").comments.get(1) ?? [];
        assert.equal(comments.length, 2);
        assert.deepEqual(comments[0], { id: 1, body: `Looks fine to me ${COMMENT_MARKER}`, user: "mallory" });
        assert.equal(comments[1]?.user, `${env.fake.app?.slug}[bot]`);
        assert.match(comments[1]?.body ?? "", /Open Code Review/);
        assert.ok(env.fake.gitLog.some((g) => g.token.startsWith("ghs_")));
    });

    test("an installation that hasn't accepted Checks: read: reviews start when ready, and say so, until it has", async () => {
        const installation = [...env.fake.installations.values()].find((i) => i.account.login === "acme") as {
            id: number;
            permissions: Set<string>;
        };
        const acme = await env.t.services.store.workspaces.bySlug("acme");
        const project = (await env.t.services.store.projects.bySlug(acme?.id as string, "app")) as never;
        const page = async (n: number) =>
            (await env.t.request("/api/v1/w/acme/p/app/pull-requests", { session: env.admin })).body.items.find(
                (p: { number: number }) => p.number === n,
            );
        await env.t.request("/api/v1/w/acme/p/app/settings/automation", {
            method: "PATCH",
            session: env.admin,
            body: { firstReview: "checks" },
        });
        // The app was created before it asked for the permission: a token that asks for it is refused.
        installation.permissions.delete("checks");
        const second = await env.fake.commit("acme/app", "second", { "src/s.ts": "s\n" }, "s", "main");
        await env.fake.openPull("acme/app", { number: 2, headRef: "second" });
        env.fake.checkRun("acme/app", second, "build", "in_progress");
        await env.t.services.automation.checkPulls(project);
        assert.deepEqual(
            [(await page(2)).lastDecision.action, (await page(2)).lastDecision.why],
            ["queued", "can't see checks, so reviewing when ready"],
        );
        let settings = (await env.t.request("/api/v1/w/acme/p/app/settings/github", { session: env.admin })).body;
        assert.equal(settings.checksReadable, false);
        assert.ok(settings.app.htmlUrl);
        // Everything else the app does still works: only the checks are asked for with their own token.
        assert.equal((await env.t.request("/api/v1/w/acme/p/app/pull-requests", { session: env.admin })).body.lastCheck.error, undefined);

        // Accepted on the installation: checks are waited for, and their events (through the app's webhook) start the review.
        installation.permissions.add("checks");
        const third = await env.fake.commit("acme/app", "third", { "src/t.ts": "t\n" }, "t", "main");
        await env.fake.openPull("acme/app", { number: 3, headRef: "third" });
        env.fake.checkRun("acme/app", third, "build", "in_progress");
        await env.t.services.automation.checkPulls(project);
        assert.equal((await page(3)).status, "waiting for checks (1 of 1)");
        settings = (await env.t.request("/api/v1/w/acme/p/app/settings/github", { session: env.admin })).body;
        assert.equal(settings.checksReadable, true);
        env.fake.checkRun("acme/app", third, "build", "completed", "success");
        const delivered = await env.fake.deliver(
            `${env.url}/api/v1/github/app/webhook`,
            "check_suite",
            {
                action: "completed",
                check_suite: { head_sha: third },
                installation: { id: installation.id },
                repository: { id: env.fake.repo("acme/app").id, full_name: "acme/app" },
            },
            env.fake.app?.webhookSecret as string,
        );
        assert.equal(delivered.status, 200);
        await env.t.services.runs.settled();
        assert.equal((await page(3)).lastDecision.action, "queued");
        assert.match((await page(3)).lastDecision.why, /its check has passed/);
        await eventually(
            async () => (await env.t.services.store.jobs.list({ statuses: ["queued", "running"] }, 10)).length === 0,
            "the reviews to finish",
        );
        await env.t.services.runs.settled();
        assert.equal((await page(3)).reviewed, true);
        await env.t.request("/api/v1/w/acme/p/app/settings/automation", {
            method: "PATCH",
            session: env.admin,
            body: { firstReview: "ready" },
        });
    });

    test("each review's token is its own, and is revoked however the review ends: cancelled, or its runner lost", async () => {
        const runs = env.t.services.runs;
        const acme = (await env.t.services.store.workspaces.bySlug("acme")) as NonNullable<
            Awaited<ReturnType<typeof env.t.services.store.workspaces.bySlug>>
        >;
        const project = (await env.t.services.store.projects.bySlug(acme.id, "app")) as NonNullable<
            Awaited<ReturnType<typeof env.t.services.store.projects.bySlug>>
        >;
        for (const r of env.runners) await r.stop();
        const hello = { id: "runner-manual-0000", name: "manual", version: "1", slots: 1 };
        const tokens: string[] = [];
        for (const how of ["cancelled", "lost"] as const) {
            await runs.enqueue({ name: "admin", userId: null, via: "web" }, project, specForBranch("full", "main", null));
            const job = await runs.claim(hello);
            assert.ok(job);
            tokens.push(job.git.token);
            assert.ok(env.fake.installationTokens.has(job.git.token));
            if (how === "cancelled") await runs.finish(hello, job.id, { status: "cancelled" });
            else {
                const stored = await env.t.services.store.jobs.get(job.id);
                await env.t.services.store.jobs.put({
                    ...(stored as NonNullable<typeof stored>),
                    leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
                });
                assert.equal(await runs.sweep(), 1);
            }
            await runs.settled();
            assert.ok(env.fake.revoked.has(job.git.token), `the token was revoked when the review was ${how}`);
        }
        assert.notEqual(tokens[0], tokens[1]);
    });

    test("removing the app unlinks its installations", async () => {
        assert.equal((await env.t.request("/api/v1/instance/github-app", { method: "DELETE", session: env.admin })).status, 200);
        assert.equal((await env.t.request("/api/v1/instance/github-app", { session: env.admin })).body.configured, false);
        assert.equal(
            (
                await env.t.services.store.githubInstallations.forWorkspace(
                    (
                        await env.t.services.store.workspaces.bySlug("acme")
                    )?.id as string,
                )
            ).length,
            0,
        );
    });
});

describe("MCP tools for reviews", () => {
    let env: ReviewEnv;
    let manage: string;
    let read: string;
    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme");
        await env.fake.gitRepo("acme/app", { "src/a.ts": "a\n" });
        await env.fake.commit("acme/app", "feat", { "src/f.ts": "f\n" }, "f", "main");
        await env.fake.openPull("acme/app", { number: 3, headRef: "feat", title: "A feature" });
        manage = (
            await env.t.request("/api/v1/w/acme/settings/tokens", {
                method: "POST",
                session: env.admin,
                body: { name: "agent", scope: "manage" },
            })
        ).body.token;
        read = (
            await env.t.request("/api/v1/w/acme/settings/tokens", {
                method: "POST",
                session: env.admin,
                body: { name: "reader", scope: "read" },
            })
        ).body.token;
    });
    after(() => env.close());

    const call = async (token: string, name: string, args: object) => {
        const r = await env.t.request("/mcp", {
            method: "POST",
            token,
            body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        });
        return r.body.result;
    };

    test("an agent starts a review, waits for it, and reads the outcome; a read token can't start one", async () => {
        const tools = (
            await env.t.request("/mcp", { method: "POST", token: read, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })
        ).body.result.tools.map((t: { name: string }) => t.name);
        for (const t of ["list_runs", "get_run", "wait_for_run", "list_pull_requests"]) assert.ok(tools.includes(t), t);
        for (const t of ["start_review", "cancel_run", "check_pull_requests"]) assert.ok(!tools.includes(t), t);
        assert.equal((await call(read, "start_review", { project: "app", kind: "pr", number: 3 })).isError, true);

        const started = await call(manage, "start_review", { project: "app", kind: "pr", number: 3 });
        assert.equal(started.isError, false, started.content[0].text);
        const id = started.structuredContent.id;
        assert.match(started.content[0].text, /Queued run .*PR #3: A feature/);
        const waitingAlready = await call(read, "wait_for_run", { id, seconds: 1 });
        assert.match(waitingAlready.content[0].text, /still queued/);
        assert.match((await call(read, "list_runs", {})).content[0].text, /Queued \(1\)/);
        env.runner();
        const done = await call(read, "wait_for_run", { id, seconds: 60 });
        assert.match(done.content[0].text, /done\. 1 finding\(s\) on branch feat/);
        assert.match((await call(read, "get_run", { id })).content[0].text, /\[triagent\] Fetching pull request #3/);
        const checked = await call(manage, "check_pull_requests", { project: "app" });
        assert.match(checked.content[0].text, /1 open pull request/);
        assert.match((await call(read, "list_pull_requests", { project: "app" })).content[0].text, /#3 A feature \(feat/);

        await env.t.request("/api/v1/w/acme/settings/review-model", {
            method: "PATCH",
            session: env.admin,
            body: { model: "fake/sleep-20" },
        });
        const slow = await call(manage, "start_review", { project: "app", kind: "full" });
        await eventually(
            async () => (await env.t.services.store.jobs.get(slow.structuredContent.id))?.status === "running",
            "the scan to start",
        );
        const cancelled = await call(manage, "cancel_run", { id: slow.structuredContent.id });
        assert.match(cancelled.content[0].text, /Asked .* to stop/);
        const end = await call(read, "wait_for_run", { id: slow.structuredContent.id, seconds: 30 });
        assert.match(end.content[0].text, /cancelled/);
    });

    test("people need operate to start or cancel reviews", async () => {
        await env.t.request("/api/v1/instance/users", {
            method: "POST",
            session: env.admin,
            body: { username: "vic", password: "viewer-password-one" },
        });
        let vic = await env.t.signIn("vic", "viewer-password-one");
        await env.t.request("/api/v1/me/password", {
            method: "POST",
            session: vic,
            body: { current: "viewer-password-one", password: "viewer-password-two" },
        });
        vic = await env.t.signIn("vic", "viewer-password-two");
        await env.t.request("/api/v1/w/acme/settings/members", {
            method: "POST",
            session: env.admin,
            body: { username: "vic", role: "editor" },
        });
        assert.equal(
            (await env.t.request("/api/v1/w/acme/p/app/reviews", { method: "POST", session: vic, body: { kind: "full" } })).status,
            403,
        );
        const theirs = await env.t.request("/api/v1/w/acme/runs", { session: vic });
        assert.equal(theirs.status, 200);
        // Which runners there are, and their versions, are the instance's business: members see how many.
        assert.deepEqual(theirs.body.runners, []);
        assert.equal(theirs.body.runnersConnected, 1);
        const admins = (await env.t.request("/api/v1/w/acme/runs", { session: env.admin })).body;
        assert.equal(admins.runnersConnected, 1);
        assert.match(admins.runners[0].name, /^test-runner-/);
        assert.ok(admins.runners[0].version);
        assert.equal(
            (await env.t.request("/api/v1/w/acme/p/app/pull-requests/check", { method: "POST", session: vic, body: {} })).status,
            403,
        );
        void ADMIN_PASSWORD;
    });
});

test("the poller checks up to four projects at once, and never two for the same repository", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "acme" } });
    const add = async (ws: string, slug: string, repo: string | null) => {
        const body = { slug, ...(repo ? { repoUrl: `https://github.com/${repo}` } : {}) };
        assert.equal((await t.request(`/api/v1/w/${ws}/projects`, { method: "POST", session: admin, body })).status, 201);
    };
    // Three projects on one repository (in two workspaces, written differently), five on their own, two with none.
    await add("acme", "shared-1", "acme/shared");
    await add("acme", "shared-2", "Acme/Shared");
    await add("admin", "shared-3", "acme/shared");
    for (const n of [1, 2, 3, 4, 5]) await add("acme", `own-${n}`, `acme/own-${n}`);
    await add("acme", "none-1", null);
    await add("admin", "none-2", null);

    // Each check takes a moment, and one fails: the pass carries on.
    const running = new Map<string, string | null>();
    const seen: string[] = [];
    let most = 0;
    let shared = 0;
    (t.services.automation as unknown as { tickProject(p: { slug: string; repoUrl: string | null }): Promise<void> }).tickProject = async (
        p,
    ) => {
        const repo = p.repoUrl?.toLowerCase() ?? null;
        assert.ok(repo === null || ![...running.values()].includes(repo), `two checks of ${repo} at once`);
        running.set(p.slug, repo);
        most = Math.max(most, running.size);
        if (repo?.endsWith("/shared")) shared++;
        await new Promise((r) => setTimeout(r, 20));
        running.delete(p.slug);
        seen.push(p.slug);
        if (p.slug === "own-2") throw new Error("GitHub is away");
    };
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
        await t.services.automation.tick();
    } finally {
        console.error = log;
    }
    assert.equal(seen.length, 10, "every project was checked once");
    assert.equal(new Set(seen).size, 10);
    assert.equal(shared, 3);
    assert.equal(most, 4);
    assert.deepEqual(errors, ["[own-2] Automatic reviews: GitHub is away"]);
});
