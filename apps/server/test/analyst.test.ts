// Asking a model to write about reviews and findings (services/analyst.ts), against a stand-in for a
// provider: which model is asked and who may choose it, a review's written comparison and summary (and
// that the model is sent figures and titles, never code), a question about the analytics with the lookups
// it may ask for, the warnings when there's little to go on, and what happens when the model lets it down.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { FakeProvider } from "../../../tests/fakes/model-provider.ts";
import { describeLookup, readPlan, thinData, written } from "../src/domain/analyst.ts";
import { MAX_PER_HOUR } from "../src/services/analyst.ts";
import type { Analysis } from "../src/store/types.ts";
import { eventually, finished, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const SECRET_CODE = "export const a = 'DO-NOT-SEND-THIS-CODE';\n";

describe("what a model says, read", () => {
    test("writing is kept as text: links become their words, images their description, addresses go", () => {
        const said = [
            "**In short** see [the docs](https://evil.example/x?token=1) and ![a chart](https://evil.example/pixel.png).",
            "",
            "",
            "",
            "Go to https://evil.example/now or <https://evil.example/again>. A [ref][1] too.",
            "[1]: https://evil.example/ref",
        ].join("\n");
        const out = written(said);
        assert.doesNotMatch(out, /evil\.example|https?:/);
        assert.match(out, /\*\*In short\*\* see the docs and a chart\./);
        assert.match(out, /A ref too\./);
        assert.doesNotMatch(out, /\n{3,}/);
        assert.equal(written("x".repeat(50), 10).length, 10);
    });

    test("a plan is an answer, or lookups read strictly: known projects and fields only, three at most", () => {
        assert.deepEqual(readPlan('Sure! {"answer": "Twelve."}', ["app"]), { answer: "Twelve." });
        // A model that just answers in words has answered.
        assert.deepEqual(readPlan("Twelve findings are open.", ["app"]), { answer: "Twelve findings are open." });
        const plan = readPlan(
            JSON.stringify({
                lookups: [
                    {
                        project: "app",
                        severity: ["high", "nonsense"],
                        status: "open",
                        model: "One",
                        onlyModel: true,
                        foundBy: 99,
                        ids: ["x"],
                    },
                    { project: "someone-elses" },
                    { project: "app", onlyModel: true, path: "src/", q: "  sql  " },
                    { project: "app" },
                    { project: "app" },
                ],
            }),
            ["app"],
        );
        assert.deepEqual(plan, {
            lookups: [
                { project: "app", severity: ["high"], status: ["open"], model: "One", onlyModel: true },
                // onlyModel means nothing without a model.
                { project: "app", path: "src/", q: "sql" },
                { project: "app" },
            ],
        });
        assert.equal(readPlan('{"lookups": [{"project": "nope"}]}', ["app"]), null);
        assert.equal(readPlan('{"something": "else"}', ["app"]), null);
        assert.equal(readPlan("{not json", ["app"]), null);
    });

    test("a lookup in words, and when there's little to go on", () => {
        assert.equal(
            describeLookup({
                project: "app",
                branch: "dev",
                status: ["open"],
                severity: ["critical", "high"],
                model: "One",
                onlyModel: true,
            }),
            "open critical or high findings only One found in app (dev)",
        );
        assert.equal(
            describeLookup({ project: "app", path: "src/", foundBy: 2, q: "sql" }),
            'findings in src/ found by at least 2 models mentioning "sql" in app',
        );
        assert.equal(thinData(3, 10), null);
        assert.match(thinData(1, 400) ?? "", /1 review and 400 findings/);
        assert.match(thinData(9, 2) ?? "", /9 reviews and 2 findings/);
    });
});

describe("asking a model", () => {
    let env: ReviewEnv;
    let provider: FakeProvider;
    const ws = "asked";
    const key = `sk-analyst-${"a".repeat(24)}`;
    const api = `/api/v1/w/${ws}`;
    const request: ReviewEnv["t"]["request"] = (...args) => env.t.request(...args);
    const get = (path: string) => request(`${api}${path}`, { session: env.admin });
    const post = (path: string, body: object, method = "POST") => request(`${api}${path}`, { method, session: env.admin, body });
    const favourite = async (model: string, provider_ = "openrouter"): Promise<string> => {
        type Fav = { id: string; provider: string; model: string };
        const is = (f: Fav) => f.provider === provider_ && f.model === model;
        const have = (await get("/settings/models/favourites")).body.favourites.find(is);
        if (have) return have.id;
        const added = await post("/settings/models/favourites", { provider: provider_, model });
        assert.equal(added.status, 201, added.text);
        return added.body.favourites.find(is).id;
    };
    /** Wait for an analysis to stop running. */
    const done = async (id: string): Promise<Analysis> =>
        eventually(async () => {
            const a = (await get(`/analyses/${id}`)).body as Analysis;
            return a.status === "running" ? null : a;
        }, "the analysis to finish");
    const scan = async (models: string[]) => {
        const started = await post("/p/app/reviews", { kind: "full", branch: "main", models });
        assert.equal(started.status, 201, started.text);
        const run = await finished(env, ws, started.body.id);
        assert.equal(run.status, "done", run.error);
        return run;
    };
    let analystId = "";
    let models: string[] = [];
    let first: { id: string };

    before(async () => {
        provider = await new FakeProvider().start();
        env = await reviewEnv({ env: { ALLOW_PRIVATE_MODEL_URLS: "true" } });
        await patProject(env, ws, { repo: "asked/app" });
        await env.fake.gitRepo("asked/app", { "src/a.ts": SECRET_CODE, "src/b.ts": "export const b = 2;\n" });
        env.runner();
        models = [await favourite("fake/model"), await favourite("fake/wordy-extra"), await favourite("fake/alarm")];
        first = await scan(models);
    });
    after(async () => {
        await env.t.services.analyst.settled();
        await env.close();
        await provider.stop();
    });
    beforeEach(() => {
        provider.requests.length = 0;
        provider.mode = "answer";
        provider.say = () => "**In short** it went well.";
    });

    test("nothing is asked until a model is chosen, and the page is told why", async () => {
        const view = (await get("/settings/analysis")).body;
        assert.equal(view.model, null);
        assert.equal(view.ready, false);
        assert.match(view.reason, /No model is chosen for analysis yet/);
        assert.deepEqual(view.afterReview, { comparison: false, summary: false });
        const refused = await post(`/runs/${first.id}/analysis`, { kind: "comparison" });
        assert.equal(refused.status, 409, refused.text);
        assert.match(refused.text, /No model is chosen for analysis yet\. An admin can choose one in Settings → Analysis/);
        assert.equal((await post("/ask", { question: "How many findings are open?" })).status, 409);
        assert.equal(provider.requests.length, 0);
        const state = (await get(`/runs/${first.id}/analysis`)).body;
        assert.deepEqual([state.comparison, state.summary, state.model.ready], [null, null, false]);
        assert.deepEqual(state.unavailable, { comparison: null, summary: null });
    });

    test("choosing the model: one of the workspace's own, not one on Amazon Bedrock; admins only", async () => {
        assert.equal((await post("/settings/analysis", { model: "nope" }, "PUT")).status, 400);
        const bedrock = await favourite("anthropic.claude-test", "bedrock");
        const refused = await post("/settings/analysis", { model: bedrock }, "PUT");
        assert.equal(refused.status, 400, refused.text);
        assert.match(refused.text, /Amazon Bedrock can't be asked/);
        assert.equal((await post("/settings/analysis", { model: models[0], extra: 1 }, "PUT")).status, 400);

        const set = await post("/settings/review-model/providers/custom", { url: `${provider.url}/v1`, protocol: "openai" }, "PATCH");
        assert.equal(set.status, 200, set.text);
        analystId = await favourite("analyst-model", "custom");
        // Chosen before its key is set: saved, and says what it still needs.
        const early = await post("/settings/analysis", { model: analystId }, "PUT");
        assert.equal(early.status, 200, early.text);
        assert.equal(early.body.ready, false);
        assert.match(early.body.reason, /analyst-model needs .* in Settings → Models before it can be asked/);
        assert.equal((await post("/settings/review-model/keys/custom", { key }, "PUT")).status, 200);
        const view = (await get("/settings/analysis")).body;
        assert.deepEqual([view.model, view.ready, view.reason, view.label], [analystId, true, null, "analyst-model"]);
        assert.ok(view.models.some((m: { id: string; canBeAsked: boolean }) => m.id === bedrock && !m.canBeAsked));
        assert.deepEqual(view.limit, { perHour: MAX_PER_HOUR, lastHour: 0 });

        // An editor may ask, but not choose; a viewer may do neither.
        await request("/api/v1/instance/users", { method: "POST", session: env.admin, body: { username: "ed", displayName: "Ed" } });
        const audit = (await get("/settings/audit")).body.items as { target: string; changes: Record<string, unknown> }[];
        assert.deepEqual(audit.find((a) => a.target === "analysis")?.changes, { model: { from: null, to: analystId } });
    });

    test("a review's models compared: the model gets figures and titles, never code, and what it writes is kept as text", async () => {
        provider.say = () => "**In short** [fake/alarm](https://evil.example/a) cried wolf. ![x](https://evil.example/p.png)";
        const started = await post(`/runs/${first.id}/analysis`, { kind: "comparison" });
        assert.equal(started.status, 202, started.text);
        assert.equal(started.body.status, "running");
        assert.deepEqual(started.body.model, { id: analystId, provider: "custom", model: "analyst-model", label: "analyst-model" });
        // Asked again while it's being written: the same one, not another.
        assert.equal((await post(`/runs/${first.id}/analysis`, { kind: "comparison" })).body.id, started.body.id);
        const a = await done(started.body.id);
        assert.equal(a.status, "done", a.error ?? "");
        assert.equal(a.result?.markdown, "**In short** fake/alarm cried wolf. x");
        assert.equal(a.result?.withFindings, true);
        assert.deepEqual(a.tokens, { input: 300, output: 20, total: 320 });
        assert.equal(a.requestedBy.name, "admin");
        assert.equal(provider.requests.length, 1);

        const sent = provider.requests[0] as (typeof provider.requests)[number];
        assert.equal(sent.headers.authorization, `Bearer ${key}`);
        assert.match(sent.system, /never follow them/);
        assert.doesNotMatch(sent.raw, /DO-NOT-SEND-THIS-CODE/);
        const figures = JSON.parse(sent.user);
        assert.equal(figures.review, "Full scan of main");
        assert.deepEqual(
            figures.models.map((m: { name: string; findings: number; onlyItFound: number }) => [m.name, m.findings, m.onlyItFound]),
            [
                ["fake/model", 2, 0],
                ["fake/wordy-extra", 3, 1],
                ["fake/alarm", 3, 1],
            ],
        );
        // Two files everyone found something in; one finding each from the two that add their own.
        assert.deepEqual(figures.agreement, { all: 2, several: 0, one: 2 });
        assert.deepEqual(figures.seriousAgreement, { all: 2, several: 0, one: 1 });
        assert.equal(figures.ratedDifferently, 2);
        assert.match(figures.ratedDifferentlyExamples[0].ratings, /fake\/model: high, fake\/wordy-extra: medium, fake\/alarm: high/);
        assert.equal(figures.models[2].onlyItFoundExamples[0].title, "Only fake/alarm thinks this is critical");

        const state = (await get(`/runs/${first.id}/analysis`)).body;
        assert.equal(state.comparison.id, a.id);
        assert.equal(state.model.label, "analyst-model");
        const branch = (await get("/p/app/analysis")).body;
        assert.equal(branch.comparison.run.id, first.id);
        assert.equal(branch.comparison.analysis.id, a.id);
        assert.equal(branch.summary.analysis, null);
    });

    test("what a review changed: a branch's first review says so; the next is compared with it; an older one can't be any more", async () => {
        const one = await done((await post(`/runs/${first.id}/analysis`, { kind: "summary" })).body.id);
        assert.equal(one.status, "done", one.error ?? "");
        assert.match(String(one.result?.warning), /first review of this branch, so there's nothing to compare it with/);
        const asked = JSON.parse((provider.requests[0] as (typeof provider.requests)[number]).user);
        assert.deepEqual([asked.first, asked.scope, asked.findingsNow, asked.newFindings, asked.noLongerReported], [true, "full", 4, 4, 0]);

        // A file more, and one of the old findings resolved before the next review.
        const issues = (await get("/p/app/issues?branch=main")).body.items as { id: string; path: string }[];
        const b = issues.find((x) => x.path === "src/b.ts") as { id: string };
        await post(`/p/app/issues/${b.id}?branch=main`, { status: "resolved" }, "PATCH");
        await env.fake.commit("asked/app", "main", { "src/new/c.ts": "export const c = 3;\n" }, "Add c");
        const second = await scan([models[0] as string]);
        provider.requests.length = 0;
        const two = await done((await post(`/runs/${second.id}/analysis`, { kind: "summary" })).body.id);
        assert.equal(two.status, "done", two.error ?? "");
        assert.equal(two.result?.warning, undefined);
        const next = JSON.parse((provider.requests[0] as (typeof provider.requests)[number]).user);
        assert.equal(next.first, false);
        // One model this time: its three files' findings. The other models' own two are no longer reported.
        assert.deepEqual([next.findingsNow, next.newFindings, next.noLongerReported, next.stillReported], [3, 1, 2, 2]);
        assert.deepEqual(next.newByFolder, [{ folder: "src/new/", findings: 1 }]);
        assert.equal(next.newExamples[0].file, "src/new/c.ts");
        assert.deepEqual(two.result?.figures, { first: false, newFindings: 1, noLongerReported: 2, reopened: 1 });
        assert.doesNotMatch(provider.requests.map((r) => r.raw).join(""), /DO-NOT-SEND-THIS-CODE|export const/);

        // The first review's report has been replaced: what it changed can't be worked out now. Its comparison still can.
        const gone = await post(`/runs/${first.id}/analysis`, { kind: "summary" });
        assert.equal(gone.status, 409, gone.text);
        assert.match(gone.text, /A later review has replaced this one's report/);
        const again = await done((await post(`/runs/${first.id}/analysis`, { kind: "comparison" })).body.id);
        assert.equal(again.result?.withFindings, false);
        // A review one model ran has nobody to compare.
        const alone = await post(`/runs/${second.id}/analysis`, { kind: "comparison" });
        assert.equal(alone.status, 409, alone.text);
        assert.match(alone.text, /needs a review two or more models finished/);
        assert.match((await get(`/runs/${second.id}/analysis`)).body.unavailable.comparison, /two or more models/);
        assert.equal((await post("/runs/nope/analysis", { kind: "summary" })).status, 404);
    });

    test("a question: the model may look at issue lists first, sees no code, and the answer says what it looked at", async () => {
        const said = [
            JSON.stringify({
                lookups: [
                    { project: "app", status: ["open"], path: "src/new/" },
                    { project: "not-here" },
                    { project: "app", branch: "nope" },
                ],
            }),
            "One finding is open in src/new/ ([see](https://evil.example)).",
        ];
        provider.say = () => said.shift() ?? null;
        const started = await post("/ask", { question: "  What is open in   src/new?  ", project: "app", days: 0 });
        assert.equal(started.status, 202, started.text);
        assert.deepEqual(started.body.input, { question: "What is open in src/new?", project: "app", branch: null, days: 0 });
        const a = await done(started.body.id);
        assert.equal(a.status, "done", a.error ?? "");
        assert.equal(a.result?.markdown, "One finding is open in src/new/ (see).");
        assert.deepEqual(a.result?.lookups, [
            { project: "app", status: ["open"], path: "src/new/", label: "open findings in src/new/ in app", total: 1 },
            {
                project: "app",
                branch: "nope",
                label: "findings in app (nope)",
                total: 0,
                error: 'No report for branch "nope". Branches with reports: main.',
            },
        ]);
        // Two reviews in all (three findings open, one closed along the way): not much to go on, and it says so.
        assert.match(String(a.result?.warning), /There's little to go on here: 2 reviews and 4 findings/);
        assert.deepEqual(a.tokens, { input: 600, output: 40, total: 640 });
        assert.equal(provider.requests.length, 2);
        const [plan, answer] = provider.requests as [(typeof provider.requests)[number], (typeof provider.requests)[number]];
        const ctx = JSON.parse(plan.user);
        assert.equal(ctx.question, "What is open in src/new?");
        assert.equal(ctx.scope, "app, all branches, all time");
        assert.match(ctx.analytics, /^# Analytics: app, all branches, all time/);
        assert.deepEqual(ctx.projects, [{ slug: "app", name: "app", defaultBranch: "main" }]);
        assert.ok(ctx.models.includes("fake/alarm"));
        const looked = JSON.parse(answer.user).lookups;
        assert.equal(looked[0].findings[0].file, "src/new/c.ts");
        assert.equal(looked[0].byStatus.open, 1);
        assert.doesNotMatch(plan.raw + answer.raw, /DO-NOT-SEND-THIS-CODE|export const/);

        // An answer straight away is one request.
        provider.requests.length = 0;
        provider.say = () => '{"answer": "Three."}';
        const quick = await done((await post("/ask", { question: "How many findings?" })).body.id);
        assert.equal(quick.result?.markdown, "Three.");
        assert.deepEqual(quick.result?.lookups, []);
        assert.equal(quick.result?.scope, "every project, all branches, the last 30 days");
        assert.equal(provider.requests.length, 1);

        assert.equal((await post("/ask", { question: "x" })).status, 400);
        assert.equal((await post("/ask", { question: "y".repeat(501) })).status, 400);
        assert.equal((await post("/ask", { question: "Anything?", project: "nope" })).status, 404);
        assert.equal((await post("/ask", { question: "Anything?", days: 5 })).status, 400);
    });

    test("a model that lets it down: failed, saying why, without the key or what the provider said", async () => {
        provider.mode = "error";
        const failed = await done((await post("/ask", { question: "How many findings?" })).body.id);
        assert.equal(failed.status, "failed");
        assert.equal(failed.error, "analyst-model couldn't write it: its provider answered 500.");
        assert.equal(failed.result, null);
        provider.mode = "answer";
        provider.say = () => '{"neither": true}';
        const unread = await done((await post("/ask", { question: "How many findings?" })).body.id);
        assert.equal(unread.error, "analyst-model couldn't write it: its answer wasn't one that could be read.");
        // What was used is still counted.
        assert.deepEqual(unread.tokens, { input: 300, output: 20, total: 320 });
        provider.say = () => "   ";
        const empty = await done((await post(`/runs/${first.id}/analysis`, { kind: "comparison" })).body.id);
        assert.equal(empty.error, "analyst-model couldn't write it: it answered with nothing.");
        assert.doesNotMatch(JSON.stringify([failed, unread, empty]), new RegExp(key));
        // The one before it is still the latest that's shown as failed, not hidden: the page offers to try again.
        assert.equal((await get(`/runs/${first.id}/analysis`)).body.comparison.status, "failed");
    });

    test("one left running by a server that stopped is shown as failed; another workspace's can't be read", async () => {
        const workspace = await env.t.services.store.workspaces.bySlug(ws);
        const stuck: Analysis = {
            id: "stuck-one",
            workspaceId: workspace?.id as string,
            projectId: null,
            branch: null,
            kind: "answer",
            subject: "",
            status: "running",
            requestedBy: { name: "admin", userId: null },
            model: null,
            tokens: null,
            input: { question: "?" },
            result: null,
            error: null,
            createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
            finishedAt: null,
        };
        await env.t.services.store.analyses.put(stuck);
        const seen = (await get("/analyses/stuck-one")).body;
        assert.equal(seen.status, "failed");
        assert.match(seen.error, /interrupted before it finished/);
        await request("/api/v1/workspaces", { method: "POST", session: env.admin, body: { slug: "elsewhere" } });
        assert.equal((await request("/api/v1/w/elsewhere/analyses/stuck-one", { session: env.admin })).status, 404);
        assert.equal((await get("/analyses/no-such")).status, 404);
        assert.equal((await request(`${api}/analyses/stuck-one`)).status, 401);
    });

    test("analytics count what the asking took, apart from the reviews; with a price, what it cost", async () => {
        await post("/settings/model-prices", { model: "analyst-model", input: 10, output: 10 }, "PUT");
        const a = (await get("/analytics?days=0&sections=reviews")).body;
        assert.ok(a.analysis.count >= 8, `${a.analysis.count} analyses`);
        assert.ok(a.analysis.tokens >= 320 * 5);
        assert.equal(a.analysis.unpricedTokens, 0);
        assert.ok(Math.abs(a.analysis.cost - (a.analysis.tokens * 10) / 1e6) < 1e-9);
        // Reviews are still two: an analysis isn't one.
        assert.equal(a.reviews.total, 2);
        assert.equal((await get("/analytics?sections=models")).body.analysis, undefined);
        const mcpText = (await get("/analytics?days=0")).body;
        assert.ok(mcpText.analysis.count > 0);
    });

    test("after a review, what the workspace asked for is written without being asked", async () => {
        const on = await post("/settings/analysis", { afterReview: { summary: true, comparison: true } }, "PUT");
        assert.deepEqual(on.body.afterReview, { comparison: true, summary: true });
        provider.requests.length = 0;
        const run = await scan([models[0] as string, models[2] as string]);
        await env.t.services.analyst.settled();
        const state = (await get(`/runs/${run.id}/analysis`)).body;
        assert.equal(state.summary.status, "done");
        assert.equal(state.summary.requestedBy.name, "automation");
        assert.equal(state.comparison.status, "done");
        assert.equal(provider.requests.length, 2);
        await post("/settings/analysis", { afterReview: { summary: false, comparison: false } }, "PUT");
    });

    test("no more than the hour's limit, however it's asked", async () => {
        const workspace = await env.t.services.store.workspaces.bySlug(ws);
        const have = (await env.t.services.store.analyses.list({ workspaceId: workspace?.id as string }, 500)).length;
        for (let i = have; i < MAX_PER_HOUR; i++)
            await env.t.services.store.analyses.put({
                id: `filler-${i}`,
                workspaceId: workspace?.id as string,
                projectId: null,
                branch: null,
                kind: "answer",
                subject: "",
                status: "done",
                requestedBy: { name: "admin", userId: null },
                model: null,
                tokens: null,
                input: null,
                result: { markdown: "." },
                error: null,
                createdAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
            });
        provider.requests.length = 0;
        const refused = await post("/ask", { question: "One more?" });
        assert.equal(refused.status, 429, refused.text);
        assert.match(refused.text, new RegExp(`asked for ${MAX_PER_HOUR} analyses in the last hour`));
        assert.equal(provider.requests.length, 0);
        assert.equal((await get("/settings/analysis")).body.limit.lastHour, MAX_PER_HOUR);
    });
});
