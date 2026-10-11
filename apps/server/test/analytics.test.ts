// Analytics on seeded history, activity and current findings: every section, time buckets, medians and
// percentiles, and costs with and without prices. Then the API and MCP tool over a real app.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { Severity, Status, Via } from "@triagent/shared";
import { type AnalyticsInput, analyse, type CurrentFinding, costOf, folderOf, type PricedModel, rangeOf } from "../src/domain/analytics.ts";
import { LIMITS } from "../src/services/analytics.ts";
import type { ActivityRow, ReviewDetails, ReviewRecord } from "../src/store/types.ts";
import { ADMIN_PASSWORD, report, type Session, type TestApp, testApp } from "./helpers.ts";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const SONNET = "anthropic/claude-sonnet-4.5";

let seq = 0;
function review(at: string, over: Partial<ReviewRecord> & { details?: ReviewDetails }): ReviewRecord {
    return {
        id: `r${++seq}`,
        workspaceId: "w1",
        projectId: "p1",
        branch: "main",
        at,
        source: "run",
        kind: "pr",
        status: "done",
        model: SONNET,
        provider: "openrouter",
        keySource: "workspace",
        tokens: null,
        details: {},
        ...over,
    };
}

const tokens = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheRead, total: input + output });

const HISTORY: ReviewRecord[] = [
    review("2026-09-20T00:00:00.000Z", {
        source: "upload",
        kind: "upload",
        tokens: tokens(1000, 0),
        details: { addedIds: { high: ["i1", "i2"], low: ["i3"] } },
    }),
    review("2026-10-03T10:00:00.000Z", {
        tokens: tokens(1_000_000, 100_000, 400_000),
        details: {
            prNumber: 7,
            runSeconds: 120,
            queueSeconds: 10,
            ocrVersion: "1.4.0",
            findings: { total: 4, bySeverity: { critical: 1, high: 1, medium: 1, low: 1 } },
            files: { reviewed: 10, groups: 4, failedGroups: 0 },
            llm: { requests: 10, retries: 1, failures: 0 },
            toolCalls: { total: 20, failed: 2, byTool: { read: 15, grep: 5 }, failedByTool: { grep: 2 } },
            addedIds: { critical: ["i4"] },
        },
    }),
    review("2026-10-05T10:00:00.000Z", {
        status: "partial",
        tokens: tokens(500_000, 50_000),
        details: {
            prNumber: 7,
            runSeconds: 60,
            queueSeconds: 30,
            ocrVersion: "1.4.0",
            findings: { total: 2, bySeverity: { critical: 0, high: 2, medium: 0, low: 0 } },
            files: { groups: 4, failedGroups: 1 },
        },
    }),
    review("2026-10-06T10:00:00.000Z", {
        kind: "full",
        status: "failed",
        model: "mystery/model",
        tokens: tokens(1000, 0),
        details: { queueSeconds: 50 },
    }),
    review("2026-10-07T10:00:00.000Z", {
        source: "upload",
        kind: "upload",
        branch: "feature",
        model: null,
        provider: null,
        keySource: null,
        details: { findings: { total: 3, bySeverity: { critical: 0, high: 0, medium: 3, low: 0 } } },
    }),
];

let aseq = 0;
function event(at: string, actor: string, via: Via, itemId: string, changes: Record<string, unknown>, kind = "issue"): ActivityRow {
    return {
        id: `a${++aseq}`,
        workspaceId: "w1",
        projectId: "p1",
        branch: "main",
        at,
        actor,
        actorUserId: null,
        via,
        kind,
        itemId,
        changes,
    };
}
const status = (from: Status, to: Status) => ({ status: { from, to } });

const ACTIVITY: ActivityRow[] = [
    event("2026-10-01T12:00:00.000Z", "Alice", "web", "i1", status("open", "resolved")),
    event("2026-10-03T12:00:00.000Z", "admin", "web", "report.json", { uploaded: { added: 5, removed: 2 } }, "report"),
    event("2026-10-04T12:00:00.000Z", "Alice", "web", "i1", status("open", "resolved")),
    event("2026-10-04T13:00:00.000Z", "claude", "mcp", "i4", status("in_progress", "resolved")),
    event("2026-10-05T09:00:00.000Z", "bot", "token", "i2", { ...status("open", "wont_fix"), note: "Not worth it." }),
    event("2026-10-05T10:00:00.000Z", "admin", "web", "i3", { ...status("resolved", "open"), reopened: "still reported" }),
    event("2026-10-06T10:00:00.000Z", "Alice", "web", "i5", status("wont_fix", "open")),
    event("2026-10-06T11:00:00.000Z", "Alice", "web", "i2", { severity: { from: null, to: "low" }, category: { from: null, to: "style" } }),
    event("2026-10-07T08:00:00.000Z", "claude", "mcp", "i6", {
        ...status("open", "in_progress"),
        assignee: { from: null, to: "claude" },
        note: "On it.",
    }),
    event("2026-10-07T09:00:00.000Z", "claude", "mcp", "i6", { ...status("in_progress", "open"), assignee: { from: "claude", to: null } }),
    event("2026-10-07T10:00:00.000Z", "Alice", "web", "i7", {
        needsDiscussion: { from: false, to: true },
        duplicateOf: { from: null, to: "i1" },
    }),
    event("2026-10-07T11:00:00.000Z", "Alice", "web", "i99", status("open", "resolved")),
];

function finding(
    id: string,
    severity: Severity,
    path: string,
    category: string,
    st: Status,
    extra: Partial<CurrentFinding> = {},
): CurrentFinding {
    return { projectId: "p1", branch: "main", id, path, severity, category, status: st, assignee: null, needsDiscussion: false, ...extra };
}

const CURRENT: CurrentFinding[] = [
    finding("i1", "medium", "src/server/api/a.ts", "bug", "resolved"),
    finding("i2", "low", "src/server/api/a.ts", "style", "wont_fix"),
    finding("i3", "low", "src/web/b.tsx", "bug", "open"),
    finding("i5", "high", "src/web/b.tsx", "bug", "open"),
    finding("i6", "high", "README.md", "documentation", "open"),
    finding("i7", "critical", "src/server/db.ts", "security", "in_progress", { assignee: "Bob", needsDiscussion: true }),
];

const priced = (model: string): PricedModel | null =>
    model === SONNET ? { input: 3, output: 15, cacheRead: 0.3, source: "openrouter" } : null;

function run(over: Partial<AnalyticsInput> = {}) {
    // Newest first, as the store lists them.
    const history = [...HISTORY].sort((a, b) => b.at.localeCompare(a.at));
    const activity = [...ACTIVITY].reverse();
    return analyse({
        now: NOW,
        days: 7,
        branch: null,
        history,
        activity,
        current: CURRENT,
        price: priced,
        projectSlug: (id) => (id === "p1" ? "app" : null),
        ...over,
        // Every part, unless a test asks for some: so each is there to read.
    }) as Required<ReturnType<typeof analyse>>;
}

const close = (actual: number | null | undefined, expected: number) =>
    assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

describe("analytics on seeded data", () => {
    test("the range: a week of days, from midnight UTC six days ago", () => {
        const a = run();
        assert.equal(a.range.unit, "day");
        assert.equal(a.range.from, "2026-10-02T00:00:00.000Z");
        assert.deepEqual(a.range.buckets, [
            "2026-10-02",
            "2026-10-03",
            "2026-10-04",
            "2026-10-05",
            "2026-10-06",
            "2026-10-07",
            "2026-10-08",
        ]);
    });

    test("longer ranges are counted in weeks starting on Mondays; all time starts at the first record", () => {
        const q = rangeOf(90, NOW, null);
        assert.equal(q.unit, "week");
        assert.equal(q.buckets[0], "2026-07-06"); // the Monday of the week holding 11 July
        assert.equal(q.buckets.at(-1), "2026-10-05");
        assert.equal(new Date(`${q.buckets[1]}T00:00:00Z`).getUTCDay(), 1);
        const all = run({ days: 0 });
        assert.equal(all.range.from, "2026-09-20T00:00:00.000Z");
        assert.equal(all.range.unit, "day");
        assert.equal(all.range.buckets.length, 19);
        assert.equal(rangeOf(0, NOW, Date.parse("2025-01-01T00:00:00Z")).unit, "week");
    });

    test("reviews: outcomes, runs and uploads, run and queue times, tokens", () => {
        const r = run().reviews;
        assert.equal(r.total, 4);
        assert.deepEqual(r.byStatus, { done: 2, partial: 1, failed: 1, cancelled: 0 });
        assert.equal(r.runs, 3);
        assert.equal(r.uploads, 1);
        assert.deepEqual(r.runSeconds, { median: 90, p90: 114, recorded: 2 });
        assert.equal(r.queueSeconds.median, 30);
        close(r.queueSeconds.p90, 46);
        assert.deepEqual(r.tokens, {
            total: 1_651_000,
            input: 1_501_000,
            output: 150_000,
            cacheRead: 400_000,
            recorded: 3,
            estimated: 0,
            estimatedTotal: 0,
        });
        assert.equal(r.findings, 9);
        const day = (d: string) => r.series.find((s) => s.date === d);
        assert.deepEqual(day("2026-10-03"), {
            date: "2026-10-03",
            done: 1,
            partial: 0,
            failed: 0,
            cancelled: 0,
            tokens: 1_100_000,
            cost: 3.42,
        });
        assert.equal(day("2026-10-06")?.failed, 1);
        assert.equal(day("2026-10-02")?.done, 0);
        assert.equal(r.latest[0]?.branch, "feature");
        assert.equal(r.latest[0]?.project, "app");
        assert.equal(r.latest.length, 4);
    });

    test("costs: per review, per pull request and per finding, with cache reads at their own price", () => {
        const a = run();
        const c = a.reviews.cost;
        close(c.total, 3.42 + 2.25);
        assert.equal(c.pricedReviews, 2);
        close(c.perReview, (3.42 + 2.25) / 2);
        assert.equal(c.prs, 1);
        close(c.perPr, 5.67);
        close(c.perFinding, 5.67 / 6);
        assert.deepEqual(a.unpriced, [{ model: "mystery/model", reviews: 1, tokens: 1000 }]);
        const sonnet = a.reviews.byModel.find((g) => g.key === SONNET);
        assert.equal(sonnet?.reviews, 2);
        close(sonnet?.cost, 5.67);
        close(sonnet?.costPerFinding, 5.67 / 6);
        assert.equal(sonnet?.medianRunSeconds, 90);
        const unknown = a.reviews.byModel.find((g) => g.key === "(model not recorded)");
        assert.equal(unknown?.cost, null);
        assert.deepEqual(
            a.reviews.byKind.map((g) => [g.key, g.reviews]),
            [
                ["pr", 2],
                ["full", 1],
                ["upload", 1],
            ],
        );
    });

    test("costs without any prices: nothing is made up, and every model with tokens is listed", () => {
        const a = run({ price: () => null });
        assert.deepEqual(a.reviews.cost, { total: null, pricedReviews: 0, perReview: null, perPr: null, prs: 0, perFinding: null });
        assert.deepEqual(
            a.unpriced.map((u) => u.model),
            [SONNET, "mystery/model"],
        );
        assert.equal(a.reviews.series.find((s) => s.date === "2026-10-03")?.cost, 0);
    });

    test("cost: input at its price, cache reads at theirs (or the input price), output at its price", () => {
        close(costOf(tokens(1_000_000, 100_000, 400_000), { input: 3, output: 15, cacheRead: 0.3 }), 3.42);
        close(costOf(tokens(1_000_000, 0, 400_000), { input: 3, output: 15, cacheRead: null }), 3);
        assert.equal(costOf(null, { input: 3, output: 15, cacheRead: null }), null);
        assert.equal(costOf(tokens(1, 1), null), null);
    });

    test("findings and backlog: open now, ages, flow over time, corrections and hotspots", () => {
        const f = run().findings;
        assert.equal(f.open, 4);
        assert.equal(f.inProgress, 1);
        assert.equal(f.unassigned, 3);
        assert.equal(f.needsDiscussion, 1);
        assert.deepEqual(f.openBySeverity, { critical: 1, high: 2, medium: 0, low: 1 });
        assert.deepEqual(f.age, { under7: 0, under30: 1, under90: 0, older: 0, notRecorded: 3 });
        assert.equal(f.added, 5);
        assert.equal(f.removed, 2);
        assert.equal(f.resolved, 3);
        assert.equal(f.wontFix, 1);
        assert.equal(f.closed, 4);
        assert.equal(f.wontFixRate, 0.25);
        assert.equal(f.reopenedByReview, 1);
        assert.equal(f.reopenedByPeople, 1);
        assert.equal(f.duplicates, 1);
        assert.equal(f.flagged, 1);
        assert.deepEqual(f.corrections, { severity: 1, category: 1, severityChanges: [{ from: "reviewer", to: "low", n: 1 }] });
        const day = (d: string) => f.series.find((s) => s.date === d);
        assert.deepEqual(day("2026-10-03"), { date: "2026-10-03", added: 5, closed: 0, reopened: 0 });
        assert.deepEqual(day("2026-10-04"), { date: "2026-10-04", added: 0, closed: 2, reopened: 0 });
        assert.deepEqual(day("2026-10-05"), { date: "2026-10-05", added: 0, closed: 1, reopened: 1 });
        assert.deepEqual(
            f.hotspots.folders.map((h) => [h.key, h.open]),
            [
                ["src/server/", 1],
                ["src/web/", 2],
                ["(top level)", 1],
            ],
        );
        assert.deepEqual(
            f.hotspots.files.map((h) => h.key),
            ["src/server/db.ts", "src/web/b.tsx", "README.md"],
        );
        assert.deepEqual(f.hotspots.categories[0], { key: "security", open: 1, critical: 1, high: 0, medium: 0, low: 0 });
    });

    test("triage: closed per week, the agents' share, time to resolve by severity, and per person and agent", () => {
        const t = run().triage;
        assert.equal(t.closed, 4);
        assert.equal(t.byAgents, 2);
        assert.equal(t.agentShare, 0.5);
        close(t.closedPerWeek, 4 / (6.5 / 7));
        assert.deepEqual(
            t.series.find((s) => s.date === "2026-10-04"),
            { date: "2026-10-04", closed: 2, byAgents: 1 },
        );
        // i1 first seen 20 Sept, resolved 4 Oct noon (now medium); i4 first seen 3 Oct 10:00, resolved 27 hours later (critical when reported).
        assert.equal(t.timeToResolve.notRecorded, 1);
        assert.equal(t.timeToResolve.medianHours, (348 + 27) / 2);
        const by = Object.fromEntries(t.timeToResolve.bySeverity.map((s) => [s.severity, s]));
        assert.deepEqual(by.medium, { severity: "medium", resolved: 1, medianHours: 348, p90Hours: 348 });
        assert.deepEqual(by.critical, { severity: "critical", resolved: 1, medianHours: 27, p90Hours: 27 });
        assert.equal(by.high?.medianHours, null);
        assert.deepEqual(
            t.people.map((p) => [p.actor, p.agent]),
            [
                ["Alice", false],
                ["bot", true],
                ["claude", true],
            ],
        );
        const [alice, bot, claude] = t.people;
        assert.deepEqual(
            { ...alice, lastAt: undefined },
            {
                actor: "Alice",
                agent: false,
                via: ["web"],
                resolved: 2,
                wontFix: 0,
                reopened: 1,
                notes: 0,
                corrections: 1,
                claims: 0,
                releases: 0,
                flags: 1,
                lastAt: undefined,
            },
        );
        assert.equal(bot?.wontFix, 1);
        assert.equal(bot?.notes, 1);
        assert.deepEqual([claude?.resolved, claude?.claims, claude?.releases, claude?.notes], [1, 1, 1, 1]);
        assert.deepEqual(claude?.via, ["mcp"]);
    });

    test("model and OCR performance, with what isn't recorded counted apart", () => {
        const p = run().performance;
        assert.equal(p.reviews, 4);
        assert.equal(p.partial, 1);
        close(p.partialRate, 1 / 3);
        assert.deepEqual(p.groups, { total: 8, failed: 1, recorded: 2 });
        assert.deepEqual(p.llm, { requests: 10, retries: 1, failures: 0, recorded: 1 });
        assert.deepEqual(p.tokensPerMinute, { value: 550_000, recorded: 2 });
        assert.deepEqual(p.tokensPerFile, { value: 110_000, recorded: 1 });
        assert.equal(p.tools.calls, 20);
        assert.equal(p.tools.failureRate, 0.1);
        assert.deepEqual(p.tools.byTool, [
            { tool: "read", calls: 15, failures: 0, failureRate: 0 },
            { tool: "grep", calls: 5, failures: 2, failureRate: 0.4 },
        ]);
        assert.deepEqual(
            p.ocrVersions.map((v) => [v.key, v.reviews]),
            [
                ["(not recorded)", 2],
                ["1.4.0", 2],
            ],
        );
        const empty = run({ history: [] }).performance;
        assert.deepEqual(empty.tokensPerMinute, { value: null, recorded: 0 });
        assert.equal(empty.llm.recorded, 0);
        assert.equal(empty.tools.failureRate, null);
    });

    test("one branch: only its reviews and activity", () => {
        const a = run({ branch: "feature", current: [] });
        assert.equal(a.reviews.total, 1);
        assert.equal(a.reviews.byStatus.done, 1);
        assert.equal(a.findings.closed, 0);
    });

    test("folders: the first two levels", () => {
        assert.equal(folderOf("a/b/c/d.ts"), "a/b/");
        assert.equal(folderOf("a/d.ts"), "a/");
        assert.equal(folderOf("d.ts"), "(top level)");
    });
});

// ---- through the API and MCP --------------------------------------------------------------------

describe("analytics API and MCP", () => {
    let t: TestApp;
    let admin: Session;
    let token: string;

    before(async () => {
        t = await testApp(undefined, { now: () => new Date() });
        admin = await t.signIn("admin", ADMIN_PASSWORD);
        await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "acme" } });
        await t.request("/api/v1/w/acme/projects", { method: "POST", session: admin, body: { slug: "app" } });
        await t.request("/api/v1/w/acme/projects", { method: "POST", session: admin, body: { slug: "lib" } });
        const withTokens = {
            ...report("src/a.ts", "src/b.ts", "lib/c.ts"),
            llm: { model: SONNET },
            summary: { total_tokens: 2_000_000, input_tokens: 1_000_000, output_tokens: 1_000_000 },
        };
        assert.equal(
            (
                await t.request("/api/v1/w/acme/p/app/reports", {
                    method: "POST",
                    session: admin,
                    body: { branch: "main", report: withTokens },
                })
            ).status,
            200,
        );
        assert.equal(
            (
                await t.request("/api/v1/w/acme/p/lib/reports", {
                    method: "POST",
                    session: admin,
                    body: { branch: "dev", report: report("x.ts") },
                })
            ).status,
            200,
        );
        const issues = (await t.request("/api/v1/w/acme/p/app/issues?branch=main", { session: admin })).body.items;
        await t.request(`/api/v1/w/acme/p/app/issues/${issues[0].id}?branch=main`, {
            method: "PATCH",
            session: admin,
            body: { status: "resolved" },
        });
        await t.request("/api/v1/w/acme/settings/model-prices", {
            method: "PUT",
            session: admin,
            body: { model: SONNET, input: 1, output: 2 },
        });
        token = (
            await t.request("/api/v1/w/acme/settings/tokens", { method: "POST", session: admin, body: { name: "reader", scope: "read" } })
        ).body.token;
    });

    test("every project: reviews, costs from the workspace's prices, and what's open", async () => {
        const res = await t.request("/api/v1/w/acme/analytics", { session: admin });
        assert.equal(res.status, 200, res.text);
        const a = res.body;
        assert.equal(a.range.days, 30);
        assert.equal(a.scope.project, null);
        assert.deepEqual(
            a.scope.projects.map((p: { slug: string }) => p.slug),
            ["app", "lib"],
        );
        assert.equal(a.reviews.total, 2);
        assert.equal(a.reviews.uploads, 2);
        // 1M input at US$1 and 1M output at US$2.
        assert.equal(a.reviews.cost.total, 3);
        assert.equal(a.findings.open, 3);
        assert.equal(a.findings.resolved, 1);
        assert.equal(a.findings.added, 4);
        // The resolved finding was first reported by the upload, so its time to resolve is known.
        assert.equal(a.triage.timeToResolve.bySeverity.find((s: { severity: string }) => s.severity === "high").resolved, 1);
        assert.deepEqual(a.truncated, { history: false, activity: false, current: false, sources: false });
    });

    test("more current findings than one request reads: the answer stops there and says so", async () => {
        const limit = LIMITS.current;
        try {
            // app has 4 findings and lib 1.
            LIMITS.current = 3;
            const cut = (await t.request("/api/v1/w/acme/analytics", { session: admin })).body;
            assert.equal(cut.truncated.current, true);
            assert.equal(cut.findings.open + cut.findings.resolved, 3);
            // The reviews and the activity are still counted in full.
            assert.equal(cut.reviews.total, 2);
            assert.equal(cut.findings.added, 4);
            const text = (
                await t.request("/mcp", {
                    method: "POST",
                    token,
                    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_analytics", arguments: {} } },
                })
            ).body.result.content[0].text;
            assert.match(text, /too many current findings/);
            // Exactly at the limit nothing is left out. One project brings it back under.
            LIMITS.current = 5;
            assert.equal((await t.request("/api/v1/w/acme/analytics", { session: admin })).body.truncated.current, false);
            LIMITS.current = 3;
            const lib = (await t.request("/api/v1/w/acme/analytics?project=lib", { session: admin })).body;
            assert.equal(lib.truncated.current, false);
            assert.equal(lib.findings.open, 1);
        } finally {
            LIMITS.current = limit;
        }
    });

    test("one project and one branch; an unknown project is a 404", async () => {
        const lib = await t.request("/api/v1/w/acme/analytics?project=lib&branch=dev&days=7", { session: admin });
        assert.equal(lib.status, 200, lib.text);
        assert.equal(lib.body.scope.project, "lib");
        assert.equal(lib.body.scope.branch, "dev");
        assert.equal(lib.body.reviews.total, 1);
        assert.equal(lib.body.findings.open, 1);
        assert.equal(lib.body.reviews.cost.total, null);
        const none = await t.request("/api/v1/w/acme/analytics?project=app&branch=nope&days=365", { session: admin });
        assert.equal(none.body.reviews.total, 0);
        assert.equal(none.body.range.unit, "week");
        assert.equal((await t.request("/api/v1/w/acme/analytics?project=missing", { session: admin })).status, 404);
        // A project is named by its slug, as in its address (and as MCP's tools name it), and documented so.
        const internalId = (await t.services.store.projects.bySlug((await t.services.store.workspaces.bySlug("acme"))?.id as string, "lib"))
            ?.id;
        assert.equal((await t.request(`/api/v1/w/acme/analytics?project=${internalId}`, { session: admin })).status, 404);
        const doc = (await t.request("/api/v1/openapi.json", { session: admin })).body;
        const param = doc.paths["/api/v1/w/{workspace}/analytics"].get.parameters.find((p: { name: string }) => p.name === "project");
        assert.match(param.description, /slug/);
        const tool = (
            await t.request("/mcp", { method: "POST", token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })
        ).body.result.tools.find((x: { name: string }) => x.name === "get_analytics");
        assert.match(tool.inputSchema.properties.project.description, /slug/);
        assert.equal((await t.request("/api/v1/w/acme/analytics?days=12", { session: admin })).status, 400);
    });

    test("deleting a project keeps its reviews and activity in the analytics, unless asked to remove them", async () => {
        const app = await testApp();
        const session = await app.signIn("admin", ADMIN_PASSWORD);
        const workspaceId = (await app.services.store.workspaces.bySlug("admin"))?.id as string;
        const ids: Record<string, string> = {};
        for (const slug of ["kept", "purged", "other"]) {
            await app.request("/api/v1/w/admin/projects", { method: "POST", session, body: { slug } });
            await app.request(`/api/v1/w/admin/p/${slug}/reports`, { method: "POST", session, body: { report: report("src/a.ts") } });
            const issue = (await app.request(`/api/v1/w/admin/p/${slug}/issues?branch=main`, { session })).body.items[0];
            await app.request(`/api/v1/w/admin/p/${slug}/issues/${issue.id}?branch=main`, {
                method: "PATCH",
                session,
                body: { status: "resolved" },
            });
            ids[slug] = (await app.services.store.projects.bySlug(workspaceId, slug))?.id as string;
        }
        const figures = async () => {
            const a = (await app.request("/api/v1/w/admin/analytics", { session })).body;
            return { reviews: a.reviews.total, added: a.findings.added, closed: a.findings.closed };
        };
        const rows = async (slug: string) => ({
            history: (await app.services.store.reviewHistory.list({ workspaceId, projectId: ids[slug] as string }, 100)).length,
            activity: (await app.services.store.activity.list({ workspaceId, projectId: ids[slug] as string }, { limit: 100 })).length,
        });
        const all = await figures();
        assert.deepEqual(all, { reviews: 3, added: 3, closed: 3 });
        const each = await rows("other");
        assert.ok(each.history === 1 && each.activity >= 3, JSON.stringify(each));

        const remove = (slug: string, body: Record<string, unknown>) =>
            app.request(`/api/v1/w/admin/p/${slug}`, { method: "DELETE", session, body: { confirm: slug, ...body } });
        // As before: nothing said, or false, keeps them.
        assert.equal((await remove("kept", {})).status, 200);
        assert.deepEqual(await figures(), all);
        assert.deepEqual(await rows("kept"), each);
        assert.equal((await remove("purged", { purgeAnalytics: "yes" })).status, 400);
        assert.equal((await remove("purged", { purgeAnalytics: true })).status, 200);
        assert.deepEqual(await figures(), { reviews: 2, added: 2, closed: 2 });
        assert.deepEqual(await rows("purged"), { history: 0, activity: 0 });
        assert.deepEqual(await rows("kept"), each);
        assert.deepEqual(await rows("other"), each);
        assert.equal((await remove("other", { purgeAnalytics: false })).status, 200);
        assert.deepEqual(await rows("other"), each);
        // That each was deleted is still in the workspace's log.
        const deleted = (await app.services.store.activity.list({ workspaceId }, { limit: 100 })).filter((r) => "deleted" in r.changes);
        assert.deepEqual(deleted.map((r) => r.itemId).sort(), ["kept", "other", "purged"]);
    });

    test("a read token can see analytics; outsiders get 404", async () => {
        assert.equal((await t.request("/api/v1/w/acme/analytics?days=0", { token })).status, 200);
        assert.equal((await t.request("/api/v1/w/someone-else/analytics", { token })).status, 404);
    });

    test("MCP get_analytics answers in text with the figures as structured content", async () => {
        const res = await t.request("/mcp", {
            method: "POST",
            token,
            body: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "get_analytics", arguments: { project: "app", days: 90 } },
            },
        });
        assert.equal(res.status, 200, res.text);
        const result = res.body.result;
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.match(result.content[0].text, /^# Analytics: app, all branches, the last 90 days/);
        assert.match(result.content[0].text, /1 reviews \(0 run on the server, 1 uploaded\)/);
        assert.match(result.content[0].text, /Cost: US\$3\.00/);
        assert.equal(result.structuredContent.reviews.total, 1);
        const bad = await t.request("/mcp", {
            method: "POST",
            token,
            body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_analytics", arguments: { days: 12 } } },
        });
        assert.equal(bad.body.result.isError, true);
        const list = await t.request("/mcp", { method: "POST", token, body: { jsonrpc: "2.0", id: 3, method: "tools/list" } });
        assert.ok(list.body.result.tools.some((x: { name: string }) => x.name === "get_analytics"));
    });
});
