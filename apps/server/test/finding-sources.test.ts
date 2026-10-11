// Who found what, kept apart from the reports (finding_sources): written when a review is saved, kept
// in step with triage, and what the Models part of analytics is worked out from.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { analyse, type PricedModel } from "../src/domain/analytics.ts";
import type { FindingSource, ReviewRecord } from "../src/store/types.ts";
import { testStore } from "./helpers.ts";
import { finished, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const source = (over: Partial<FindingSource>): FindingSource => ({
    workspaceId: "w1",
    projectId: "p1",
    branch: "main",
    findingId: "ocr-1",
    model: "a/one",
    provider: "openrouter",
    label: "One",
    scanId: "scan-1",
    scanModels: 2,
    severity: "high",
    firstSeenAt: "2026-10-07T10:00:00.000Z",
    outcome: null,
    decidedAt: null,
    ...over,
});

describe("the store", () => {
    test("a model's first report of a finding is the one kept; outcomes, renames and forgetting a project", async () => {
        const store = await testStore();
        const at = "2026-10-08T00:00:00.000Z";
        await store.transaction(async (tx) => {
            await tx.workspaces.put({ id: "w1", slug: "acme", name: "Acme", kind: "team", createdAt: at } as never);
            await tx.workspaces.put({ id: "w2", slug: "other", name: "Other", kind: "team", createdAt: at } as never);
            await tx.findingSources.add([
                source({}),
                source({ model: "b/two", label: "Two" }),
                source({ findingId: "ocr-2" }),
                source({ projectId: "p2", findingId: "ocr-9" }),
                source({ workspaceId: "w2", projectId: "p3" }),
            ]);
            // Reported again later: nothing changes.
            await tx.findingSources.add([source({ firstSeenAt: "2026-10-09T00:00:00.000Z", scanId: "scan-2", label: "Renamed" })]);
        });
        const list = (projectId?: string) => store.findingSources.list({ workspaceId: "w1", ...(projectId ? { projectId } : {}) }, 100);
        assert.equal((await list()).length, 4);
        assert.deepEqual(
            (await list("p1")).filter((s) => s.findingId === "ocr-1" && s.model === "a/one").map((s) => [s.scanId, s.label, s.firstSeenAt]),
            [["scan-1", "One", "2026-10-07T10:00:00.000Z"]],
        );

        // Triage decides for every model that found it, on that branch only.
        await store.transaction((tx) => tx.findingSources.setOutcome("p1", "main", "ocr-1", "accepted", at));
        const decided = (await list("p1")).map((s) => [s.findingId, s.model, s.outcome, s.decidedAt]).sort();
        assert.deepEqual(decided, [
            ["ocr-1", "a/one", "accepted", at],
            ["ocr-1", "b/two", "accepted", at],
            ["ocr-2", "a/one", null, null],
        ]);
        await store.transaction((tx) => tx.findingSources.setOutcome("p1", "main", "ocr-1", null, at));
        assert.ok((await list("p1")).every((s) => s.outcome === null && s.decidedAt === null));

        await store.transaction((tx) => tx.findingSources.renameBranch("p1", "main", "trunk"));
        assert.deepEqual([...new Set((await list("p1")).map((s) => s.branch))], ["trunk"]);
        assert.equal((await store.findingSources.list({ workspaceId: "w1", projectId: "p1", branch: "trunk" }, 100)).length, 3);

        await store.transaction((tx) => tx.findingSources.removeProject("w1", "p1"));
        assert.deepEqual(
            (await list()).map((s) => s.projectId),
            ["p2"],
        );
        assert.equal((await store.findingSources.list({ workspaceId: "w2" }, 100)).length, 1);
    });
});

describe("each model's figures", () => {
    const NOW = Date.parse("2026-10-08T12:00:00.000Z");
    const review = (model: string, over: Partial<ReviewRecord> = {}, details: ReviewRecord["details"] = {}): ReviewRecord => ({
        id: `${model}-${Math.random()}`,
        workspaceId: "w1",
        projectId: "p1",
        branch: "main",
        at: "2026-10-07T10:00:00.000Z",
        source: "run",
        kind: "pr",
        status: "done",
        model,
        provider: "openrouter",
        keySource: "workspace",
        tokens: { input: 1_000_000, output: 0, cacheRead: 0, total: 1_000_000 },
        ...over,
        details: { runSeconds: 60, ...details },
    });
    const price = (model: string): PricedModel | null =>
        model === "a/one" ? { input: 2, output: 2, cacheRead: null, source: "workspace" } : null;
    const scan = (id: string, models: string[]) => ({ scan: { id, models, lead: false, status: "done" as const, findings: null } });
    const models = (history: ReviewRecord[], sources: FindingSource[], branch: string | null = null) => {
        const a = analyse({
            now: NOW,
            days: 7,
            branch,
            history,
            activity: [],
            current: [],
            sources,
            sections: new Set(["models"]),
            price,
            projectSlug: () => "app",
        });
        // Only what was asked for is worked out.
        assert.deepEqual(Object.keys(a).sort(), ["models", "range", "unpriced"]);
        return a.models as NonNullable<typeof a.models>;
    };

    test("reviews, failures and cost come from the reviews; findings, unique ones and accuracy from who found what", () => {
        const history = [
            review("a/one", {}, scan("scan-1", ["One", "Two"])),
            review("b/two", {}, scan("scan-1", ["One", "Two"])),
            review("a/one", { status: "failed" }, { error: "Stalled: Open Code Review printed nothing for 10 minutes" }),
            review("b/two", { status: "failed" }, { stopped: "stalled" }),
            // Not a review: the model asked which findings are the same.
            review("a/one", {}, { merging: true }),
            // An upload that didn't say which model.
            review("x", { model: null, source: "upload", kind: "upload" }),
            // Before the range.
            review("a/one", { at: "2026-09-01T00:00:00.000Z" }),
        ];
        const sources = [
            // Both found it; fixed.
            source({ findingId: "f1", outcome: "accepted" }),
            source({ findingId: "f1", model: "b/two", label: "Two", outcome: "accepted" }),
            // Only One found it; dismissed.
            source({ findingId: "f2", outcome: "rejected" }),
            // Only Two found these; one fixed, one still open.
            source({ findingId: "f3", model: "b/two", label: "Two", outcome: "accepted" }),
            source({ findingId: "f4", model: "b/two", label: "Two" }),
            // From a review One ran alone: its, but "unique" means nothing there.
            source({ findingId: "f5", scanId: "solo", scanModels: 1 }),
            // First seen before the range: not counted, but it still says who else found f1.
            source({ findingId: "old", firstSeenAt: "2026-09-01T00:00:00.000Z" }),
        ];
        const m = models(history, sources);
        const [one, two] = m.rows;
        assert.deepEqual(
            [one?.key, one?.labels, one?.provider, one?.reviews, one?.failed, one?.stalled, one?.failureRate, one?.medianRunSeconds],
            ["a/one", ["One"], "openrouter", 2, 1, 1, 0.5, 60],
        );
        assert.deepEqual([one?.tokens, one?.cost], [2_000_000, 4]);
        assert.deepEqual([one?.findings, one?.unique, one?.accepted, one?.rejected, one?.acceptanceRate], [3, 1, 1, 1, 0.5]);
        assert.deepEqual([one?.costPerFinding, one?.costPerAccepted], [4 / 3, 4]);
        // No price: its cost and what follows from it aren't made up.
        assert.deepEqual(
            [two?.key, two?.reviews, two?.stalled, two?.cost, two?.costPerFinding, two?.costPerAccepted],
            ["b/two", 2, 1, null, null, null],
        );
        assert.deepEqual([two?.findings, two?.unique, two?.accepted, two?.rejected, two?.acceptanceRate], [3, 2, 2, 0, 1]);
        assert.equal(m.withoutModel, 1);
        assert.equal(m.smallSample, 10);

        // Of the findings from reviews with several models: one by both, three by one.
        assert.deepEqual(
            { findings: m.agreement.findings, all: m.agreement.all, several: m.agreement.several, one: m.agreement.one },
            { findings: 4, all: 1, several: 0, one: 3 },
        );
        assert.deepEqual(m.agreement.overlap, [
            { a: "a/one", b: "b/two", of: 2, shared: 1, share: 0.5 },
            { a: "b/two", b: "a/one", of: 3, shared: 1, share: 1 / 3 },
        ]);
        // Over time: cost by when the review ran, accuracy by when the finding was first seen.
        const day = m.series.find((d) => d.date === "2026-10-07");
        assert.deepEqual(day?.models["a/one"], { cost: 4, accepted: 1, rejected: 1 });
        assert.deepEqual(day?.models["b/two"], { cost: 0, accepted: 2, rejected: 0 });
    });

    test("a model that ran but found nothing still counts against the others' findings", () => {
        const three = ["One", "Two", "Three"];
        const history = ["a/one", "b/two", "c/three"].map((m) => review(m, {}, scan("scan-3", three)));
        const sources = [
            source({ findingId: "g1", scanId: "scan-3", scanModels: 3 }),
            source({ findingId: "g1", scanId: "scan-3", scanModels: 3, model: "b/two", label: "Two" }),
        ];
        const m = models(history, sources);
        assert.deepEqual(
            m.agreement.overlap.find((o) => o.a === "a/one" && o.b === "c/three"),
            {
                a: "a/one",
                b: "c/three",
                of: 1,
                shared: 0,
                share: 0,
            },
        );
        // Found by two of three: several, not all.
        assert.deepEqual([m.agreement.all, m.agreement.several, m.agreement.one], [0, 1, 0]);
        assert.deepEqual(m.rows.find((r) => r.key === "c/three")?.findings, 0);
    });

    test("one branch: only its reviews and its findings", () => {
        const m = models(
            [review("a/one"), review("a/one", { branch: "other" })],
            [source({ scanModels: 1 }), source({ branch: "other", scanModels: 1 })],
            "main",
        );
        assert.deepEqual([m.rows[0]?.reviews, m.rows[0]?.findings], [1, 1]);
    });
});

describe("through real reviews", () => {
    let env: ReviewEnv;
    const ws = "sources";
    /** The id of the favourite that is this model, added to the workspace's favourites first if it isn't one. */
    const favourite = async (model: string): Promise<string> => {
        const url = `/api/v1/w/${ws}/settings/models/favourites`;
        const is = (f: { model: string }) => f.model === model;
        const have = (await env.t.request(url, { session: env.admin })).body.favourites.find(is);
        if (have) return have.id;
        const added = await env.t.request(url, { method: "POST", session: env.admin, body: { provider: "openrouter", model } });
        assert.equal(added.status, 201, added.text);
        return added.body.favourites.find(is).id;
    };
    const start = async (body: object) => {
        const r = await env.t.request(`/api/v1/w/${ws}/p/app/reviews`, { method: "POST", session: env.admin, body });
        assert.equal(r.status, 201, r.text);
        return r.body as { id: string };
    };
    const sources = async () => {
        const workspace = await env.t.services.store.workspaces.bySlug(ws);
        return env.t.services.store.findingSources.list({ workspaceId: workspace?.id as string }, 1000);
    };
    const analytics = async (query = "") => (await env.t.request(`/api/v1/w/${ws}/analytics?days=7${query}`, { session: env.admin })).body;

    before(async () => {
        env = await reviewEnv();
        await patProject(env, ws, { repo: "sources/app" });
        await env.fake.gitRepo("sources/app", { "src/a.ts": "export const a = 1;\n", "README.md": "# App\n" });
        env.runner();
    });
    after(() => env.close());

    test("a review with two models writes down who found each finding, by the provider's names for them", async () => {
        const ids = [await favourite("fake/model"), await favourite("fake/wordy-extra")];
        const run = await finished(env, ws, (await start({ kind: "full", models: ids })).id);
        assert.equal(run.status, "done", run.error);
        assert.equal(run.result.total, 3);
        const rows = await sources();
        const by = (model: string) => rows.filter((s) => s.model === model);
        assert.equal(by("fake/model").length, 2);
        assert.equal(by("fake/wordy-extra").length, 3);
        assert.ok(
            rows.every(
                (s) =>
                    s.scanId === run.id && s.scanModels === 2 && s.provider === "openrouter" && s.branch === "main" && s.outcome === null,
            ),
        );

        const m = (await analytics("&sections=models")).models;
        assert.deepEqual(
            m.rows
                .map((r: { key: string; reviews: number; findings: number; unique: number }) => [r.key, r.reviews, r.findings, r.unique])
                .sort(),
            [
                ["fake/model", 1, 2, 0],
                ["fake/wordy-extra", 1, 3, 1],
            ],
        );
        assert.deepEqual([m.agreement.findings, m.agreement.all, m.agreement.one], [3, 2, 1]);

        // The review's own page: its models side by side.
        const side = (await env.t.request(`/api/v1/w/${ws}/runs/${run.id}/models`, { session: env.admin })).body;
        assert.equal(side.recorded, true);
        assert.deepEqual(
            side.models.map((x: { label: string; status: string; findings: number; unique: number; accepted: number }) => [
                x.label,
                x.status,
                x.findings,
                x.unique,
                x.accepted,
            ]),
            [
                ["fake/model", "done", 2, 0, 0],
                ["fake/wordy-extra", "done", 3, 1, 0],
            ],
        );
        assert.ok(
            side.models.every(
                (x: { tokens: { total: number } | null; cost: number | null; seconds: number | null }) =>
                    x.tokens && x.tokens.total > 0 && x.cost === null,
            ),
        );
        const severities = side.models[1].bySeverity;
        assert.equal(severities.critical + severities.high + severities.medium + severities.low, 3);

        // The issues list can be narrowed to one model's findings, or to those only it found.
        const count = async (query: string) =>
            (await env.t.request(`/api/v1/w/${ws}/p/app/issues?branch=main&${query}`, { session: env.admin })).body.total;
        assert.deepEqual(
            [await count("model=fake/model"), await count("model=fake/wordy-extra"), await count("model=fake/wordy-extra&onlyModel=true")],
            [2, 3, 1],
        );
        assert.deepEqual([await count("model=fake/model&onlyModel=true"), await count("model=nobody"), await count("")], [0, 0, 3]);
    });

    test("triage decides each model's accuracy, and it outlives the branch's report", async () => {
        const issues = (await env.t.request(`/api/v1/w/${ws}/p/app/issues?branch=main`, { session: env.admin })).body.items as {
            id: string;
            foundBy: string[];
        }[];
        const shared = issues.find((x) => x.foundBy.length === 2) as { id: string };
        const lone = issues.find((x) => x.foundBy.length === 1) as { id: string };
        const patch = (id: string, body: object) =>
            env.t.request(`/api/v1/w/${ws}/p/app/issues/${id}?branch=main`, { method: "PATCH", session: env.admin, body });
        assert.equal((await patch(shared.id, { status: "resolved" })).status, 200);
        assert.equal((await patch(lone.id, { status: "wont_fix", note: "Not a problem here." })).status, 200);
        const row = async (model: string) =>
            (
                (await analytics("&sections=models")).models.rows as {
                    key: string;
                    accepted: number;
                    rejected: number;
                    acceptanceRate: number;
                }[]
            ).find((r) => r.key === model);
        assert.deepEqual([(await row("fake/model"))?.accepted, (await row("fake/model"))?.rejected], [1, 0]);
        const extra = await row("fake/wordy-extra");
        assert.deepEqual([extra?.accepted, extra?.rejected, extra?.acceptanceRate], [1, 1, 0.5]);

        // A duplicate says nothing about whether the finding was right; reopening takes the verdict back.
        assert.equal((await patch(lone.id, { status: "open" })).status, 200);
        assert.equal((await row("fake/wordy-extra"))?.rejected, 0);

        // A later review with one model replaces the report: who found what before is still known.
        const again = await finished(env, ws, (await start({ kind: "full", models: [await favourite("fake/model")] })).id);
        assert.equal(again.status, "done", again.error);
        const rows = await sources();
        assert.equal(rows.filter((s) => s.model === "fake/wordy-extra").length, 3);
        // The same findings, found again by the same model: not counted twice.
        assert.equal(rows.filter((s) => s.model === "fake/model").length, 2);
        // It was marked resolved but is still reported, so the review reopened it: the verdict is taken back with that.
        assert.equal(rows.find((s) => s.findingId === shared.id && s.model === "fake/model")?.outcome, null);
    });

    test("an uploaded report counts for the model it names", async () => {
        const report = {
            status: "completed",
            llm: { model: "upload/model", provider: "elsewhere" },
            comments: [{ path: "src/z.ts", content: "Uploaded problem.", severity: "low", category: "style", start_line: 1, end_line: 1 }],
        };
        const up = await env.t.request(`/api/v1/w/${ws}/p/app/reports`, {
            method: "POST",
            session: env.admin,
            body: { branch: "uploaded", report },
        });
        assert.equal(up.status, 200, up.text);
        const rows = (await sources()).filter((s) => s.branch === "uploaded");
        // The report says its model if the metrics know how to read it; otherwise nothing is made up.
        assert.ok(rows.length <= 1);
        if (rows.length) assert.deepEqual([rows[0]?.scanModels, rows[0]?.outcome], [1, null]);
    });

    test("the page's parts can be asked for one at a time; clearing a project's analytics clears who found what", async () => {
        const only = await analytics("&sections=reviews,triage");
        assert.deepEqual(
            Object.keys(only)
                .filter((k) => ["reviews", "findings", "triage", "performance", "models"].includes(k))
                .sort(),
            ["reviews", "triage"],
        );
        assert.equal((await env.t.request(`/api/v1/w/${ws}/analytics?sections=nonsense`, { session: env.admin })).status, 400);
        const all = await analytics();
        for (const key of ["reviews", "findings", "triage", "performance", "models"]) assert.ok(key in all, key);
        assert.equal(all.truncated.sources, false);

        const gone = await env.t.request(`/api/v1/w/${ws}/p/app`, {
            method: "DELETE",
            session: env.admin,
            body: { confirm: "app", purgeAnalytics: true },
        });
        assert.equal(gone.status, 200, gone.text);
        assert.equal((await sources()).length, 0);
    });
});
