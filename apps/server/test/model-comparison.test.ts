// Comparing a review's models without asking a model: what each one adds (and what dropping it would
// save), where they disagreed, and the figures of a review run with several (its time, and its cost when
// some of its models have no price).

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { analyse, type PricedModel } from "../src/domain/analytics.ts";
import { disagreements } from "../src/domain/disagreements.ts";
import { parseReport } from "../src/domain/report.ts";
import type { FindingSource, ReviewDetails, ReviewRecord } from "../src/store/types.ts";
import { ADMIN_PASSWORD, type Session, type TestApp, testApp } from "./helpers.ts";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const AT = "2026-10-07T10:00:00.000Z";

let seq = 0;
const review = (model: string, details: ReviewDetails, over: Partial<ReviewRecord> = {}): ReviewRecord => ({
    id: `r${++seq}`,
    workspaceId: "w1",
    projectId: "p1",
    branch: "main",
    at: AT,
    source: "run",
    kind: "full",
    status: "done",
    model,
    provider: "openrouter",
    keySource: "workspace",
    tokens: { input: 1_000_000, output: 0, cacheRead: 0, total: 1_000_000 },
    ...over,
    details,
});

const source = (over: Partial<FindingSource>): FindingSource => ({
    workspaceId: "w1",
    projectId: "p1",
    branch: "main",
    findingId: "f1",
    model: "a/one",
    provider: "openrouter",
    label: "One",
    scanId: "scan-1",
    scanModels: 3,
    severity: "medium",
    firstSeenAt: AT,
    outcome: null,
    decidedAt: null,
    ...over,
});

const price = (model: string): PricedModel | null =>
    model === "a/one" ? { input: 2, output: 2, cacheRead: null, source: "workspace" } : null;

const run = (history: ReviewRecord[], sources: FindingSource[] = [], priced = price) =>
    analyse({ now: NOW, days: 7, branch: null, history, activity: [], current: [], sources, price: priced, projectSlug: () => "app" });

/** A review of three models that started an hour before it ended: they took 10, 20 and 60 minutes. */
const three = (id = "scan-1"): ReviewRecord[] => {
    const scan = (lead: boolean) => ({ id, models: ["One", "Two", "Three"], lead, status: "done" as const, findings: 30 });
    const common = { startedAt: "2026-10-07T09:00:00.000Z", jobId: id };
    return [
        review("a/one", {
            ...common,
            runSeconds: 600,
            scan: scan(true),
            findings: { total: 20, bySeverity: { critical: 0, high: 0, medium: 20, low: 0 } },
        }),
        review("b/two", { ...common, runSeconds: 1200, scan: scan(false) }),
        review("c/three", { ...common, runSeconds: 3600, scan: scan(false) }),
    ];
};

describe("a review run with several models, as one review", () => {
    test("it took from its start to its end, not its models' times added up", () => {
        const r = run(three()).reviews;
        assert.equal(r?.total, 1);
        assert.deepEqual(r?.runSeconds, { median: 3600, p90: 3600, recorded: 1 });
        assert.equal(r?.latest[0]?.runSeconds, 3600);
        // Each model's own time is still its own.
        assert.equal(r?.byModel.find((g) => g.key === "b/two")?.medianRunSeconds, 1200);
    });

    test("a model run again later adds its own time; a record that doesn't say when it started adds the models' up", () => {
        const again = review("b/two", {
            startedAt: "2026-10-07T11:00:00.000Z",
            runSeconds: 300,
            attempt: 2,
            scan: { id: "scan-1", models: ["One", "Two", "Three"], lead: false, status: "done", findings: 30 },
        });
        assert.equal(run([...three(), again]).reviews?.runSeconds.median, 3900);
        const old = three().map((r) => ({ ...r, details: { ...r.details, startedAt: undefined } }) as ReviewRecord);
        assert.equal(run(old).reviews?.runSeconds.median, 5400);
    });

    test("with a price for some of its models only, its cost is a floor: counted in the total, and in no average", () => {
        const whole = review("a/one", { findings: { total: 4, bySeverity: { critical: 0, high: 0, medium: 4, low: 0 } } }, { kind: "pr" });
        const r = run([...three(), whole]).reviews;
        // One model of three has a price: $2 of the review's cost is known. The other review cost $2, all known.
        assert.equal(r?.cost.total, 4);
        assert.equal(r?.cost.partlyPriced, 1);
        assert.equal(r?.cost.pricedReviews, 1);
        assert.equal(r?.cost.perReview, 2);
        assert.equal(r?.cost.perFinding, 0.5);
        assert.deepEqual(
            r?.latest.map((x) => [x.kind, x.cost, x.costPartial]),
            [
                ["pr", 2, false],
                ["full", 2, true],
            ],
        );
        assert.equal(r?.byKind.find((g) => g.key === "full")?.costPerFinding, null);
        assert.equal(r?.byKind.find((g) => g.key === "pr")?.costPerFinding, 0.5);

        // Nothing but that review: there's a total to show, and nothing to average.
        const only = run(three()).reviews;
        assert.equal(only?.cost.total, 2);
        assert.equal(only?.cost.perReview, null);
        assert.equal(only?.cost.perFinding, null);
        // Every model priced: it's whole again.
        const all = run(three(), [], () => ({ input: 2, output: 2, cacheRead: null, source: "workspace" })).reviews;
        assert.equal(all?.cost.partlyPriced, 0);
        assert.equal(all?.cost.perReview, 6);
        assert.equal(all?.cost.perFinding, 0.2);
    });
});

describe("what a review would have been without each model", () => {
    test("the findings only it found (the serious ones, and those accepted), and how much sooner the review would have ended", () => {
        const sources = [
            // Everyone found it.
            source({ findingId: "f1" }),
            source({ findingId: "f1", model: "b/two", label: "Two" }),
            source({ findingId: "f1", model: "c/three", label: "Three" }),
            // Only One: a critical since fixed, a high still open, a low dismissed.
            source({ findingId: "f2", severity: "critical", outcome: "accepted" }),
            source({ findingId: "f3", severity: "high" }),
            source({ findingId: "f4", severity: "low", outcome: "rejected" }),
            // Only Three: a medium, fixed.
            source({ findingId: "f5", model: "c/three", label: "Three", outcome: "accepted" }),
            // A review One ran alone: nothing there is "only it found", for there was nobody else to find it.
            source({ findingId: "f6", severity: "critical", scanId: "alone", scanModels: 1 }),
        ];
        const alone = review("a/one", { runSeconds: 100 });
        const m = run([...three(), alone], sources).models;
        const row = (key: string) => m?.rows.find((r) => r.key === key);
        assert.equal(row("a/one")?.unique, 3);
        assert.deepEqual(row("a/one")?.without, { reviews: 1, serious: 2, accepted: 1, slowestIn: 0, secondsSaved: 0, cost: 2 });
        assert.deepEqual(row("b/two")?.without, { reviews: 1, serious: 0, accepted: 0, slowestIn: 0, secondsSaved: 0, cost: null });
        // Three was the last to finish, 40 minutes after Two.
        assert.equal(row("c/three")?.unique, 1);
        assert.deepEqual(row("c/three")?.without, { reviews: 1, serious: 0, accepted: 1, slowestIn: 1, secondsSaved: 2400, cost: null });
    });

    test("a model whose time isn't known, or two that finished together, and nobody is said to have held the review up", () => {
        const untimed = three().map((r, i) => (i === 1 ? ({ ...r, details: { ...r.details, runSeconds: undefined } } as ReviewRecord) : r));
        assert.ok(run(untimed).models?.rows.every((r) => r.without.slowestIn === 0 && r.without.reviews === 1));
        const tied = three().map((r) => ({ ...r, details: { ...r.details, runSeconds: 600 } }));
        assert.ok(run(tied).models?.rows.every((r) => r.without.slowestIn === 0));
        // A review with one model has no "without".
        assert.deepEqual(run([review("a/one", { runSeconds: 5 })]).models?.rows[0]?.without, {
            reviews: 0,
            serious: 0,
            accepted: 0,
            slowestIn: 0,
            secondsSaved: 0,
            cost: null,
        });
    });
});

const comment = (path: string, line: number, over: Record<string, unknown> = {}) => ({
    path,
    content: `Problem at ${path}:${line}. More about it.`,
    severity: "medium",
    category: "bug",
    start_line: line,
    end_line: line + 1,
    found_by: ["One"],
    ...over,
});

const MODELS = ["One", "Two", "Three"];

/** A merged report as a review with three models leaves it. */
const merged = () => ({
    models: MODELS,
    project_summary: "",
    comments: [
        // Found by all three, rated critical, high and low.
        comment("src/a.ts", 10, {
            severity: "critical",
            found_by: MODELS,
            also: [
                { model: "Two", severity: "high", category: "bug", start_line: 10, content: "Two's words." },
                { model: "Three", severity: "low", category: "bug", start_line: 11, content: "Three's words." },
            ],
        }),
        // Found by two, rated the same: no disagreement.
        comment("src/a.ts", 40, {
            found_by: ["One", "Two"],
            also: [{ model: "Two", severity: "medium", category: "bug", content: "Same." }],
        }),
        // Two models at the same lines, filed differently: left apart.
        comment("src/b.ts", 20, { category: "security", severity: "high", found_by: ["One", "Three"] }),
        comment("src/b.ts", 21, { category: "bug", found_by: ["Two"] }),
        // Three lines on: still near. Seven on: not.
        comment("src/b.ts", 25, { category: "performance", severity: "low", found_by: ["Two"] }),
        comment("src/b.ts", 40, { category: "style", found_by: ["Three"] }),
        // Near each other, from the same model: never candidates.
        comment("src/c.ts", 5, { found_by: ["One"] }),
        comment("src/c.ts", 6, { category: "style", found_by: ["One"] }),
        // No lines, and one added by hand: nowhere to be near.
        { path: "src/b.ts", content: "About the whole file.", severity: "low", category: "other", found_by: ["Three"] },
        {
            ...comment("src/b.ts", 20),
            category: "test",
            found_by: undefined,
            added_by: "Alice",
            content: "Added by hand at the same lines.",
        },
    ],
});

describe("where a review's models disagreed", () => {
    test("the same finding rated differently, the widest apart first", () => {
        const review = parseReport(merged(), null);
        const d = disagreements(review.issues, review.meta.models);
        assert.deepEqual(d.models, MODELS);
        assert.equal(d.rated.total, 1);
        assert.deepEqual(d.rated.items[0]?.ratings, [
            { model: "One", severity: "critical", category: "bug" },
            { model: "Two", severity: "high", category: "bug" },
            { model: "Three", severity: "low", category: "bug" },
        ]);
        assert.equal(d.rated.items[0]?.spread, 3);
        assert.equal(d.rated.items[0]?.path, "src/a.ts");
    });

    test("findings from different models within a few lines that weren't merged, the closest and most serious first", () => {
        const review = parseReport(merged(), null);
        const d = disagreements(review.issues, review.meta.models);
        // Overlapping, and filed as security by two models and as a bug by the third; the more serious side first.
        assert.deepEqual(
            d.apart.items.map((p) => [p.path, p.gap, p.a.category, p.a.foundBy, p.b.category, p.b.foundBy]),
            [["src/b.ts", 0, "security", ["One", "Three"], "bug", ["Two"]]],
        );
        // Two's own two findings (21–22 and 25–26) are near each other too, but one model's findings are never one finding.
        // 20–21 (One, Three) and 25–26 (Two) are four lines apart: not near enough to be the same place.
        assert.equal(d.apart.total, 1);
        assert.equal(disagreements(review.issues, review.meta.models, 0).apart.total, 1);
        assert.equal(disagreements(review.issues, review.meta.models, 0).apart.items.length, 0);
    });

    test("a report from one model has nothing to disagree about", () => {
        const one = parseReport({ comments: [comment("a.ts", 1, { found_by: undefined })] }, null);
        assert.deepEqual(disagreements(one.issues, one.meta.models), {
            models: null,
            rated: { total: 0, items: [] },
            apart: { total: 0, items: [] },
        });
    });
});

describe("the API", () => {
    let t: TestApp;
    let admin: Session;

    before(async () => {
        t = await testApp();
        admin = await t.signIn("admin", ADMIN_PASSWORD);
        await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "acme" } });
        await t.request("/api/v1/w/acme/projects", { method: "POST", session: admin, body: { slug: "app" } });
        await t.request("/api/v1/w/acme/projects", { method: "POST", session: admin, body: { slug: "solo" } });
        const up = await t.request("/api/v1/w/acme/p/app/reports", {
            method: "POST",
            session: admin,
            body: { branch: "main", report: merged() },
        });
        assert.equal(up.status, 200, up.text);
    });

    test("a branch's disagreements, each finding with where triage has got to", async () => {
        const res = await t.request("/api/v1/w/acme/p/app/disagreements", { session: admin });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.body.branch, "main");
        assert.deepEqual(res.body.models, MODELS);
        assert.equal(res.body.rated.total, 1);
        assert.equal(res.body.rated.items[0].status, "open");
        assert.equal(res.body.apart.total, 1);
        const pair = res.body.apart.items[0];
        assert.deepEqual([pair.a.status, pair.b.status], ["open", "open"]);

        // One of the pair is marked a duplicate of the other: it's dealt with, and says so.
        const done = await t.request(`/api/v1/w/acme/p/app/issues/${pair.b.id}?branch=main`, {
            method: "PATCH",
            session: admin,
            body: { duplicateOf: pair.a.id },
        });
        assert.equal(done.status, 200, done.text);
        const after = await t.request("/api/v1/w/acme/p/app/disagreements?branch=main", { session: admin });
        assert.equal(after.body.apart.items[0].b.status, "wont_fix");
    });

    test("a branch with no report, or one from a single model: nothing, not an error; an outsider gets 404", async () => {
        const none = await t.request("/api/v1/w/acme/p/solo/disagreements", { session: admin });
        assert.equal(none.status, 200, none.text);
        assert.equal(none.body.models, null);
        assert.equal(none.body.apart.total, 0);
        assert.equal((await t.request("/api/v1/w/acme/p/app/disagreements")).status, 401);
    });
});
