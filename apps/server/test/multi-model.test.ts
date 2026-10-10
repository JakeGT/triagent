// Reviews run with several models: the project lists them, the runner reviews with them all at once, and
// the server merges their findings into one list for triage (who found what, and what the others said),
// while the review history keeps a record for each model, grouped by the scan, for analytics. A model
// that passes its token budget is stopped alone, and the run says why.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { distance, MAX_MODELS, mergeReports, modelLabels } from "../src/domain/merge.ts";
import { parseReport } from "../src/domain/report.ts";
import { reviewGaps } from "../src/domain/review-run.ts";
import { overBudget, type RunnerHello } from "../src/services/runs.ts";
import { finished, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

describe("merging several models' reports", () => {
    const finding = (path: string, line: number | null, content: string, category = "bug", severity = "high") => ({
        path,
        content,
        category,
        severity,
        ...(line === null ? {} : { start_line: line, end_line: line }),
    });

    test("the same place and category is one finding, the first model's wording leading", () => {
        const merged = mergeReports([
            {
                label: "a",
                report: { comments: [finding("x.ts", 10, "A says"), finding("y.ts", 1, "Only A")], project_summary: "A's summary" },
            },
            { label: "b", report: { comments: [finding("x.ts", 12, "B says", "bug", "critical")], project_summary: "B's summary" } },
        ]);
        assert.deepEqual(merged.models, ["a", "b"]);
        assert.equal(merged.project_summary, "A's summary");
        assert.equal(merged.comments.length, 2);
        const [x, y] = merged.comments;
        assert.equal(x?.content, "A says");
        assert.deepEqual(x?.found_by, ["a", "b"]);
        assert.deepEqual((x?.also as unknown[] | undefined)?.[0], {
            model: "b",
            severity: "critical",
            category: "bug",
            start_line: 12,
            end_line: 12,
            content: "B says",
            suggestion_code: null,
        });
        assert.deepEqual(y?.found_by, ["a"]);
    });

    test("another category, another file, or lines too far apart are different findings", () => {
        assert.equal(distance(finding("x.ts", 10, "a"), finding("x.ts", 10, "b", "security")), null);
        assert.equal(distance(finding("x.ts", 10, "a"), finding("z.ts", 10, "b")), null);
        assert.equal(distance(finding("x.ts", 10, "a"), finding("x.ts", 20, "b")), null);
        assert.equal(distance(finding("x.ts", 10, "a"), finding("x.ts", null, "b")), null);
        assert.equal(distance(finding("x.ts", null, "a"), finding("x.ts", null, "b")), 0);
        assert.equal(distance(finding("x.ts", 10, "a"), finding("x.ts", 13, "b")), 3);
    });

    test("one model's own findings are never merged with each other", () => {
        const merged = mergeReports([
            { label: "a", report: { comments: [finding("x.ts", 10, "one"), finding("x.ts", 10, "two")] } },
            { label: "b", report: { comments: [finding("x.ts", 10, "B")] } },
        ]);
        assert.deepEqual(
            merged.comments.map((c) => (c as { found_by: string[] }).found_by),
            [["a", "b"], ["a"]],
        );
    });

    test("a model that failed makes the review partial, naming it but not saying why (the note goes on GitHub)", () => {
        const merged = mergeReports([
            { label: "a", report: { comments: [finding("x.ts", 1, "A")] } },
            { label: "b", report: null, error: "Open Code Review failed (exit 1): /home/runner/secret-path" },
        ]);
        const gaps = reviewGaps(merged);
        assert.deepEqual(gaps?.models, ["b"]);
        assert.match(gaps?.note ?? "", /b didn't finish/);
        assert.doesNotMatch(gaps?.note ?? "", /secret-path/);
    });

    test("triage sees who found each finding only when there was more than one model", () => {
        const several = parseReport(
            mergeReports([
                { label: "a", report: { comments: [finding("x.ts", 1, "A")] } },
                { label: "b", report: { comments: [finding("x.ts", 1, "B")] } },
            ]),
            null,
        );
        assert.deepEqual(several.meta.models, ["a", "b"]);
        assert.deepEqual(several.issues[0]?.foundBy, ["a", "b"]);
        assert.equal(several.issues[0]?.alsoFound[0]?.content, "B");
        const one = parseReport(mergeReports([{ label: "a", report: { comments: [finding("x.ts", 1, "A")] } }]), null);
        assert.equal(one.meta.models, null);
        assert.equal(one.issues[0]?.foundBy, null);
        // An uploaded report can't use these fields to break anything: odd values are ignored.
        const odd = parseReport({ comments: [{ ...finding("x.ts", 1, "A"), found_by: "a", also: [{}] }], models: ["a", "b"] }, null);
        assert.equal(odd.issues[0]?.foundBy, null);
        assert.deepEqual(odd.issues[0]?.alsoFound, []);
    });

    test("something in one model's list that isn't a finding doesn't lose the others' findings", () => {
        const merged = mergeReports([
            { label: "a", report: { comments: [null, 7, finding("x.ts", 1, "A")] as never } },
            { label: "b", report: { comments: [finding("y.ts", 2, "B")] } },
        ]);
        assert.deepEqual(
            merged.comments.map((c) => c.content),
            ["A", "B"],
        );
    });

    test("five models' reports are one: each finding says which of the five found it, and those that failed are named", () => {
        assert.equal(MAX_MODELS, 5);
        const merged = mergeReports([
            { label: "a", report: { comments: [finding("x.ts", 10, "A"), finding("y.ts", 1, "Only A")], project_summary: "A's" } },
            { label: "b", report: { comments: [finding("x.ts", 11, "B")], project_summary: "B's" } },
            { label: "c", report: null, error: "Stopped: it passed its token budget of 20,000 tokens." },
            { label: "d", report: { comments: [finding("x.ts", 12, "D"), finding("z.ts", 5, "Only D")] } },
            { label: "e", report: { comments: [finding("x.ts", 9, "E"), finding("z.ts", 7, "E too")] } },
        ]);
        assert.deepEqual(merged.models, ["a", "b", "d", "e"]);
        assert.deepEqual(
            merged.comments.map((c) => [c.content, c.found_by]),
            [
                ["A", ["a", "b", "d", "e"]],
                ["Only A", ["a"]],
                ["Only D", ["d", "e"]],
            ],
        );
        assert.deepEqual(
            (merged.comments[0]?.also as { model: string }[] | undefined)?.map((o) => o.model),
            ["b", "d", "e"],
        );
        assert.deepEqual(merged.warnings, [
            { type: "model_failed", file: "", model: "c", message: "c: Stopped: it passed its token budget of 20,000 tokens." },
        ]);
        assert.deepEqual(
            (merged.model_summaries as { model: string }[]).map((m) => m.model),
            ["b", "d", "e"],
        );
    });

    test("labels: the nickname or the model's name, with its provider when two share it, and never the same twice", () => {
        assert.deepEqual(
            modelLabels([
                { model: "gpt-5", providerName: "OpenRouter" },
                { model: "gpt-5", providerName: "OpenAI" },
                { model: "claude", providerName: "Anthropic" },
            ]),
            ["gpt-5 (OpenRouter)", "gpt-5 (OpenAI)", "claude"],
        );
        assert.deepEqual(
            modelLabels([
                { name: "Fast", model: "gpt-5-mini", providerName: "OpenAI" },
                { name: null, model: "Fast", providerName: "OpenAI" },
                { name: "Careful", model: "gpt-5", providerName: "OpenAI" },
            ]),
            ["Fast (OpenAI)", "Fast (OpenAI) #2", "Careful"],
        );
    });
});

describe("reviews with several models, end to end", () => {
    let env: ReviewEnv;
    const ws = "multi";
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
    const models = (ids: string[]) =>
        env.t.request(`/api/v1/w/${ws}/p/app/settings/automation`, { method: "PATCH", session: env.admin, body: { models: { all: ids } } });
    const start = async (body: object) => {
        const r = await env.t.request(`/api/v1/w/${ws}/p/app/reviews`, { method: "POST", session: env.admin, body });
        assert.equal(r.status, 201, r.text);
        return r.body;
    };

    before(async () => {
        env = await reviewEnv();
        await patProject(env, ws, { repo: "multi/app" });
        await env.fake.gitRepo("multi/app", { "src/a.ts": "export const a = 1;\n", "README.md": "# App\n" });
        env.runner();
    });
    after(() => env.close());

    test("the project's settings take up to five models, each once, from the workspace's favourites", async () => {
        const unknown = await models(["nope"]);
        assert.equal(unknown.status, 400);
        assert.match(unknown.text, /isn't one of this workspace's favourite models/);
        const one = await favourite("fake/model");
        const twice = await models([one, one]);
        assert.equal(twice.status, 400);
        assert.match(twice.text, /only be chosen once/);
        const five = [one, await favourite("fake/b"), await favourite("fake/c"), await favourite("fake/d"), await favourite("fake/e")];
        assert.equal((await models(five)).status, 200);
        const six = await models([...five, await favourite("fake/f")]);
        assert.equal(six.status, 400);
        assert.match(six.text, /<=5 items/);
        // A review's own choice has the same limit, and the web app is told it.
        const started = await env.t.request(`/api/v1/w/${ws}/p/app/reviews`, {
            method: "POST",
            session: env.admin,
            body: { kind: "full", branch: "main", models: [...five, await favourite("fake/f")] },
        });
        assert.equal(started.status, 400, started.text);
        assert.equal((await env.t.request(`/api/v1/w/${ws}/models`, { session: env.admin })).body.max, 5);
        assert.equal((await models([])).status, 200);
    });

    test("each model reviews; their findings are merged, and each model's own record is kept", async () => {
        const set = await models([await favourite("fake/model"), await favourite("fake/wordy-extra"), await favourite("fake/fail")]);
        assert.equal(set.status, 200, set.text);
        const run = await finished(env, ws, (await start({ kind: "full", branch: "main" })).id);

        // One model failed, so the review is partial; the other two's findings are in.
        assert.equal(run.status, "partial", run.error);
        assert.deepEqual(
            run.model.models.map((m: { label: string }) => m.label),
            ["fake/model", "fake/wordy-extra", "fake/fail"],
        );
        assert.deepEqual(
            run.result.models.map((m: { label: string; status: string; total: number | null }) => [m.label, m.status, m.total]),
            [
                ["fake/model", "done", 2],
                ["fake/wordy-extra", "done", 3],
                ["fake/fail", "failed", null],
            ],
        );
        assert.equal(run.result.total, 3, "two findings both models made, and one only the second did");
        assert.deepEqual(run.result.gaps.models, ["fake/fail"]);
        assert.equal(run.result.tokens.total, 1500 + 1500 + 40);
        const log = (await env.t.request(`/api/v1/w/${ws}/runs/${run.id}`, { session: env.admin })).body.logLines.map(
            (l: { line: string }) => l.line,
        );
        assert.ok(log.includes("[triagent] Reviewing with 3 models at once: fake/model, fake/wordy-extra, fake/fail."));
        assert.ok(log.includes("[fake/wordy-extra] [ocr] Writing the summary"), "each model's lines start with its label");
        assert.deepEqual(
            run.result.models.map((m: { reason: string | null }) => m.reason),
            [null, null, null],
            "none was stopped: one failed by itself",
        );
        // Each model's own progress is kept with the run, in order.
        assert.deepEqual(
            run.progress.models.map((m: { label: string; phase: string }) => [m.label, m.phase]),
            [
                ["fake/model", "done"],
                ["fake/wordy-extra", "done"],
                ["fake/fail", "failed"],
            ],
        );

        // Triage: one list, who found each finding, and what the others said.
        const issues = (await env.t.request(`/api/v1/w/${ws}/p/app/issues?branch=main&sort=agreement`, { session: env.admin })).body;
        assert.equal(issues.total, 3);
        assert.deepEqual(issues.items[0].foundBy, ["fake/model", "fake/wordy-extra"]);
        assert.deepEqual(issues.items.at(-1).foundBy, ["fake/wordy-extra"]);
        const agreed = (await env.t.request(`/api/v1/w/${ws}/p/app/issues?branch=main&foundBy=2`, { session: env.admin })).body;
        assert.equal(agreed.total, 2);
        const detail = (await env.t.request(`/api/v1/w/${ws}/p/app/issues/${issues.items[0].id}?branch=main`, { session: env.admin })).body;
        assert.match(detail.content, /by the fake reviewer\.$/, "the first model's wording leads");
        assert.equal(detail.alsoFound[0].model, "fake/wordy-extra");
        assert.equal(detail.alsoFound[0].severity, "medium");
        assert.match(detail.alsoFound[0].content, /Looking closely/);
        const md = await env.t.request(`/api/v1/w/${ws}/p/app/issues/${issues.items[0].id}/markdown?branch=main`, { session: env.admin });
        assert.match(md.text, /\*\*Found by:\*\* fake\/model, fake\/wordy-extra/);
        assert.match(md.text, /\*\*fake\/wordy-extra also found it\*\* \(medium\/bug\) at line 3:/);

        // Analytics: a record per model, grouped under the scan; it counts as one review.
        const history = await env.t.services.history.list({
            workspaceId: run.workspaceId ?? ((await env.t.services.store.workspaces.bySlug(ws))?.id as string),
        });
        const mine = history.filter((h) => h.details.scan?.id === run.id);
        assert.deepEqual(mine.map((h) => [h.model, h.status, h.tokens?.total ?? null, h.details.scan?.lead]).sort(), [
            ["fake/fail", "failed", 40, false],
            ["fake/model", "done", 1500, true],
            ["fake/wordy-extra", "done", 1500, false],
        ]);
        const a = (await env.t.request(`/api/v1/w/${ws}/analytics?days=7`, { session: env.admin })).body;
        assert.equal(a.reviews.total, 1);
        assert.equal(a.reviews.byStatus.partial, 1);
        assert.equal(a.reviews.findings, 3);
        assert.equal(a.reviews.tokens.total, 3040);
        assert.equal(a.reviews.latest[0].model, "fake/model + fake/wordy-extra + fake/fail");
        assert.deepEqual(a.reviews.byModel.map((g: { key: string; reviews: number }) => [g.key, g.reviews]).sort(), [
            ["fake/fail", 1],
            ["fake/model", 1],
            ["fake/wordy-extra", 1],
        ]);
    });

    test("five models review at once; the one that passes its token budget is stopped alone, and the run says why", async () => {
        const ids = [];
        for (const m of ["fake/model", "fake/wordy-extra", "fake/spend-25000-sleep-30", "fake/b", "fake/c"]) ids.push(await favourite(m));
        const automation = `/api/v1/w/${ws}/p/app/settings/automation`;
        const set = await env.t.request(automation, {
            method: "PATCH",
            session: env.admin,
            body: { models: { all: ids }, maxTokensBudget: 20_000 },
        });
        assert.equal(set.status, 200, set.text);
        const t0 = Date.now();
        const run = await finished(env, ws, (await start({ kind: "full", branch: "main" })).id);
        // Stopped by the server's reply to the runner's progress, not left to run its thirty seconds.
        assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0}ms`);
        assert.equal(run.status, "partial", run.error);
        assert.deepEqual(
            run.result.models.map((m: { label: string; status: string; reason: string | null }) => [m.label, m.status, m.reason]),
            [
                ["fake/model", "done", null],
                ["fake/wordy-extra", "done", null],
                ["fake/spend-25000-sleep-30", "failed", "overBudget"],
                ["fake/b", "done", null],
                ["fake/c", "done", null],
            ],
        );
        const stopped = run.result.models[2];
        assert.equal(stopped.error, "Stopped: it passed its token budget of 20,000 tokens.");
        assert.equal(stopped.tokens, 25_000);
        assert.deepEqual(run.result.gaps.models, ["fake/spend-25000-sleep-30"]);
        assert.equal(run.result.total, 3, "the other four's findings are merged");
        assert.deepEqual([run.progress.models[2].phase, run.progress.models[2].reason], ["failed", "overBudget"]);
        const back = await env.t.request(automation, {
            method: "PATCH",
            session: env.admin,
            body: { models: { all: [] }, maxTokensBudget: null },
        });
        assert.equal(back.status, 200, back.text);
    });

    test("a listed model without a key keeps reviews waiting, saying which", async () => {
        assert.equal((await models([await favourite("claude-test", "anthropic")])).status, 200);
        const queued = await start({ kind: "full", branch: "main" });
        await new Promise((r) => setTimeout(r, 400));
        const list = (await env.t.request(`/api/v1/w/${ws}/runs?project=app`, { session: env.admin })).body;
        const waiting = list.queued.find((q: { id: string }) => q.id === queued.id);
        assert.ok(waiting, "still queued");
        assert.match(waiting.waiting, /Anthropic API key.*this project's reviews use claude-test/);
        await env.t.request(`/api/v1/w/${ws}/runs/${queued.id}/cancel`, { method: "POST", session: env.admin });
        assert.equal((await models([])).status, 200);
    });
});

describe("stopping a model that passes its token budget", () => {
    let env: ReviewEnv;
    const ws = "budgets";
    const runner: RunnerHello = { id: "runner-budgets-0000", name: "budgets", version: "1", slots: 1 };
    const model = (label: string, budget: number | null) => ({ provider: "openrouter", model: label, label, budget });

    before(async () => {
        env = await reviewEnv();
        await patProject(env, ws, { repo: "budgets/app" });
        await env.fake.gitRepo("budgets/app", { "src/a.ts": "export const a = 1;\n" });
    });
    after(() => env.close());

    test("only a running model whose own tokens are past its own budget is named", () => {
        const job = (progress: object[], budgets: (number | null)[] = [20_000, 20_000, null]) => ({
            model: {
                ...model("a", budgets[0] ?? null),
                keySource: "workspace" as const,
                models: budgets.map((b, i) => model("abc"[i] as string, b)),
            },
            progress: { tokens: 90_000, models: progress },
        });
        assert.deepEqual(
            overBudget(
                job([
                    { label: "a", phase: "reviewing", tokens: 20_000 },
                    { label: "b", phase: "reviewing", tokens: 20_001 },
                    { label: "c", phase: "reviewing", tokens: 900_000 },
                ]),
            ),
            [{ index: 1, label: "b", reason: "overBudget", budget: 20_000 }],
            "at its budget isn't past it, and a model with no budget is never stopped",
        );
        // One that has already ended, or hasn't said what it used, has nothing to stop.
        assert.deepEqual(overBudget(job([{ phase: "failed", tokens: 50_000 }, { phase: "waiting" }, {}])), []);
        // Each against its own budget (the instance's model has what's left of the allowance).
        assert.deepEqual(
            overBudget(
                job(
                    [
                        { phase: "reviewing", tokens: 15_000 },
                        { phase: "reviewing", tokens: 15_000 },
                    ],
                    [30_000, 10_000],
                ),
            ).map((s) => [s.index, s.budget]),
            [[1, 10_000]],
        );
        // A run with one model, or a runner that doesn't say how each model is doing, is left alone.
        assert.deepEqual(overBudget({ model: { ...model("a", 10), keySource: "workspace" }, progress: { tokens: 99 } }), []);
        assert.deepEqual(overBudget({ ...job([]), progress: { tokens: 90_000 } }), []);
    });

    test("the reply to progress and heartbeats names it; the others carry on, and the run records why it stopped", async () => {
        const ids = [];
        for (const m of ["fake/a", "fake/b", "fake/c"]) {
            const added = await env.t.request(`/api/v1/w/${ws}/settings/models/favourites`, {
                method: "POST",
                session: env.admin,
                body: { provider: "openrouter", model: m },
            });
            assert.equal(added.status, 201, added.text);
            ids.push(added.body.favourites.find((f: { model: string }) => f.model === m).id);
        }
        const set = await env.t.request(`/api/v1/w/${ws}/p/app/settings/automation`, {
            method: "PATCH",
            session: env.admin,
            body: { models: { all: ids }, maxTokensBudget: 20_000 },
        });
        assert.equal(set.status, 200, set.text);
        const started = await env.t.request(`/api/v1/w/${ws}/p/app/reviews`, {
            method: "POST",
            session: env.admin,
            body: { kind: "full", branch: "main" },
        });
        assert.equal(started.status, 201, started.text);
        const runs = env.t.services.runs;
        const job = await runs.claim(runner);
        assert.deepEqual(
            job?.models.map((m) => m.label),
            ["fake/a", "fake/b", "fake/c"],
        );
        assert.ok(job);
        const going = (tokens: (number | undefined)[], phases: string[] = []) => ({
            phase: "reviewing",
            tokens: tokens.reduce((n: number, t) => n + (t ?? 0), 0),
            models: tokens.map((t, i) => ({
                label: job.models[i]?.label,
                phase: phases[i] ?? "reviewing",
                startedAt: new Date(Date.now() - 5000).toISOString(),
                ...(t === undefined ? {} : { tokens: t }),
                secret: "not kept",
            })),
        });

        // Nobody is over yet.
        assert.deepEqual(await runs.events(runner, job.id, { progress: going([5_000, 19_000, undefined]) }), { cancel: false, stop: [] });
        // The second passes its budget: it's named, by its place and label, with the budget it passed.
        const stop = [{ index: 1, label: "fake/b", reason: "overBudget", budget: 20_000 }];
        assert.deepEqual(await runs.events(runner, job.id, { progress: going([5_000, 20_500, undefined]) }), { cancel: false, stop });
        const beat = await runs.heartbeat(runner, job.id);
        assert.deepEqual([beat.cancel, beat.stop], [false, stop]);
        // Log lines alone (no progress) say the same, from what's known.
        assert.deepEqual((await runs.events(runner, job.id, { lines: [{ line: "[fake/b] [ocr] still going" }] })).stop, stop);

        // The run page sees each model's own progress, with how long each has been going, and nothing else the runner sent.
        const view = (await env.t.request(`/api/v1/w/${ws}/runs/${job.id}`, { session: env.admin })).body;
        assert.deepEqual(Object.keys(view.progress.models[1]).sort(), ["label", "phase", "seconds", "startedAt", "tokens"]);
        assert.equal(view.progress.models[1].tokens, 20_500);
        assert.ok(view.progress.models[1].seconds >= 5 && view.progress.models[1].seconds < 60, String(view.progress.models[1].seconds));
        assert.equal(view.progress.tokens, 25_500);

        // The runner stops it and says so: it isn't named again, and the others are untouched.
        const after = going([6_000, 20_500, 100], ["reviewing", "failed", "reviewing"]);
        assert.deepEqual(await runs.events(runner, job.id, { progress: after }), { cancel: false, stop: [] });

        // Through the runner's own API: the reply carries `stop` beside `cancel`, and takes each part's reason.
        const post = (what: string, body: object) =>
            fetch(`${env.url}/internal/runner/jobs/${job.id}/${what}`, {
                method: "POST",
                headers: { authorization: `Bearer ${env.secret}`, "content-type": "application/json" },
                body: JSON.stringify({ runner, ...body }),
            });
        const reply = await (await post("events", { lines: [], progress: going([6_000, 20_500, 100]) })).json();
        assert.deepEqual(reply, { cancel: false, stop });
        const report = (content: string) => ({
            comments: [{ path: "src/a.ts", content, severity: "high", category: "bug", start_line: 1, end_line: 1 }],
        });
        const done = await post("finish", {
            status: "done",
            parts: [
                { status: "done", report: report("A found it"), tokens: 6_000, seconds: 9 },
                {
                    status: "failed",
                    reason: "overBudget",
                    error: "Stopped: it passed its token budget of 20,000 tokens.",
                    tokens: 20_500,
                    seconds: 7,
                },
                // A runner older than reasons: what it says is read instead.
                {
                    status: "failed",
                    error: "Stalled: Open Code Review printed nothing for 30 minutes, so it was stopped.",
                    tokens: 100,
                    seconds: 8,
                },
            ],
        });
        assert.equal(done.status, 200, await done.clone().text());
        const run = (await env.t.request(`/api/v1/w/${ws}/runs/${job.id}`, { session: env.admin })).body;
        assert.equal(run.status, "partial");
        assert.deepEqual(
            run.result.models.map((m: { label: string; status: string; reason: string | null; tokens: number | null }) => [
                m.label,
                m.status,
                m.reason,
                m.tokens,
            ]),
            [
                ["fake/a", "done", null, 6_000],
                ["fake/b", "failed", "overBudget", 20_500],
                ["fake/c", "failed", "stalled", 100],
            ],
        );
        assert.equal(run.result.models[1].error, "Stopped: it passed its token budget of 20,000 tokens.");
        assert.equal(run.result.total, 1);
        // The time limit is told apart the same way; a failure that wasn't a stop has no reason.
        assert.deepEqual(Object.keys(run.result.models[0]).sort(), [
            "error",
            "label",
            "model",
            "provider",
            "reason",
            "seconds",
            "status",
            "tokens",
            "total",
        ]);
    });

    test("a finish with more parts than a review can have models is refused", async () => {
        const part = { status: "failed", error: "x" };
        const res = await fetch(`${env.url}/internal/runner/jobs/nope/finish`, {
            method: "POST",
            headers: { authorization: `Bearer ${env.secret}`, "content-type": "application/json" },
            body: JSON.stringify({ runner, status: "failed", parts: Array.from({ length: MAX_MODELS + 1 }, () => part) }),
        });
        assert.equal(res.status, 400);
        const five = await fetch(`${env.url}/internal/runner/jobs/nope/finish`, {
            method: "POST",
            headers: { authorization: `Bearer ${env.secret}`, "content-type": "application/json" },
            body: JSON.stringify({ runner, status: "failed", parts: Array.from({ length: MAX_MODELS }, () => part) }),
        });
        // Five are read (and then the job isn't this runner's: there's no such job).
        assert.equal(five.status, 409);
    });
});
