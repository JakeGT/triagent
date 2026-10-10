// Options for reviews run with several models (packages/shared/src/run-options.ts): each is off unless
// chosen for a run or by its project, and a review with one model has none.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { NO_OPTIONS, type RunOptions } from "@triagent/shared";
import { candidatePairs, groupFindings, joinGroups } from "@triagent/shared/merge";
import { FakeProvider } from "../../../tests/fakes/model-provider.ts";
import { mergeReports } from "../src/domain/merge.ts";
import { parseReport, priorityCompare } from "../src/domain/report.ts";
import { commentBody, finishedStatus } from "../src/domain/review-run.ts";
import { agreedCritical, effectiveOptions, readJudged } from "../src/services/runs.ts";
import type { Job } from "../src/store/types.ts";
import { eventually, finished, MODEL_KEY, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

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

    test("a file with thousands of findings: the same closest pairs as comparing every one, without holding them all", () => {
        // What the pairs are, written the plain way: every pair, sorted, then cut.
        const plain = (parts: ReturnType<typeof f>[][], max: number) => {
            const groups = groupFindings(parts).map((g) => ({
                lead: g[0] as { part: number; index: number },
                models: g.map((r) => r.part),
            }));
            const at = (r: { part: number; index: number }) => parts[r.part]?.[r.index] as ReturnType<typeof f>;
            const all: { pair: object; gap: number }[] = [];
            // A file at a time, in the order the files come up.
            const paths = [...new Set(groups.map((g) => at(g.lead).path))];
            for (const path of paths)
                for (const [i, x] of groups.entries())
                    for (const y of groups.slice(i + 1)) {
                        const [a, b] = [at(x.lead), at(y.lead)];
                        if (a.path !== path || b.path !== path || x.models.some((m) => y.models.includes(m))) continue;
                        const [s, t] = [a.start_line ?? null, b.start_line ?? null];
                        const gap = s === null || t === null ? Number.MAX_SAFE_INTEGER : Math.abs(s - t);
                        all.push({ pair: { a: x.lead, b: y.lead }, gap });
                    }
            all.sort((p, q) => p.gap - q.gap);
            return { pairs: all.slice(0, max).map((p) => p.pair), total: all.length };
        };
        // Three models' findings scattered over two files, some without lines, many as close as each other.
        let seed = 7;
        const random = (n: number) => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % n;
        };
        const categories = ["bug", "style", "security", "performance"];
        const scattered = [0, 1, 2].map(() =>
            Array.from({ length: 120 }, () =>
                f(random(4) ? "big.ts" : "small.ts", random(12) ? 1 + random(400) : null, categories[random(4)]),
            ),
        );
        for (const max of [0, 1, 7, 200, 100_000]) assert.deepEqual(candidatePairs(scattered, max), plain(scattered, max), `max ${max}`);
        // Thousands in one file, every one of a model's on a line of its own: 4,000 each, 16 million pairs.
        const many = (step: number, category: string) => Array.from({ length: 4000 }, (_, i) => f("huge.ts", 1 + i * 10 + step, category));
        const t0 = Date.now();
        const huge = candidatePairs([many(0, "bug"), many(5, "style")]);
        assert.equal(huge.total, 16_000_000);
        assert.equal(huge.pairs.length, 200);
        assert.deepEqual(huge.pairs[0], { a: { part: 0, index: 0 }, b: { part: 1, index: 0 } });
        // And all on the same lines: nothing is closer than that, so it stops at the first 200.
        const piled = candidatePairs([
            many(0, "bug").map((c) => ({ ...c, start_line: 3, end_line: 3 })),
            many(0, "style").map((c) => ({ ...c, start_line: 3, end_line: 3 })),
        ]);
        assert.equal(piled.total, 16_000_000);
        assert.deepEqual(piled.pairs.at(-1), { a: { part: 0, index: 0 }, b: { part: 1, index: 199 } });
        assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0}ms`);
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
        // The model as the run lists it, give or take the space around it; one it hasn't got is answered with those it has.
        assert.match(
            (await mcp(agent, "rerun_model", { id: first.id, model: " fake/wordy-extra-fail-once\n" })).content[0].text,
            /added already/,
        );
        assert.match(
            (await mcp(agent, "rerun_model", { id: first.id, model: "fake/other" })).content[0].text,
            /no model called "fake\/other"\. Its models are: "fake\/model", "fake\/wordy-extra-fail-once"\./,
        );
        // A run that lists no models says why it has none to run again, not that the name is wrong.
        assert.match(
            (await mcp(agent, "rerun_model", { id: again.id, model: "fake/model" })).content[0].text,
            /is itself one model being run again/,
        );
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

describe("a model asked which findings are the same problem", () => {
    let env: ReviewEnv;
    let provider: FakeProvider;
    const ws = "judged";
    const { request, favourite, post, start, issues } = kit(() => env, ws, "judged/app");
    const judgeKey = `sk-judge-${"j".repeat(24)}`;
    const SECRET_CODE = "export const a = 'DO-NOT-SEND-THIS-CODE';\n";
    const workspaceId = async () => (await env.t.services.store.workspaces.bySlug(ws))?.id as string;
    /** The favourite that is the stand-in provider's model, set up on first use. */
    let judgeId = "";
    const judge = async () => {
        if (judgeId) return judgeId;
        const settings = `/api/v1/w/${ws}/settings/review-model`;
        const set = await request(`${settings}/providers/custom`, {
            method: "PATCH",
            session: env.admin,
            body: { url: `${provider.url}/v1`, protocol: "openai" },
        });
        assert.equal(set.status, 200, set.text);
        assert.equal(
            (await request(`${settings}/keys/custom`, { method: "PUT", session: env.admin, body: { key: judgeKey } })).status,
            200,
        );
        judgeId = await favourite("judge-model", "custom");
        return judgeId;
    };
    /** Two models whose findings nothing about their place makes one: the second's are far lower, and about something else. */
    const apart = async () => [await favourite("fake/model"), await favourite("fake/apart-quote")];

    before(async () => {
        provider = await new FakeProvider().start();
        env = await reviewEnv({ env: { ALLOW_PRIVATE_MODEL_URLS: "true" } });
        await patProject(env, ws, { repo: "judged/app" });
        await env.fake.gitRepo("judged/app", { "src/a.ts": SECRET_CODE, "src/b.ts": "export const b = 2;\n" });
        env.runner();
    });
    after(async () => {
        await env.close();
        await provider.stop();
    });

    test("who can be asked: a favourite, not a model on Amazon Bedrock, nor the instance's", async () => {
        const models = await apart();
        const ask = (judge: unknown, m = models) => post({ kind: "full", branch: "main", models: m, options: { judge } });
        const unknown = await ask("nope");
        assert.equal(unknown.status, 400, unknown.text);
        assert.match(unknown.text, /isn't one of this workspace's favourite models, so it can't be asked/);
        const bedrock = await favourite("anthropic.claude-test", "bedrock");
        const refused = await ask(bedrock);
        assert.equal(refused.status, 400, refused.text);
        assert.match(
            refused.text,
            /anthropic\.claude-test is on Amazon Bedrock, and a model there can't be asked which findings are the same problem yet\. Choose another/,
        );
        assert.match((await ask("instance")).text, /The instance's model can't be the one asked/);
        // "The first that can" needs one that can; and one model has nobody to compare with.
        const none = await ask(true, [bedrock, await favourite("anthropic.claude-other", "bedrock")]);
        assert.equal(none.status, 400, none.text);
        assert.match(none.text, /None of this review's models can be asked/);
        assert.match((await ask(true, [models[0] as string])).text, /two or more models/);
        // A project's own choice is checked the same way; the list of favourites says which can be asked.
        const project = await request(`/api/v1/w/${ws}/p/app/settings/automation`, {
            method: "PATCH",
            session: env.admin,
            body: { options: { judge: bedrock } },
        });
        assert.equal(project.status, 400, project.text);
        const listed = (await request(`/api/v1/w/${ws}/models`, { session: env.admin })).body.favourites;
        assert.deepEqual(
            listed.map((f: { model: string; canJudge: boolean }) => [f.model, f.canJudge]).filter((x: [string, boolean]) => !x[1]),
            [
                ["anthropic.claude-test", false],
                ["anthropic.claude-other", false],
            ],
        );
    });

    test("off unless chosen: findings are merged by where they are, and no model is asked", async () => {
        const plain = await finished(env, ws, (await start({ kind: "full", branch: "main", models: await apart() })).id);
        assert.equal(plain.status, "done", plain.error);
        assert.equal(plain.result.total, 4, "two files, two findings each: nothing about where they are makes them one");
        assert.equal(plain.result.judge, undefined);
        assert.equal(plain.model.judge, undefined);
        assert.equal(provider.requests.length, 0);
    });

    test("on: the pairs it says are the same are merged like any agreement, and its tokens are counted as merging", async () => {
        // The same problem in a.ts, it says; not in b.ts.
        provider.same = (p) => p.a.file === "src/a.ts";
        const id = await judge();
        const started = await start({ kind: "full", branch: "main", models: await apart(), options: { judge: id } });
        assert.equal(started.options.judge, id);
        const done = await finished(env, ws, started.id);
        assert.equal(done.status, "done", done.error);
        assert.deepEqual(done.model.judge, { id, provider: "custom", model: "judge-model", label: "judge-model" });
        assert.deepEqual(done.result.judge, {
            label: "judge-model",
            provider: "custom",
            model: "judge-model",
            candidates: 2,
            asked: 2,
            same: 1,
            merged: 1,
            tokens: { input: 300, output: 20, cacheRead: 0, total: 320 },
            seconds: done.result.judge.seconds,
            error: null,
        });
        assert.equal(done.result.total, 3);
        assert.equal(done.result.tokens.total, 1500 + 1500 + 320);
        const log = done.logLines.map((l: { line: string }) => l.line);
        assert.ok(log.includes("[triagent] Asking judge-model which findings from different models are the same problem…"));
        assert.ok(log.includes("[triagent] judge-model compared 2 pairs: 1 the same problem."));
        assert.ok(!log.some((l: string) => l.includes(judgeKey)));

        // Triage: one finding for a.ts, found by both, with what the other said; b.ts has two.
        const listed = await issues("main", "&sort=agreement");
        assert.equal(listed.total, 3);
        assert.deepEqual(listed.items[0].foundBy, ["fake/model", "fake/apart-quote"]);
        assert.equal(listed.items[0].path, "src/a.ts");
        const detail = (await request(`/api/v1/w/${ws}/p/app/issues/${listed.items[0].id}?branch=main`, { session: env.admin })).body;
        assert.match(detail.content, /^A problem found in src\/a\.ts/, "the first model's wording leads");
        assert.deepEqual(
            [detail.alsoFound[0].model, detail.alsoFound[0].category, detail.alsoFound[0].startLine],
            ["fake/apart-quote", "performance", 201],
        );
        assert.deepEqual(
            listed.items.slice(1).map((x: { path: string; foundBy: string[] }) => [x.path, x.foundBy.length]),
            [
                ["src/b.ts", 1],
                ["src/b.ts", 1],
            ],
        );

        // The model was sent the findings' words and where they are, with the key for its own provider: never the code.
        assert.equal(provider.requests.length, 1);
        const sent = provider.requests[0];
        assert.equal(sent?.path, "/v1/chat/completions");
        assert.equal(sent?.headers.authorization, `Bearer ${judgeKey}`);
        assert.doesNotMatch(sent?.raw ?? "", /DO-NOT-SEND-THIS-CODE|FAKE-SUGGESTED-CODE|existing_code|suggestion_code/);
        assert.match(sent?.raw ?? "", /Seen from further off, src\/a\.ts has the same trouble\./);
        // The second model's findings do quote the code, so it was there to leave out.
        const theirs = listed.items.find((x: { foundBy: string[] }) => x.foundBy[0] === "fake/apart-quote");
        const quoted = (await request(`/api/v1/w/${ws}/p/app/issues/${theirs.id}?branch=main`, { session: env.admin })).body;
        assert.equal(quoted.existingCode, "export const b = 2;\n");

        // Analytics: the tokens are the review's, under "merging", and it's still one review.
        const history = await env.t.services.history.list({ workspaceId: await workspaceId() });
        const merging = history.filter((h) => h.details.scan?.id === done.id && h.details.merging);
        assert.deepEqual(
            merging.map((h) => [h.model, h.provider, h.status, h.tokens?.total, h.keySource, h.details.scan?.lead]),
            [["judge-model", "custom", "done", 320, "workspace", false]],
        );
        const a = (await request(`/api/v1/w/${ws}/analytics?days=7`, { session: env.admin })).body;
        assert.equal(a.reviews.total, 2, "this review and the one before, each once");
        const byModel = Object.fromEntries(
            a.reviews.byModel.map((g: { key: string; tokens: number; reviews: number }) => [g.key, [g.reviews, g.tokens]]),
        );
        assert.deepEqual(byModel["merging (judge-model)"], [1, 320]);
        assert.equal(byModel["judge-model"], undefined);
        assert.equal(a.reviews.latest[0].tokens, 3320);
        assert.ok(!a.performance.byModel.some((g: { key: string }) => /judge-model/.test(g.key)));
    });

    test("it fails, or answers nonsense: the review keeps the plain merge and says so", async () => {
        const id = await judge();
        for (const [mode, why] of [
            ["error", "its provider answered 500"],
            ["nonsense", "its answer wasn't true or false for each pair"],
        ] as const) {
            provider.requests.length = 0;
            provider.mode = mode;
            const done = await finished(
                env,
                ws,
                (await start({ kind: "full", branch: "main", models: await apart(), options: { judge: id } })).id,
            );
            assert.equal(done.status, "done", done.error);
            assert.equal(done.result.total, 4, "merged by where they are, as without the option");
            assert.equal(done.result.judge.error, `The model couldn't be asked (${why}), so findings were merged by where they are only.`);
            assert.deepEqual([done.result.judge.asked, done.result.judge.same, done.result.judge.merged], [0, 0, 0]);
            assert.ok(
                done.logLines.some(
                    (l: { line: string }) =>
                        l.line === `[triagent] judge-model couldn't be asked (${why}), so findings are merged by where they are only.`,
                ),
            );
            assert.equal(provider.requests.length, 1);
        }
        provider.mode = "answer";
    });
});

describe("what a runner says a model answered, as the server takes it", () => {
    let env: ReviewEnv;
    const ws = "verdicts";
    const { request, favourite, start, run } = kit(() => env, ws, "verdicts/app");
    const runner = { id: "runner-verdicts-00", name: "verdicts", version: "1", slots: 1 };
    const f = (path: string, line: number, content: string, category = "bug") => ({
        path,
        content,
        severity: "high",
        category,
        start_line: line,
        end_line: line,
    });
    // a.ts: A at 10, B at 100 (apart); b.ts: A at 10, B at 11 (one finding already); c.ts: only A.
    const reports = [
        { label: "a", report: { comments: [f("a.ts", 10, "A in a"), f("b.ts", 10, "A in b"), f("c.ts", 5, "A in c")] } },
        {
            label: "b",
            report: { comments: [f("a.ts", 100, "B in a", "style"), f("b.ts", 11, "B in b"), f("a.ts", 300, "B again in a", "style")] },
        },
    ];
    const ref = (part: number, index: number) => ({ part, index });
    const pair = (a: [number, number], b: [number, number], same = true) => ({ a: ref(...a), b: ref(...b), same });

    before(async () => {
        env = await reviewEnv();
        await patProject(env, ws, { repo: "verdicts/app" });
        await env.fake.gitRepo("verdicts/app", { "a.ts": "a\n" });
    });
    after(() => env.close());

    test("answers are used only if every one is about a pair that was to be asked about", () => {
        const good = readJudged(
            { pairs: [pair([0, 0], [1, 0]), pair([0, 0], [1, 2], false)], tokens: { input: 90, output: 10 }, seconds: 3 },
            reports,
        );
        assert.deepEqual(good, {
            same: [pair([0, 0], [1, 0])],
            asked: 2,
            candidates: 2,
            tokens: { input: 90, output: 10, cacheRead: 0, total: 100 },
            seconds: 3,
            error: null,
        });
        const refused = (given: unknown) => {
            const read = readJudged(given, reports);
            assert.deepEqual([read.same, read.asked], [[], 0]);
            return read.error ?? "";
        };
        assert.match(refused(undefined), /The runner didn't ask \(it may be too old to\)/);
        assert.match(refused("yes"), /couldn't be read/);
        assert.match(refused({ pairs: "all" }), /aren't a list of pairs/);
        assert.match(refused({ pairs: [{ a: ref(0, 0), b: ref(1, 0), same: "true" }] }), /true or false answer/);
        assert.match(refused({ pairs: [{ a: ref(0, 0), same: true }] }), /doesn't name two findings/);
        assert.match(refused({ pairs: [pair([0, -1], [1, 0])] }), /doesn't name two findings/);
        assert.match(refused({ pairs: [pair([0, 0.5], [1, 0])] }), /doesn't name two findings/);
        // Out of range: a finding, or a model, that isn't there.
        assert.match(refused({ pairs: [pair([0, 9], [1, 0])] }), /a finding that isn't in the reviews/);
        assert.match(refused({ pairs: [pair([0, 0], [5, 0])] }), /a finding that isn't in the reviews/);
        assert.match(refused({ pairs: [pair([1, 0], [1, 2])] }), /two findings of the same model/);
        assert.match(refused({ pairs: [pair([0, 2], [1, 0])] }), /findings in different files/);
        // Real findings in one file from two models, but already one finding: not a pair to ask about.
        assert.match(refused({ pairs: [pair([0, 1], [1, 1])] }), /isn't a pair that was to be asked about/);
        assert.match(refused({ pairs: [pair([1, 0], [0, 0])] }), /isn't a pair that was to be asked about/);
        assert.match(refused({ pairs: [pair([0, 0], [1, 0]), pair([0, 0], [1, 0], false)] }), /one pair is there twice/);
        // One bad pair loses the good ones too.
        assert.match(refused({ pairs: [pair([0, 0], [1, 0]), pair([0, 2], [1, 0])] }), /different files/);
        assert.match(refused({ pairs: Array.from({ length: 201 }, () => pair([0, 0], [1, 0])) }), /more than 200 of them/);
        // What the runner says went wrong is passed on, cleaned, with what it used.
        const failed = readJudged(
            { pairs: [], tokens: { input: 5, output: 0 }, error: "its provider answered 500 for sk-secret" },
            reports,
            (t) => t.replace("sk-secret", "[redacted]"),
        );
        assert.equal(
            failed.error,
            "The model couldn't be asked (its provider answered 500 for [redacted]), so findings were merged by where they are only.",
        );
        assert.equal(failed.tokens?.total, 5);
    });

    test("200 pairs is the most a review has asked, and the most it takes", () => {
        const many = (label: string, category: string) => ({
            label,
            report: {
                comments: Array.from({ length: 20 }, (_, i) =>
                    f("big.ts", 10 + i * 100 + (category === "bug" ? 0 : 40), `${label} ${i}`, category),
                ),
            },
        });
        const parts = [many("a", "bug"), many("b", "style")];
        const { pairs, total } = candidatePairs(parts.map((p) => p.report.comments));
        assert.equal(total, 400);
        assert.equal(pairs.length, 200);
        const all = readJudged({ pairs: pairs.map((p) => ({ ...p, same: false })) }, parts);
        assert.deepEqual([all.asked, all.candidates, all.error], [200, 400, null]);
        // The 201st closest pair is a real pair, but not one that was to be asked about.
        const next = candidatePairs(
            parts.map((p) => p.report.comments),
            201,
        ).pairs[200];
        assert.match(readJudged({ pairs: [{ ...next, same: true }] }, parts).error ?? "", /isn't a pair that was to be asked about/);
    });

    test("through the runner's API: the job carries the model's credentials, and bad answers never lose the review", async () => {
        const runs = env.t.services.runs;
        const models = [await favourite("fake/a"), await favourite("fake/b")];
        const post = (id: string, what: string, body: object) =>
            fetch(`${env.url}/internal/runner/jobs/${id}/${what}`, {
                method: "POST",
                headers: { authorization: `Bearer ${env.secret}`, "content-type": "application/json" },
                body: JSON.stringify({ runner, ...body }),
            });
        const parts = reports.map((r) => ({ status: "done", report: r.report, tokens: 100, seconds: 1 }));
        const finish = async (judged: unknown, options: object = { judge: true }) => {
            const started = await start({ kind: "full", branch: "main", models, options });
            const job = await runs.claim(runner);
            assert.equal(job?.id, started.id);
            const res = await post(started.id, "finish", { status: "done", parts, ...(judged === undefined ? {} : { judged }) });
            assert.equal(res.status, 200, await res.clone().text());
            return { job, run: await run(started.id) };
        };

        // "The first that can": the review's first model, with the key the review itself uses for it.
        const first = await finish({
            pairs: [pair([0, 0], [1, 0]), pair([0, 0], [1, 2], false)],
            total: 2,
            tokens: { input: 90, output: 10 },
            seconds: 2,
        });
        assert.deepEqual(first.job?.judge, { ...first.job?.models[0], label: "fake/a" });
        assert.equal(first.job?.judge?.apiKey, MODEL_KEY);
        assert.equal(first.run.options.judge, "first");
        assert.equal(first.run.model.judge.label, "fake/a");
        assert.deepEqual(
            [
                first.run.result.total,
                first.run.result.judge.asked,
                first.run.result.judge.same,
                first.run.result.judge.merged,
                first.run.result.judge.error,
            ],
            [4, 2, 1, 1, null],
        );
        assert.equal(first.run.result.tokens.total, 300);
        // Its key is taken out of whatever the runner logs, like the models' own.
        assert.equal(JSON.stringify(first.run).includes(MODEL_KEY), false);

        // Answers that can't be used, and a runner too old to ask: the review is saved, merged by place only, saying why.
        for (const [judged, why] of [
            [{ pairs: [pair([0, 2], [1, 0])] }, /The runner's answers weren't used \(one pairs findings in different files\)/],
            [{ pairs: [pair([0, 0], [9, 9])] }, /a finding that isn't in the reviews/],
            ["drop table", /couldn't be read/],
            [undefined, /The runner didn't ask \(it may be too old to\).*Update the runner\./],
        ] as const) {
            const bad = await finish(judged);
            assert.equal(bad.run.status, "done", bad.run.error);
            assert.equal(bad.run.result.total, 5, "as without the option");
            assert.match(bad.run.result.judge.error, why);
            assert.equal(bad.run.result.judge.merged, 0);
        }

        // Without the option the job names no model to ask, and answers a runner sends anyway are ignored.
        const off = await finish({ pairs: [pair([0, 0], [1, 0])] }, {});
        assert.equal(off.job?.judge, undefined);
        assert.equal(off.run.result.judge, undefined);
        assert.equal(off.run.result.total, 5);
    });

    test("a favourite removed since, or without its key: nobody is asked, and the review says why", async () => {
        const runs = env.t.services.runs;
        const models = [await favourite("fake/a"), await favourite("fake/b")];
        const other = await favourite("fake/other");
        const started = await start({ kind: "full", branch: "main", models, options: { judge: other } });
        const gone = await request(`/api/v1/w/${ws}/settings/models/favourites/${other}`, { method: "DELETE", session: env.admin });
        assert.equal(gone.status, 200, gone.text);
        const job = await runs.claim(runner);
        assert.equal(job?.id, started.id);
        assert.equal(job?.judge, undefined);
        await runs.finish(runner, started.id, { status: "done", parts: reports.map((r) => ({ status: "done", report: r.report })) });
        const done = await run(started.id);
        assert.equal(done.status, "done");
        assert.equal(done.result.total, 5);
        assert.equal(
            done.result.judge.error,
            "No model was asked: the favourite model chosen to be asked has been removed. Findings were merged by where they are only.",
        );
        assert.ok(done.logLines.some((l: { line: string }) => /No model will be asked which findings are the same problem/.test(l.line)));
    });
});

describe("comparing models only", () => {
    let env: ReviewEnv;
    const ws = "bakeoff";
    const { request, favourite, post, start, issues, run, pull, comment, token, mcp } = kit(() => env, ws, "bakeoff/app");
    const workspaceId = async () => (await env.t.services.store.workspaces.bySlug(ws))?.id as string;
    const statuses = (sha: string) => env.fake.repo("bakeoff/app").statuses.filter((s) => s.sha === sha);
    const branch = async (name: string) =>
        (await request(`/api/v1/w/${ws}/p/app/branches`, { session: env.admin })).body.items.find((b: { name: string }) => b.name === name);

    before(async () => {
        env = await reviewEnv();
        await patProject(env, ws, { repo: "bakeoff/app" });
        await env.fake.gitRepo("bakeoff/app", { "src/a.ts": "export const a = 1;\n" });
        env.runner();
    });
    after(() => env.close());

    test("it needs two or more models, and takes none of the options about the report or the check", async () => {
        const one = await post({ kind: "full", branch: "main", options: { bakeOff: true } });
        assert.equal(one.status, 400, one.text);
        assert.match(one.text, /two or more models/);
        const models = [await favourite("fake/model"), await favourite("fake/wordy-extra")];
        for (const extra of [{ retryFailed: true }, { agreement: { failAt: 2 } }, { agreement: { markSingles: true } }]) {
            const mixed = await post({ kind: "full", branch: "main", models, options: { bakeOff: true, ...extra } });
            assert.equal(mixed.status, 400, mixed.text);
            assert.match(
                mixed.text,
                /A comparison leaves the branch's report and the pull request's check alone, so retryFailed and agreement don't apply/,
            );
        }
        // A project can't make every review a comparison.
        const project = await request(`/api/v1/w/${ws}/p/app/settings/automation`, {
            method: "PATCH",
            session: env.admin,
            body: { options: { bakeOff: true } },
        });
        assert.equal(project.status, 400, project.text);
    });

    test("the branch's report, its triage and the pull request are untouched; the run has the comparison", async () => {
        const models = [await favourite("fake/model"), await favourite("fake/wordy-extra"), await favourite("fake/fail")];
        // The pull request has a review already, with some triage done.
        const head = await pull(51, { "src/b.ts": "export const b = 2;\n", "src/c.ts": "export const c = 3;\n" });
        const review = await finished(env, ws, (await start({ kind: "pr", number: 51 })).id);
        assert.equal(review.status, "done", review.error);
        const before = (await issues("pr-51", "&sort=index")).items;
        assert.equal(before.length, 2);
        const fixed = await request(`/api/v1/w/${ws}/p/app/issues/${before[0].id}?branch=pr-51`, {
            method: "PATCH",
            session: env.admin,
            body: { status: "resolved", note: "Fixed." },
        });
        assert.equal(fixed.status, 200, fixed.text);
        const was = {
            branch: await branch("pr-51"),
            issues: (await issues("pr-51", "&sort=index")).items,
            statuses: statuses(head).length,
            comment: comment(51),
            comments: env.fake.repo("bakeoff/app").comments.get(51)?.length,
            added: (await request(`/api/v1/w/${ws}/analytics?days=7`, { session: env.admin })).body.findings.added,
            pulls: (await request(`/api/v1/w/${ws}/p/app/pull-requests`, { session: env.admin })).body.items,
        };

        const started = await start({ kind: "pr", number: 51, models, options: { bakeOff: true } });
        assert.equal(started.title, "Comparison: PR #51: Change 51");
        assert.equal(started.options.bakeOff, true);
        // An ordinary review of the same commit is still its own thing: neither is taken for the other.
        const done = await finished(env, ws, started.id);
        assert.equal(done.status, "partial", done.error);
        assert.equal(done.branch, "pr-51");
        assert.equal(done.result.counts, null);
        assert.equal(done.result.reportId, undefined);
        assert.equal(done.result.github, undefined, "nothing was posted to GitHub");

        // Nothing about the branch or the pull request has changed.
        assert.deepEqual(await branch("pr-51"), was.branch);
        assert.deepEqual((await issues("pr-51", "&sort=index")).items, was.issues);
        assert.equal((await issues("pr-51")).models, null, "still the one model's report");
        assert.equal(statuses(head).length, was.statuses, "no status: not pending, not passing, not failing");
        assert.equal(comment(51), was.comment);
        assert.equal(env.fake.repo("bakeoff/app").comments.get(51)?.length, was.comments);
        assert.deepEqual((await request(`/api/v1/w/${ws}/p/app/pull-requests`, { session: env.admin })).body.items, was.pulls);
        const activity = (await request(`/api/v1/w/${ws}/p/app/activity?branch=pr-51`, { session: env.admin })).body.items;
        assert.equal(activity.filter((a: { kind: string }) => a.kind === "report").length, 1, "one upload: the review's");

        // The run keeps the comparison; lists carry its figures, not its findings.
        assert.deepEqual(
            done.result.bakeOff.models.map((m: { label: string; status: string; total: number; unique: number; shared: number }) => [
                m.label,
                m.status,
                m.total,
                m.unique,
                m.shared,
            ]),
            [
                ["fake/model", "done", 2, 0, 2],
                ["fake/wordy-extra", "done", 3, 1, 2],
                ["fake/fail", "failed", null, null, null],
            ],
        );
        assert.equal(done.result.bakeOff.findings, undefined);
        const list = (await request(`/api/v1/w/${ws}/runs?project=app`, { session: env.admin })).body.recent;
        assert.equal(list.find((r: { id: string }) => r.id === done.id).result.bakeOff.findings, undefined);

        const got = await request(`/api/v1/w/${ws}/runs/${done.id}/comparison`, { session: env.admin });
        assert.equal(got.status, 200, got.text);
        const c = got.body;
        assert.equal(c.run.id, done.id);
        assert.deepEqual([c.total, c.agreed, c.truncated], [3, 2, false]);
        assert.deepEqual(c.overlap, [
            [2, 2, 0],
            [2, 3, 0],
            [0, 0, 0],
        ]);
        assert.deepEqual(
            c.models[1].bySeverity,
            { critical: 0, high: 2, medium: 0, low: 1 },
            "by the finding's own rating, the lead model's",
        );
        assert.deepEqual(c.models[0].tokens, { input: 1200, output: 300, cacheRead: 100, total: 1500 });
        assert.equal(c.models[2].tokens.total, 40);
        assert.match(c.models[2].error, /Open Code Review failed/);
        assert.deepEqual(
            c.models.map((m: { cost: number | null }) => m.cost),
            [null, null, null],
            "no prices yet",
        );
        assert.deepEqual(
            c.findings.map((f: { path: string; foundBy: string[]; severity: string; startLine: number }) => [
                f.path,
                f.startLine,
                f.severity,
                f.foundBy,
            ]),
            [
                ["src/b.ts", 1, "high", ["fake/model", "fake/wordy-extra"]],
                ["src/c.ts", 1, "high", ["fake/model", "fake/wordy-extra"]],
                ["src/b.ts", 40, "low", ["fake/wordy-extra"]],
            ],
        );
        assert.match(c.findings[2].title, /^Only fake\/wordy-extra noticed this/);
        // With a price for a model, what it cost.
        const priced = await request(`/api/v1/w/${ws}/settings/model-prices`, {
            method: "PUT",
            session: env.admin,
            body: { model: "fake/model", input: 2, output: 10 },
        });
        assert.equal(priced.status, 200, priced.text);
        const again = (await request(`/api/v1/w/${ws}/runs/${done.id}/comparison`, { session: env.admin })).body;
        assert.equal(again.models[0].cost, (1200 * 2 + 300 * 10) / 1e6);
        assert.equal(again.models[1].cost, null);

        // It counts for the models, as a review each did; the backlog doesn't hear of it.
        const history = await env.t.services.history.list({ workspaceId: await workspaceId() });
        const scan = history.filter((h) => h.details.scan?.id === done.id);
        assert.deepEqual(scan.map((h) => [h.model, h.status, h.details.bakeOff, h.details.counts, h.details.addedIds]).sort(), [
            ["fake/fail", "failed", true, undefined, undefined],
            ["fake/model", "done", true, undefined, undefined],
            ["fake/wordy-extra", "done", true, undefined, undefined],
        ]);
        const a = (await request(`/api/v1/w/${ws}/analytics?days=7`, { session: env.admin })).body;
        assert.equal(a.findings.added, was.added);
        assert.deepEqual(a.reviews.byModel.map((g: { key: string; reviews: number }) => [g.key, g.reviews]).sort(), [
            ["fake/fail", 1],
            ["fake/model", 2],
            ["fake/wordy-extra", 1],
        ]);

        // It isn't a review to run a model of again, and an ordinary review has no comparison.
        const rerun = await request(`/api/v1/w/${ws}/runs/${done.id}/models/2/rerun`, { method: "POST", session: env.admin });
        assert.equal(rerun.status, 409, rerun.text);
        assert.match(rerun.text, /A comparison has no report to add to/);
        assert.match((await run(done.id)).rerunnable[0].reason, /A comparison has no report to add to/);
        const none = await request(`/api/v1/w/${ws}/runs/${review.id}/comparison`, { session: env.admin });
        assert.equal(none.status, 404, none.text);

        // An agent reads it the same way; anyone who can read the workspace can.
        const agent = await token("read");
        const told = await mcp(agent, "get_comparison", { id: done.id });
        assert.match(told.content[0].text, /3 finding\(s\) between them, 2 found by more than one model/);
        assert.match(told.content[0].text, /- fake\/wordy-extra: 3 finding\(s\), 1 only it found, 2 another found too, 1500 tokens/);
        assert.match(told.content[0].text, /- fake\/model: .*US\$0\.0054/);
        assert.equal(told.structuredContent.findings.length, 3);
        // A comparison too long to keep whole says how many of its findings are in the data, not how many there were.
        const kept = (await env.t.services.store.jobs.get(done.id)) as Job;
        const made = kept.result?.bakeOff as { findings: unknown[] };
        const findings = Array.from({ length: 60 }, () => made.findings[0]);
        await env.t.services.store.jobs.put({
            ...kept,
            result: { ...kept.result, bakeOff: { ...made, findings, total: 620, truncated: true } },
        });
        const long = (await mcp(agent, "get_comparison", { id: done.id })).content[0].text;
        assert.match(long, /…and 10 more \(in the data\)\.\nOnly 60 of the 620 findings were kept/);
        await env.t.services.store.jobs.put(kept);
        // But only someone who may start reviews may start one.
        assert.equal(
            (await mcp(agent, "start_review", { kind: "full", models: models.slice(0, 2), options: { bakeOff: true } })).isError,
            true,
        );
    });

    test("a branch that has no report gets none from a comparison, and it says so while it runs or if it fails", async () => {
        const slow = [await favourite("fake/sleep-2"), await favourite("fake/model")];
        const started = await start({ kind: "full", branch: "main", models: slow, options: { bakeOff: true, judge: null } });
        assert.equal(started.title, "Comparison: Full scan of main");
        await eventually(async () => (await run(started.id)).status === "running", "the comparison to start");
        const early = await request(`/api/v1/w/${ws}/runs/${started.id}/comparison`, { session: env.admin });
        assert.equal(early.status, 409, early.text);
        assert.match(early.text, /hasn't finished yet/);
        // An ordinary scan of the same branch can be asked for meanwhile: it's not the same thing.
        const scan = await start({ kind: "full", branch: "main", models: [slow[1] as string] });
        assert.notEqual(scan.id, started.id);
        const done = await finished(env, ws, started.id);
        assert.equal(done.status, "done", done.error);
        await finished(env, ws, scan.id);
        assert.equal((await issues("main")).models, null, "main has the scan's report, not the comparison's");
        assert.equal((await issues("main")).total, 1);

        // Every model failing leaves nothing to compare.
        const failing = [await favourite("fake/fail"), await favourite("fake/fail-b")];
        const failed = await finished(
            env,
            ws,
            (await start({ kind: "full", branch: "main", models: failing, options: { bakeOff: true } })).id,
        );
        assert.equal(failed.status, "failed");
        const nothing = await request(`/api/v1/w/${ws}/runs/${failed.id}/comparison`, { session: env.admin });
        assert.equal(nothing.status, 409, nothing.text);
        assert.match(nothing.text, /This comparison failed, so there's nothing to compare\. No model finished/);
        assert.equal((await issues("main")).total, 1);
    });
});

describe("a comparison whose models are down to one by the time it starts", () => {
    let env: ReviewEnv;
    const ws = "bakeone";
    const { request, favourite, start, run } = kit(() => env, ws, "bakeone/app");
    const runner = { id: "runner-bakeone-000", name: "bakeone", version: "1", slots: 1 };

    before(async () => {
        env = await reviewEnv();
        await patProject(env, ws, { repo: "bakeone/app" });
        await env.fake.gitRepo("bakeone/app", { "a.ts": "a\n" });
    });
    after(() => env.close());

    test("fails saying so, rather than running as a review that would replace the branch's report", async () => {
        const automation = (body: object) =>
            request(`/api/v1/w/${ws}/p/app/settings/automation`, { method: "PATCH", session: env.admin, body });
        const models = [await favourite("fake/a"), await favourite("fake/b")];
        assert.equal((await automation({ models: { all: models } })).status, 200);
        // The project's two models, so no models of its own.
        const started = await start({ kind: "full", branch: "main", options: { bakeOff: true } });
        assert.equal((await automation({ models: { all: [models[0]] } })).status, 200);
        assert.equal(await env.t.services.runs.claim(runner), null);
        const failed = await run(started.id);
        assert.equal(failed.status, "failed");
        assert.equal(
            failed.error,
            "A comparison needs two or more models, and this one now has one. Start it again and choose its models.",
        );
        const branches = (await request(`/api/v1/w/${ws}/p/app/branches`, { session: env.admin })).body.items;
        assert.deepEqual(branches, []);
    });
});
