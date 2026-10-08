// Reviews run with several models: the project lists them, the runner reviews with each in turn, and
// the server merges their findings into one list for triage (who found what, and what the others said),
// while the review history keeps a record for each model, grouped by the scan, for analytics.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { distance, mergeReports, modelLabels } from "../src/domain/merge.ts";
import { parseReport } from "../src/domain/report.ts";
import { reviewGaps } from "../src/domain/review-run.ts";
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

    test("labels: the model's name, with its provider when two share it", () => {
        assert.deepEqual(
            modelLabels(
                [
                    { provider: "openrouter", model: "gpt-5" },
                    { provider: "openai", model: "gpt-5" },
                    { provider: "anthropic", model: "claude" },
                ],
                (id) => ({ openrouter: "OpenRouter", openai: "OpenAI" })[id] ?? id,
            ),
            ["gpt-5 (OpenRouter)", "gpt-5 (OpenAI)", "claude"],
        );
    });
});

describe("reviews with several models, end to end", () => {
    let env: ReviewEnv;
    const ws = "multi";
    const models = (list: { provider: string; model: string }[]) =>
        env.t.request(`/api/v1/w/${ws}/p/app/settings/automation`, { method: "PATCH", session: env.admin, body: { models: list } });
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

    test("the project's settings take up to three models, each once, from known providers", async () => {
        assert.equal((await models([{ provider: "nope", model: "x" }])).status, 400);
        const twice = await models([
            { provider: "openrouter", model: "fake/model" },
            { provider: "openrouter", model: "fake/model" },
        ]);
        assert.equal(twice.status, 400);
        assert.match(twice.text, /only be listed once/);
        const four = await models(["a", "b", "c", "d"].map((m) => ({ provider: "openrouter", model: `fake/${m}` })));
        assert.equal(four.status, 400);
    });

    test("each model reviews; their findings are merged, and each model's own record is kept", async () => {
        const set = await models([
            { provider: "openrouter", model: "fake/model" },
            { provider: "openrouter", model: "fake/wordy-extra" },
            { provider: "openrouter", model: "fake/fail" },
        ]);
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
        assert.ok(log.includes("[triagent] Model 2 of 3: fake/wordy-extra."), "the log says which model is reviewing");

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

    test("a listed model without a key keeps reviews waiting, saying which", async () => {
        assert.equal((await models([{ provider: "anthropic", model: "claude-test" }])).status, 200);
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
