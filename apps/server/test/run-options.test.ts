// Options for reviews run with several models (packages/shared/src/run-options.ts): each is off unless
// chosen for a run or by its project, and a review with one model has none.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { NO_OPTIONS, type RunOptions } from "@triagent/shared";
import { candidatePairs, groupFindings, joinGroups } from "@triagent/shared/merge";
import { mergeReports } from "../src/domain/merge.ts";
import { parseReport, priorityCompare } from "../src/domain/report.ts";
import { commentBody, finishedStatus } from "../src/domain/review-run.ts";
import { agreedCritical, effectiveOptions } from "../src/services/runs.ts";
import { eventually, finished, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const on = (change: Partial<RunOptions>): RunOptions => ({ ...structuredClone(NO_OPTIONS), ...change });

describe("which findings are the same, as the server and the runner both work it out", () => {
    const f = (path: string, line: number | null, category = "bug") => ({
        path,
        category,
        content: "x",
        ...(line === null ? {} : { start_line: line, end_line: line }),
    });

    test("findings are grouped by place, named by the model's place and the finding's", () => {
        const parts = [[f("x.ts", 10), f("y.ts", 1)], null, [f("x.ts", 12), "not a finding", f("x.ts", 30)]];
        assert.deepEqual(groupFindings(parts), [
            [
                { part: 0, index: 0 },
                { part: 2, index: 0 },
            ],
            [{ part: 0, index: 1 }],
            [{ part: 2, index: 2 }],
        ]);
    });

    test("pairs to ask about: groups in the same file with no model in both, the closest first, up to a limit", () => {
        const parts = [
            [f("x.ts", 10), f("x.ts", 100), f("y.ts", 1)],
            [f("x.ts", 60, "security"), f("x.ts", 11, "style"), f("z.ts", 1), f("x.ts", null)],
        ];
        const { pairs, total } = candidatePairs(parts);
        // Never two findings of one model, and never across files.
        assert.equal(total, 6);
        assert.deepEqual(pairs.slice(0, 2), [
            { a: { part: 0, index: 0 }, b: { part: 1, index: 1 } },
            { a: { part: 0, index: 1 }, b: { part: 1, index: 0 } },
        ]);
        assert.ok(pairs.every((p) => p.a.part !== p.b.part));
        // A finding without lines is asked about last.
        assert.deepEqual(pairs.at(-1)?.b, { part: 1, index: 3 });
        assert.deepEqual(candidatePairs(parts, 2), { pairs: pairs.slice(0, 2), total: 6 });
        // What the lines and category already made one finding isn't asked about.
        assert.deepEqual(candidatePairs([[f("x.ts", 10)], [f("x.ts", 11)]]), { pairs: [], total: 0 });
    });

    test("groups a model said are the same are joined, unless a model would then be in one twice", () => {
        const parts = [[f("x.ts", 10), f("x.ts", 50)], [f("x.ts", 30, "style")], [f("x.ts", 52, "security")]];
        const groups = groupFindings(parts);
        assert.equal(groups.length, 4);
        const a0 = { part: 0, index: 0 };
        const a1 = { part: 0, index: 1 };
        const b0 = { part: 1, index: 0 };
        const c0 = { part: 2, index: 0 };
        assert.deepEqual(
            joinGroups(groups, [
                { a: a1, b: c0 },
                { a: a0, b: b0 },
            ]),
            [
                [a0, b0],
                [a1, c0],
            ],
        );
        // The second would put the first model's two findings in one group: it's left out.
        assert.deepEqual(
            joinGroups(groups, [
                { a: a0, b: b0 },
                { a: a1, b: b0 },
            ]),
            [[a0, b0], [a1], [c0]],
        );
        assert.deepEqual(joinGroups(groups, []), groups);
    });
});

/** What these tests do over and over, for one workspace and its repository. */
function kit(the: () => ReviewEnv, ws: string, repo: string) {
    const request: ReviewEnv["t"]["request"] = (url, init) => the().t.request(url, init);
    const admin = () => the().admin;
    /** The id of the favourite that is this model, added to the workspace's favourites first if it isn't one. */
    const favourite = async (model: string, provider = "openrouter"): Promise<string> => {
        const url = `/api/v1/w/${ws}/settings/models/favourites`;
        type Fav = { id: string; provider: string; model: string };
        const is = (f: Fav) => f.provider === provider && f.model === model;
        const have = (await request(url, { session: admin() })).body.favourites.find(is);
        if (have) return have.id;
        const added = await request(url, { method: "POST", session: admin(), body: { provider, model } });
        assert.equal(added.status, 201, added.text);
        return added.body.favourites.find(is).id;
    };
    const post = (body: object) => request(`/api/v1/w/${ws}/p/app/reviews`, { method: "POST", session: admin(), body });
    const start = async (body: object) => {
        const r = await post(body);
        assert.equal(r.status, 201, r.text);
        return r.body;
    };
    const automation = (body: object) => request(`/api/v1/w/${ws}/p/app/settings/automation`, { method: "PATCH", session: admin(), body });
    const issues = async (branch: string, query = "") =>
        (await request(`/api/v1/w/${ws}/p/app/issues?branch=${branch}${query}`, { session: admin() })).body;
    const run = async (id: string) => (await request(`/api/v1/w/${ws}/runs/${id}`, { session: admin() })).body;
    /** A pull request that adds `files`, from a branch of its own. */
    const pull = async (number: number, files: Record<string, string>) => {
        const head = await the().fake.commit(repo, `pr-${number}`, files, `Change ${number}`, "main");
        await the().fake.openPull(repo, { number, headRef: `pr-${number}`, title: `Change ${number}` });
        return head;
    };
    const lastStatus = (sha: string) =>
        the()
            .fake.repo(repo)
            .statuses.filter((s) => s.sha === sha)
            .at(-1);
    const comment = (number: number) => the().fake.repo(repo).comments.get(number)?.at(-1)?.body ?? "";
    /** An API token of this workspace's, and what MCP answers it. */
    const token = async (scope: string) =>
        (await request(`/api/v1/w/${ws}/settings/tokens`, { method: "POST", session: admin(), body: { name: `agent-${scope}`, scope } }))
            .body.token as string;
    const mcp = async (bearer: string, name: string, args: object) => {
        const r = await request("/mcp", {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}`, accept: "application/json, text/event-stream" },
            body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        });
        assert.equal(r.status, 200, r.text);
        return r.body.result;
    };
    return { request, favourite, post, start, automation, issues, run, pull, lastStatus, comment, token, mcp };
}

describe("a review's options", () => {
    let env: ReviewEnv;
    const ws = "options";

    const {
        favourite,
        post,
        start,
        automation,
        issues,
        pull,
        lastStatus,
        comment,
        token,
        mcp: callMcp,
    } = kit(() => env, ws, "options/app");

    before(async () => {
        env = await reviewEnv();
        await patProject(env, ws, { repo: "options/app" });
        await env.fake.gitRepo("options/app", { "src/a.ts": "export const a = 1;\n" });
        env.runner();
    });
    after(() => env.close());

    test("a review with one model has none, and no rule asks more models to agree than it has", () => {
        const asked = on({ retryFailed: true, agreement: { failAt: 4, markSingles: true }, judge: "first" });
        assert.deepEqual(effectiveOptions(asked, 1), NO_OPTIONS);
        assert.deepEqual(effectiveOptions(asked, 3), { ...asked, agreement: { failAt: 3, markSingles: true } });
        assert.deepEqual(effectiveOptions(asked, 5), asked);
    });

    test("options that aren't known are refused; none at all, or an empty set, changes nothing", async () => {
        const start = (body: object) => env.t.request(`/api/v1/w/${ws}/p/app/reviews`, { method: "POST", session: env.admin, body });
        const unknown = await start({ kind: "full", branch: "main", options: { nonsense: true } });
        assert.equal(unknown.status, 400, unknown.text);
        const plain = await start({ kind: "full", branch: "main", options: {} });
        assert.equal(plain.status, 201, plain.text);
        assert.deepEqual(plain.body.options, NO_OPTIONS);
        await env.t.request(`/api/v1/w/${ws}/runs/${plain.body.id}/cancel`, { method: "POST", session: env.admin });
        const automation = (await env.t.request(`/api/v1/w/${ws}/p/app/settings/automation`, { session: env.admin })).body;
        assert.deepEqual(automation.options, {});
    });

    // ---- agreement rules ---------------------------------------------------------------------------

    test("options need two or more models, and a rule can't ask for more models than the review has", async () => {
        const one = await post({ kind: "full", branch: "main", options: { agreement: { markSingles: true } } });
        assert.equal(one.status, 400, one.text);
        assert.match(one.text, /two or more models, and this one has one/);
        const two = [await favourite("fake/model"), await favourite("fake/wordy-alarm")];
        const many = await post({ kind: "full", branch: "main", models: two, options: { agreement: { failAt: 3 } } });
        assert.equal(many.status, 400, many.text);
        assert.match(many.text, /has 2 models, so agreement.failAt can be at most 2/);
        for (const failAt of [1, 6, 2.5])
            assert.equal((await post({ kind: "full", branch: "main", models: two, options: { agreement: { failAt } } })).status, 400);
        // Everything off is no option at all, so one model is fine.
        assert.equal(
            (await post({ kind: "full", branch: "main", options: { agreement: { failAt: null, markSingles: false } } })).status,
            201,
        );
    });

    test("the critical findings enough models found, and what the check and the comment say about them", () => {
        const f = (line: number, severity: string) => ({
            path: "x.ts",
            content: `at ${line}`,
            severity,
            category: "bug",
            start_line: line,
        });
        const merged = mergeReports([
            { label: "a", report: { comments: [f(10, "critical"), f(50, "critical"), f(90, "high")] } },
            { label: "b", report: { comments: [f(11, "low"), f(91, "critical")] } },
            { label: "c", report: null, error: "failed" },
        ]);
        // The lead's rating is the finding's: the third is high, whatever the second model called it.
        assert.deepEqual(agreedCritical(merged, 2), { models: 2, critical: 1 });
        // Fewer models finished than the rule asks for: all that did must have found it.
        assert.deepEqual(agreedCritical(merged, 3), { models: 2, critical: 1 });
        assert.deepEqual(agreedCritical(mergeReports([{ label: "a", report: { comments: [f(1, "critical")] } }]), 2), {
            models: 1,
            critical: 1,
        });

        const bySeverity = { critical: 2, high: 1, medium: 0, low: 0 };
        const status = (agreed: { models: number; critical: number } | null, failOnCritical = true) =>
            finishedStatus({ status: "done", total: 3, bySeverity, failOnCritical, agreed });
        assert.deepEqual(status(null), { state: "failure", description: "2 critical: 2 critical, 1 high" });
        assert.deepEqual(status({ models: 2, critical: 1 }), {
            state: "failure",
            description: "1 critical found by 2+ models: 2 critical, 1 high",
        });
        assert.deepEqual(status({ models: 2, critical: 0 }), { state: "success", description: "2 critical, 1 high" });
        assert.equal(status({ models: 2, critical: 1 }, false).state, "success");

        const body = (agreed: { models: number; critical: number } | null) =>
            commentBody({
                marker: "<!-- m -->",
                total: 3,
                bySeverity,
                urgent: [],
                gaps: null,
                failOnCritical: true,
                agreed,
                commit: "a".repeat(40),
                issuesUrl: "https://t/issues",
                issueUrl: (id) => `https://t/issues/${id}`,
            });
        assert.match(body(null), /check fails because of 2 critical findings\. Fix them/);
        assert.match(body({ models: 2, critical: 1 }), /check fails because of 1 critical finding at least 2 models found\. Fix it/);
        assert.match(
            body({ models: 2, critical: 0 }),
            /check passes: this review fails it only for critical findings at least 2 models found, and none of the 2 critical findings was\./,
        );
    });

    test("findings one model found are marked only when the review asks, and come after the others of their severity", () => {
        const f = (line: number, severity: string, content: string) => ({
            path: "x.ts",
            content,
            severity,
            category: "bug",
            start_line: line,
        });
        const merged = mergeReports([
            { label: "a", report: { comments: [f(10, "high", "A alone, first"), f(50, "high", "Both"), f(90, "low", "A alone, low")] } },
            { label: "b", report: { comments: [f(51, "high", "Both, B"), f(200, "critical", "B alone, critical")] } },
        ]);
        const plain = parseReport(merged, null);
        assert.equal(plain.meta.markSingles, false);
        assert.ok(plain.issues.every((x) => !x.lowerConfidence));
        assert.deepEqual(
            [...plain.issues].sort(priorityCompare).map((x) => x.content),
            ["B alone, critical", "A alone, first", "Both", "A alone, low"],
        );
        const marked = parseReport({ ...merged, mark_singles: true }, null);
        assert.equal(marked.meta.markSingles, true);
        assert.deepEqual(
            marked.issues.map((x) => [x.content, x.lowerConfidence]),
            [
                ["A alone, first", true],
                ["Both", false],
                ["A alone, low", true],
                ["B alone, critical", true],
            ],
        );
        // Still by severity first: a critical one model found is above a high two did.
        assert.deepEqual(
            [...marked.issues].sort(priorityCompare).map((x) => x.content),
            ["B alone, critical", "Both", "A alone, first", "A alone, low"],
        );
        // A report with one model, or one that only says so, marks nothing.
        assert.equal(
            parseReport({ comments: [{ ...f(1, "high", "x"), found_by: ["a"] }], models: ["a"], mark_singles: true }, null).meta
                .markSingles,
            false,
        );
    });

    test("failAt: a critical one model found doesn't fail the pull request's check; one enough models found does", async () => {
        const models = [await favourite("fake/model"), await favourite("fake/wordy-alarm")];
        // Without the rule: any critical finding fails it, as it always has.
        const plainHead = await pull(31, { "src/plain.ts": "export const plain = 1;\n" });
        const plain = await finished(env, ws, (await start({ kind: "pr", number: 31, models })).id);
        assert.equal(plain.status, "done", plain.error);
        assert.equal(plain.options, null);
        assert.equal(plain.result.agreement, undefined);
        assert.equal(lastStatus(plainHead)?.state, "failure");
        assert.match(lastStatus(plainHead)?.description ?? "", /^1 critical: 1 critical, 1 high$/);

        // With it: the same findings, all kept, and the check passes.
        const head = await pull(32, { "src/one.ts": "export const one = 1;\n" });
        const run = await finished(env, ws, (await start({ kind: "pr", number: 32, models, options: { agreement: { failAt: 2 } } })).id);
        assert.equal(run.status, "done", run.error);
        assert.deepEqual(run.options, { ...NO_OPTIONS, agreement: { failAt: 2, markSingles: false } });
        assert.deepEqual(run.result.agreement, { models: 2, critical: 0 });
        assert.deepEqual(run.result.bySeverity, { critical: 1, high: 1, medium: 0, low: 0 });
        assert.equal(lastStatus(head)?.state, "success");
        assert.equal(lastStatus(head)?.description, "1 critical, 1 high");
        assert.match(
            comment(32),
            /check passes: this review fails it only for critical findings at least 2 models found, and the one critical finding wasn't\./,
        );
        const listed = await issues("pr-32");
        assert.equal(listed.total, 2, "every finding is still there");
        assert.equal(listed.markSingles, false);
        assert.ok(listed.items.every((x: { lowerConfidence: boolean }) => x.lowerConfidence === false));

        // Both models call this one critical: the check fails, saying how many found it.
        const both = await pull(33, { "src/two.ts": "// CRITICAL\nexport const two = 2;\n" });
        const failing = await finished(
            env,
            ws,
            (await start({ kind: "pr", number: 33, models, options: { agreement: { failAt: 2 } } })).id,
        );
        assert.deepEqual(failing.result.agreement, { models: 2, critical: 1 });
        assert.equal(lastStatus(both)?.state, "failure");
        assert.equal(lastStatus(both)?.description, "1 critical found by 2+ models: 2 critical");
        assert.match(comment(33), /check fails because of 1 critical finding at least 2 models found/);
    });

    test("markSingles: listed, filtered and sorted through the API and MCP, with triage as it was", async () => {
        const models = [await favourite("fake/model"), await favourite("fake/wordy-alarm")];
        await pull(34, { "src/m.ts": "export const m = 1;\n", "src/n.ts": "export const n = 1;\n" });
        const run = await finished(
            env,
            ws,
            (await start({ kind: "pr", number: 34, models, options: { agreement: { markSingles: true } } })).id,
        );
        assert.equal(run.status, "done", run.error);
        assert.equal(run.result.agreement, undefined, "no rule about the check");
        const listed = await issues("pr-34");
        assert.equal(listed.markSingles, true);
        assert.equal(listed.total, 3);
        // The critical one model found is still first (severity leads); nothing is hidden.
        assert.deepEqual(
            listed.items.map((x: { severity: string; lowerConfidence: boolean; foundBy: string[] }) => [
                x.severity,
                x.lowerConfidence,
                x.foundBy.length,
            ]),
            [
                ["critical", true, 1],
                ["high", false, 2],
                ["high", false, 2],
            ],
        );
        assert.equal((await issues("pr-34", "&lowerConfidence=true")).total, 1);
        assert.equal((await issues("pr-34", "&lowerConfidence=false")).total, 2);
        assert.equal((await issues("pr-34", "&lower_confidence=true&foundBy=2")).total, 0);
        const md = await env.t.request(`/api/v1/w/${ws}/p/app/issues/${listed.items[0].id}/markdown?branch=pr-34`, { session: env.admin });
        assert.match(md.text, /\*\*Found by:\*\* fake\/wordy-alarm \(lower confidence: no other model found it\)/);

        // MCP: the same list and filter, and the claim order follows the list.
        const bearer = await token("full");
        const mcp = (name: string, args: object) => callMcp(bearer, name, args);
        const all = await mcp("list_issues", { project: "app", branch: "pr-34" });
        assert.match(all.content[0].text, /\(found by fake\/wordy-alarm: lower confidence\)/);
        assert.equal(all.structuredContent.markSingles, true);
        const singles = await mcp("list_issues", { project: "app", branch: "pr-34", lowerConfidence: true });
        assert.equal(singles.structuredContent.total, 1);
        const agreed = await mcp("list_issues", { project: "app", branch: "pr-34", lowerConfidence: false });
        assert.equal(agreed.structuredContent.total, 2);

        // Triage is untouched by the mark: a finding one model found is resolved like any other.
        const single = listed.items[0];
        const fixed = await env.t.request(`/api/v1/w/${ws}/p/app/issues/${single.id}?branch=pr-34`, {
            method: "PATCH",
            session: env.admin,
            body: { status: "resolved" },
        });
        assert.equal(fixed.status, 200, fixed.text);
        assert.equal((await issues("pr-34", "&status=resolved")).items[0].lowerConfidence, true);
    });

    test("a project's own options are what a review gets when it doesn't say, and one that says none gets none", async () => {
        const models = [await favourite("fake/model"), await favourite("fake/wordy-alarm")];
        const bad = await automation({ options: { agreement: { failAt: 9 } } });
        assert.equal(bad.status, 400, bad.text);
        const set = await automation({ models: { pr: models }, options: { agreement: { failAt: 4, markSingles: true } } });
        assert.equal(set.status, 200, set.text);
        assert.deepEqual(set.body.options, { agreement: { failAt: 4, markSingles: true } });
        const list = (await env.t.request(`/api/v1/w/${ws}/models?project=app`, { session: env.admin })).body;
        assert.deepEqual(list.options, { agreement: { failAt: 4, markSingles: true } });

        const head = await pull(35, { "src/p.ts": "export const p = 1;\n" });
        const run = await finished(env, ws, (await start({ kind: "pr", number: 35 })).id);
        // Four of two models can't agree: both must.
        assert.deepEqual(run.options.agreement, { failAt: 2, markSingles: true });
        assert.equal(lastStatus(head)?.state, "success");
        assert.equal((await issues("pr-35")).markSingles, true);

        // A review that says "no options" overrides the project's.
        const own = await pull(36, { "src/q.ts": "export const q = 1;\n" });
        const none = await finished(env, ws, (await start({ kind: "pr", number: 36, options: {} })).id);
        assert.equal(none.options, null);
        assert.equal(lastStatus(own)?.state, "failure");
        assert.equal((await issues("pr-36")).markSingles, false);

        // A review with one model has none of them, and its log says so.
        const single = await finished(env, ws, (await start({ kind: "full", branch: "main" })).id);
        assert.equal(single.options, null);
        assert.ok(
            single.logLines.some((l: { line: string }) => /one model, so the options for several models don't apply/.test(l.line)),
            "the log says the options didn't apply",
        );
        assert.equal((await automation({ models: {}, options: {} })).status, 200);
    });
});

describe("running a model that failed again", () => {
    let env: ReviewEnv;
    const ws = "again";
    const { request, favourite, start, issues, run, pull, lastStatus, comment, token, mcp } = kit(() => env, ws, "again/app");
    const rerun = (id: string, index: number, auth: object = {}) =>
        request(`/api/v1/w/${ws}/runs/${id}/models/${index}/rerun`, { method: "POST", session: env.admin, ...auth });
    const workspaceId = async () => (await env.t.services.store.workspaces.bySlug(ws))?.id as string;
    /** The jobs that ran a model of this review again. */
    const reruns = async (id: string) =>
        (await env.t.services.store.jobs.list({ workspaceId: await workspaceId() }, 500)).filter((j) => j.rerunOf?.jobId === id);

    before(async () => {
        env = await reviewEnv();
        await patProject(env, ws, { repo: "again/app" });
        await env.fake.gitRepo("again/app", { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });
        env.runner({ concurrency: 2 });
    });
    after(() => env.close());

    test("its findings join the review's report, and triage on what was there stays as it was", async () => {
        const models = [await favourite("fake/model"), await favourite("fake/wordy-extra-fail-once")];
        const first = await finished(env, ws, (await start({ kind: "full", branch: "main", models })).id);
        assert.equal(first.status, "partial", first.error);
        assert.deepEqual(
            first.result.models.map((m: { status: string }) => m.status),
            ["done", "failed"],
        );
        assert.equal(first.result.total, 2);
        assert.deepEqual(first.retries, []);
        assert.deepEqual(first.rerunnable, [{ index: 1, reason: null }]);

        // Triage before the model is run again: one finding resolved with a note, one claimed.
        const before = (await issues("main")).items as { id: string; rev: number; foundBy: string[] | null }[];
        assert.equal(before.length, 2);
        assert.equal(before[0]?.foundBy, null, "one model finished, so nothing says who found what yet");
        const patch = (id: string, body: object) =>
            request(`/api/v1/w/${ws}/p/app/issues/${id}?branch=main`, { method: "PATCH", session: env.admin, body });
        assert.equal((await patch(before[0]?.id as string, { status: "resolved", note: "Fixed in abc1234." })).status, 200);
        assert.equal((await patch(before[1]?.id as string, { status: "in_progress", assignee: "sam", severity: "low" })).status, 200);
        const triaged = (await issues("main", "&sort=index")).items;

        // Only someone who may start reviews may run it again.
        const reader = await token("full");
        assert.equal((await rerun(first.id, 1, { session: undefined, headers: { authorization: `Bearer ${reader}` } })).status, 403);
        assert.equal((await rerun(first.id, 0)).status, 409, "the first model finished");
        assert.equal((await rerun(first.id, 7)).status, 409);

        const queued = await rerun(first.id, 1);
        assert.equal(queued.status, 201, queued.text);
        assert.equal(queued.body.title, "fake/wordy-extra-fail-once again: Full scan of main");
        assert.deepEqual(queued.body.rerunOf, { id: first.id, index: 1, label: "fake/wordy-extra-fail-once", attempt: 2, auto: false });
        assert.equal(queued.body.headSha, first.headSha);
        const twice = await rerun(first.id, 1);
        assert.equal(twice.status, 409, twice.text);
        assert.match(twice.text, /already being run again/);

        const again = await finished(env, ws, queued.body.id);
        assert.equal(again.status, "done", again.error);
        assert.equal(again.headSha, first.headSha);
        assert.equal(again.result.total, 3, "its own findings");
        assert.equal(again.result.rerun.added, 1);
        assert.equal(again.result.rerun.agreed, 2);
        assert.equal(again.result.rerun.notAdded, null);
        assert.equal(again.result.rerun.branch.total, 3);
        assert.ok(
            again.logLines.some((l: { line: string }) =>
                /Reviewing [0-9a-f]{7}, the commit the review this belongs to was of\./.test(l.line),
            ),
        );

        // The report: the same findings in the same places with the same ids, now saying who found them, and one more.
        const after = (await issues("main", "&sort=index")).items;
        assert.equal(after.length, 3);
        assert.deepEqual(
            after.slice(0, 2).map((x: { foundBy: string[] }) => x.foundBy),
            [
                ["fake/model", "fake/wordy-extra-fail-once"],
                ["fake/model", "fake/wordy-extra-fail-once"],
            ],
        );
        assert.deepEqual(after[2].foundBy, ["fake/wordy-extra-fail-once"]);
        const kept = (x: Record<string, unknown>) => [
            x.id,
            x.status,
            x.assignee,
            x.severity,
            x.reviewerSeverity,
            x.noteCount,
            x.rev,
            x.title,
        ];
        assert.deepEqual(after.slice(0, 2).map(kept), triaged.map(kept), "triage is exactly as it was");
        assert.equal(after[2].status, "open");
        const detail = (await request(`/api/v1/w/${ws}/p/app/issues/${after[0].id}?branch=main`, { session: env.admin })).body;
        assert.equal(detail.notes[0].text, "Fixed in abc1234.");
        assert.equal(detail.status, "resolved", "nothing is reopened");
        assert.equal(detail.alsoFound[0].model, "fake/wordy-extra-fail-once");
        const overview = (await request(`/api/v1/w/${ws}/p/app/overview?branch=main`, { session: env.admin })).body;
        assert.deepEqual(overview.meta.models, ["fake/model", "fake/wordy-extra-fail-once"]);
        assert.deepEqual(
            overview.meta.warnings.filter((w: { type: string }) => w.type === "model_failed"),
            [],
            "it's no longer a model that didn't finish",
        );

        // The review's own page: a second attempt, with what it added; nothing left to run again.
        const review = await run(first.id);
        assert.equal(review.status, "partial", "how the review itself went is history");
        assert.equal(review.retries.length, 1);
        const { queuedAt: _q, finishedAt: _f, ...retry } = review.retries[0];
        assert.deepEqual(retry, {
            index: 1,
            label: "fake/wordy-extra-fail-once",
            id: again.id,
            attempt: 2,
            auto: false,
            status: "done",
            total: 3,
            added: 1,
            agreed: 2,
            notAdded: null,
            error: null,
        });
        assert.match(review.rerunnable[0].reason, /findings have been added already/);
        assert.equal((await rerun(first.id, 1)).status, 409);
        assert.equal((await rerun(again.id, 0)).status, 409, "a model run again has nothing of its own to run again");

        // Analytics: the attempt is under the review's scan, so it's still one review, with the tokens of both.
        const history = await env.t.services.history.list({ workspaceId: await workspaceId() });
        const scan = history.filter((h) => h.details.scan?.id === first.id);
        assert.deepEqual(scan.map((h) => [h.model, h.status, h.details.attempt ?? 1, h.tokens?.total ?? null]).sort(), [
            ["fake/model", "done", 1, 1500],
            ["fake/wordy-extra-fail-once", "done", 2, 1500],
            ["fake/wordy-extra-fail-once", "failed", 1, 40],
        ]);
        assert.equal(scan.find((h) => h.details.attempt === 2)?.details.addedIds?.low?.length, 1);
        const a = (await request(`/api/v1/w/${ws}/analytics?days=7`, { session: env.admin })).body;
        assert.equal(a.reviews.total, 1);
        assert.equal(a.reviews.tokens.total, 3040);
        assert.equal(a.findings.added, 3, "the finding it added counts as new on the branch");

        // An agent asks the same way.
        const agent = await token("manage");
        const refused = await mcp(agent, "rerun_model", { id: first.id, model: "fake/wordy-extra-fail-once" });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text, /findings have been added already/);
        assert.equal((await mcp(reader, "rerun_model", { id: first.id, model: "fake/model" })).isError, true);
    });

    test("a pull request's check and comment follow the report once the model's findings are in", async () => {
        const models = [await favourite("fake/model"), await favourite("fake/wordy-alarm-fail-once")];
        const head = await pull(41, { "src/c.ts": "export const c = 3;\n" });
        const first = await finished(env, ws, (await start({ kind: "pr", number: 41, models })).id);
        assert.equal(first.status, "partial", first.error);
        assert.equal(lastStatus(head)?.description, "1 high (partial review)");
        assert.match(comment(41), /Partial review/);
        const statuses = env.fake.repo("again/app").statuses.filter((s) => s.sha === head).length;

        // The pull request moves on meanwhile: the model is still run on the commit the review was of.
        const moved = await env.fake.commit("again/app", "pr-41", { "src/d.ts": "export const d = 4;\n" }, "More");
        const queued = await rerun(first.id, 1);
        assert.equal(queued.status, 201, queued.text);
        const again = await finished(env, ws, queued.body.id);
        assert.equal(again.status, "done", again.error);
        assert.equal(again.headSha, head);
        assert.notEqual(again.headSha, moved);
        assert.equal(again.result.rerun.notAdded, null);
        assert.equal(again.result.total, 2);
        assert.ok(again.logLines.some((l: { line: string }) => /it's at [0-9a-f]{7} now/.test(l.line)));
        // Nothing while it was queued or running; one status once its findings were in, on the reviewed commit.
        const now = env.fake.repo("again/app").statuses.filter((s) => s.sha === head);
        assert.equal(now.length, statuses + 1);
        assert.deepEqual([lastStatus(head)?.state, lastStatus(head)?.description], ["failure", "1 critical: 1 critical, 1 high"]);
        assert.equal(lastStatus(moved), undefined);
        assert.match(comment(41), /2 findings in this pull request/);
        assert.match(comment(41), /Reviewed by 2 models/);
        assert.doesNotMatch(comment(41), /Partial review/);
    });

    test("refused when a newer report has replaced the review's, and not added if one arrives while it runs", async () => {
        const models = [await favourite("fake/model"), await favourite("fake/sleep-2-extra-fail-once")];
        await pull(42, { "src/e.ts": "export const e = 5;\n" });
        const first = await finished(env, ws, (await start({ kind: "pr", number: 42, models })).id);
        assert.equal(first.status, "partial", first.error);
        const queued = await rerun(first.id, 1);
        assert.equal(queued.status, 201, queued.text);
        // While it runs, someone uploads a report of their own to the branch.
        await eventually(async () => (await run(queued.body.id)).status === "running", "the model to be running again");
        const report = { comments: [{ path: "src/e.ts", content: "Uploaded by hand meanwhile.", severity: "low", category: "style" }] };
        const uploaded = await request(`/api/v1/w/${ws}/p/app/reports`, {
            method: "POST",
            session: env.admin,
            body: { branch: "pr-42", fileName: "mine.json", report, confirm: true },
        });
        assert.equal(uploaded.status, 200, uploaded.text);
        const again = await finished(env, ws, queued.body.id);
        assert.equal(again.status, "done", again.error);
        assert.equal(again.result.rerun.added, null);
        assert.match(
            again.result.rerun.notAdded,
            /A newer report has replaced the review's on pr-42, so these findings weren't added to it\. Start a new review/,
        );
        assert.equal(again.result.rerun.branch, undefined);
        const listed = await issues("pr-42");
        assert.deepEqual(
            listed.items.map((x: { title: string }) => x.title),
            ["Uploaded by hand meanwhile"],
            "the newer report is untouched",
        );
        const review = await run(first.id);
        assert.match(review.retries[0].notAdded, /newer report/);
        // And asking again is refused outright, saying why.
        assert.match(review.rerunnable[0].reason, /A newer report has replaced this review's on pr-42/);
        const refused = await rerun(first.id, 1);
        assert.equal(refused.status, 409, refused.text);
        assert.match(
            refused.text,
            /A newer report has replaced this review's on pr-42, so fake\/sleep-2-extra-fail-once's findings can't be added to it\. Start a new review instead\./,
        );
    });

    test("retryFailed: a model that failed is run again once without being asked, and never a second time", async () => {
        const flaky = [await favourite("fake/model"), await favourite("fake/extra-fail-once-auto")];
        // Off unless chosen: nothing is run again by itself.
        await pull(43, { "src/f.ts": "export const f = 6;\n" });
        const plain = await finished(
            env,
            ws,
            (await start({ kind: "pr", number: 43, models: [flaky[0], await favourite("fake/fail")] })).id,
        );
        assert.equal(plain.status, "partial", plain.error);
        assert.deepEqual(plain.retries, []);
        assert.deepEqual(await reruns(plain.id), []);

        // On: the second model fails, is run again, and this time finishes; its findings are added.
        await pull(44, { "src/g.ts": "export const g = 7;\n" });
        const first = await finished(env, ws, (await start({ kind: "pr", number: 44, models: flaky, options: { retryFailed: true } })).id);
        assert.equal(first.status, "partial", first.error);
        assert.equal(first.options.retryFailed, true);
        const retried = await eventually(async () => {
            const r = await run(first.id);
            return r.retries.length === 1 && r.retries[0].status === "done" ? r : null;
        }, "the model to be run again by itself");
        assert.deepEqual(
            [retried.retries[0].auto, retried.retries[0].attempt, retried.retries[0].added, retried.retries[0].agreed],
            [true, 2, 1, 1],
        );
        const auto = await run(retried.retries[0].id);
        assert.equal(auto.requestedBy.name, first.requestedBy.name);
        assert.equal(auto.options, null, "a model run again has no options of its own");
        assert.equal((await issues("pr-44")).total, 2);

        // A model that fails again is not run a third time by itself; someone can still ask.
        await pull(45, { "src/h.ts": "export const h = 8;\n" });
        const stubborn = [flaky[0], await favourite("fake/fail"), await favourite("fake/fail-b")] as string[];
        const failing = await finished(
            env,
            ws,
            (await start({ kind: "pr", number: 45, models: stubborn, options: { retryFailed: true } })).id,
        );
        assert.equal(failing.status, "partial", failing.error);
        const settled = await eventually(async () => {
            const r = await run(failing.id);
            return r.retries.length === 2 && r.retries.every((x: { status: string }) => x.status === "failed") ? r : null;
        }, "both failed models to have been run again");
        await env.t.services.runs.settled();
        await new Promise((r) => setTimeout(r, 500));
        assert.equal((await reruns(failing.id)).length, 2, "once each, and no more");
        assert.deepEqual(
            settled.retries.map((x: { index: number; auto: boolean; attempt: number }) => [x.index, x.auto, x.attempt]),
            [
                [1, true, 2],
                [2, true, 2],
            ],
        );
        assert.deepEqual(
            (await run(failing.id)).rerunnable.map((x: { reason: string | null }) => x.reason),
            [null, null],
        );
        const asked = await rerun(failing.id, 1);
        assert.equal(asked.status, 201, asked.text);
        assert.equal(asked.body.rerunOf.attempt, 3);
        await finished(env, ws, asked.body.id);
        assert.equal((await reruns(failing.id)).length, 3);
    });
});

describe("a model run again, as the runner is told and answers", () => {
    let env: ReviewEnv;
    const ws = "pinned";
    const { request, favourite, start, issues, run } = kit(() => env, ws, "pinned/app");
    const runner = { id: "runner-pinned-0000", name: "pinned", version: "1", slots: 1 };
    const report = (content: string, line = 1) => ({
        comments: [{ path: "src/a.ts", content, severity: "high", category: "bug", start_line: line, end_line: line }],
    });
    const X = "a".repeat(40);
    const Y = "b".repeat(40);

    before(async () => {
        env = await reviewEnv();
        await patProject(env, ws, { repo: "pinned/app" });
        await env.fake.gitRepo("pinned/app", { "src/a.ts": "export const a = 1;\n" });
    });
    after(() => env.close());

    test("the job names the commit to review; findings from another commit aren't added, and it can be asked again", async () => {
        const runs = env.t.services.runs;
        const models = [await favourite("fake/a"), await favourite("fake/b")];
        const started = await start({ kind: "full", branch: "main", models });
        const job = await runs.claim(runner);
        assert.equal(job?.id, started.id);
        assert.equal(job?.commit, undefined, "an ordinary review reviews what it fetches");
        await runs.finish(runner, started.id, {
            status: "done",
            headSha: X,
            parts: [
                { status: "done", report: report("A found it"), tokens: 100, seconds: 1 },
                { status: "failed", error: "It fell over.", tokens: 5, seconds: 1 },
            ],
        });
        assert.equal((await run(started.id)).status, "partial");

        const rerun = () => request(`/api/v1/w/${ws}/runs/${started.id}/models/1/rerun`, { method: "POST", session: env.admin });
        const second = await rerun();
        assert.equal(second.status, 201, second.text);
        const claimed = await runs.claim(runner);
        assert.equal(claimed?.id, second.body.id);
        // One model, as any review with one, and the commit the review was of.
        assert.deepEqual(claimed?.commit, { head: X, base: null });
        assert.deepEqual(
            claimed?.models.map((m) => m.label),
            ["fake/b"],
        );
        assert.equal(claimed?.kind, "full");
        // A runner that doesn't know about `commit` reviews wherever the branch is now.
        await runs.finish(runner, second.body.id, { status: "done", headSha: Y, report: report("B, of another commit", 2) });
        const other = await run(second.body.id);
        assert.equal(other.status, "done");
        assert.match(
            other.result.rerun.notAdded,
            /It reviewed bbbbbbb, not aaaaaaa, the commit the review was of, so its findings weren't added/,
        );
        assert.equal((await issues("main")).total, 1);

        const third = await rerun();
        assert.equal(third.status, 201, third.text);
        assert.equal(third.body.rerunOf.attempt, 3);
        assert.equal((await runs.claim(runner))?.id, third.body.id);
        await runs.finish(runner, third.body.id, { status: "done", headSha: X, report: report("B found it too", 2) });
        assert.equal((await run(third.body.id)).result.rerun.agreed, 1);
        const listed = await issues("main");
        assert.equal(listed.total, 1);
        assert.deepEqual(listed.items[0].foundBy, ["fake/a", "fake/b"]);
        assert.deepEqual(
            (await run(started.id)).retries.map((r: { attempt: number; notAdded: string | null }) => [r.attempt, r.notAdded === null]),
            [
                [2, false],
                [3, true],
            ],
        );
    });
});
