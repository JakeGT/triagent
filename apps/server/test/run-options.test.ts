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
import { finished, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

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

describe("a review's options", () => {
    let env: ReviewEnv;
    const ws = "options";

    /** The id of the favourite that is this model, added to the workspace's favourites first if it isn't one. */
    const favourite = async (model: string, provider = "openrouter"): Promise<string> => {
        const url = `/api/v1/w/${ws}/settings/models/favourites`;
        type Fav = { id: string; provider: string; model: string };
        const is = (f: Fav) => f.provider === provider && f.model === model;
        const have = (await env.t.request(url, { session: env.admin })).body.favourites.find(is);
        if (have) return have.id;
        const added = await env.t.request(url, { method: "POST", session: env.admin, body: { provider, model } });
        assert.equal(added.status, 201, added.text);
        return added.body.favourites.find(is).id;
    };
    const post = (body: object) => env.t.request(`/api/v1/w/${ws}/p/app/reviews`, { method: "POST", session: env.admin, body });
    const start = async (body: object) => {
        const r = await post(body);
        assert.equal(r.status, 201, r.text);
        return r.body;
    };
    const automation = (body: object) =>
        env.t.request(`/api/v1/w/${ws}/p/app/settings/automation`, { method: "PATCH", session: env.admin, body });
    const issues = async (branch: string, query = "") =>
        (await env.t.request(`/api/v1/w/${ws}/p/app/issues?branch=${branch}${query}`, { session: env.admin })).body;
    /** A pull request that adds `files`, from a branch of its own. */
    const pull = async (number: number, files: Record<string, string>) => {
        const head = await env.fake.commit("options/app", `pr-${number}`, files, `Change ${number}`, "main");
        await env.fake.openPull("options/app", { number, headRef: `pr-${number}`, title: `Change ${number}` });
        return head;
    };
    const lastStatus = (sha: string) =>
        env.fake
            .repo("options/app")
            .statuses.filter((s) => s.sha === sha)
            .at(-1);
    const comment = (number: number) => env.fake.repo("options/app").comments.get(number)?.at(-1)?.body ?? "";

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
        const token = (
            await env.t.request(`/api/v1/w/${ws}/settings/tokens`, {
                method: "POST",
                session: env.admin,
                body: { name: "agent", scope: "full" },
            })
        ).body.token as string;
        const mcp = async (name: string, args: object) => {
            const r = await env.t.request("/mcp", {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
                body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
            });
            assert.equal(r.status, 200, r.text);
            return r.body.result;
        };
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
