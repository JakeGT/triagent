// Uploading a report records the review in the history, in the same transaction, with what the report
// says about its own run. Server runs (uploads by GitHub automation) record themselves and are skipped.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { reportMetrics } from "../src/domain/review-metrics.ts";
import type { Actor } from "../src/services/core.ts";
import type { Project, Workspace } from "../src/store/types.ts";
import { ADMIN_PASSWORD, report, type TestApp, testApp } from "./helpers.ts";

let t: TestApp;
let workspace: Workspace;
let project: Project;

before(async () => {
    t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    assert.equal((await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "acme" } })).status, 201);
    assert.equal((await t.request("/api/v1/w/acme/projects", { method: "POST", session: admin, body: { slug: "app" } })).status, 201);
    workspace = (await t.services.store.workspaces.bySlug("acme")) as Workspace;
    project = (await t.services.store.projects.bySlug(workspace.id, "app")) as Project;
});

/** A report with what OCR writes about its own run. */
function ocrReport(paths: string[], extra: Record<string, unknown> = {}) {
    return {
        ...report(...paths),
        llm: { model: "anthropic/claude-sonnet-4.5", provider: "openrouter" },
        summary: {
            total_tokens: 12_000,
            input_tokens: 10_000,
            output_tokens: 2000,
            cache_read_tokens: 4000,
            files_reviewed: 6,
            elapsed: "2m30s",
        },
        manifest: { execution: { ocr_version: "v1.4.2" } },
        tool_calls: { total: 40, failure: 3, by_tool: { read_file: 30, grep: 10 }, failure_by_tool: { grep: 3 } },
        retry_report: { total_requests: 20, retried_requests: 2, failed_requests: 1 },
        groups: [{}, {}, {}],
        ...extra,
    };
}

test("an upload is recorded with its model, tokens, findings, counts and tool calls", async () => {
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const first = await t.request("/api/v1/w/acme/p/app/reports", {
        method: "POST",
        session: admin,
        body: { branch: "feature", commit: "abcdef1", report: ocrReport(["src/a.ts", "src/b.ts"]) },
    });
    assert.equal(first.status, 200, first.text);
    const [r] = await t.services.history.list({ workspaceId: workspace.id, branch: "feature" });
    assert.ok(r);
    assert.equal(r.source, "upload");
    assert.equal(r.kind, "upload");
    assert.equal(r.status, "done");
    assert.equal(r.projectId, project.id);
    assert.equal(r.model, "anthropic/claude-sonnet-4.5");
    assert.equal(r.provider, "openrouter");
    assert.equal(r.keySource, null);
    assert.deepEqual(r.tokens, { input: 10_000, output: 2000, cacheRead: 4000, total: 12_000 });
    assert.equal(r.details.commit, "abcdef1");
    assert.equal(r.details.requestedBy, "admin");
    assert.equal(r.details.ocrVersion, "1.4.2");
    assert.equal(r.details.runSeconds, 150);
    assert.deepEqual(r.details.findings, { total: 2, bySeverity: { critical: 0, high: 2, medium: 0, low: 0 } });
    assert.deepEqual(r.details.counts, { added: 2, carriedOver: 0, removed: 0, reopened: 0 });
    assert.deepEqual(r.details.toolCalls, { total: 40, failed: 3, byTool: { read_file: 30, grep: 10 }, failedByTool: { grep: 3 } });
    assert.deepEqual(r.details.llm, { requests: 20, retries: 2, failures: 1 });
    assert.deepEqual(r.details.files, { reviewed: 6, groups: 3, failedGroups: 0 });
    assert.equal(r.details.addedIds?.high?.length, 2);

    // A second upload: one carried over, one gone, one new, and a resolved one reopened.
    const issues = (await t.request("/api/v1/w/acme/p/app/issues?branch=feature", { session: admin })).body.items;
    const a = issues.find((x: { path: string }) => x.path === "src/a.ts");
    await t.request(`/api/v1/w/acme/p/app/issues/${a.id}?branch=feature`, {
        method: "PATCH",
        session: admin,
        body: { status: "resolved" },
    });
    const warnings = [{ type: "review_round_failed", file: "src/c.ts", message: "round 2: context deadline exceeded" }];
    const second = await t.request("/api/v1/w/acme/p/app/reports", {
        method: "POST",
        session: admin,
        body: { branch: "feature", confirm: true, report: ocrReport(["src/a.ts", "src/c.ts"], { warnings }) },
    });
    assert.equal(second.status, 200, second.text);
    const [latest] = await t.services.history.list({ workspaceId: workspace.id, branch: "feature" });
    assert.equal(latest?.status, "partial");
    assert.deepEqual(latest?.details.counts, { added: 1, carriedOver: 1, removed: 1, reopened: 1 });
    assert.equal(latest?.details.files?.failedGroups, 1);
    // Only the finding new to the branch counts as first seen here.
    assert.deepEqual(Object.values(latest?.details.addedIds ?? {}).flat().length, 1);
});

test("a report without run details is still recorded, with nothing made up", async () => {
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const res = await t.request("/api/v1/w/acme/p/app/reports", {
        method: "POST",
        session: admin,
        body: { branch: "plain", report: report("x.ts") },
    });
    assert.equal(res.status, 200, res.text);
    const [r] = await t.services.history.list({ workspaceId: workspace.id, branch: "plain" });
    assert.equal(r?.model, null);
    assert.equal(r?.tokens, null);
    assert.equal(r?.details.runSeconds, undefined);
    assert.equal(r?.details.toolCalls, undefined);
    assert.equal(r?.details.llm, undefined);
});

test("uploads by GitHub automation (server runs) aren't recorded: the run records itself", async () => {
    const github: Actor = { name: "github", userId: null, via: "github" };
    await t.services.reports.upload(github, project, { branch: "pr-7", report: ocrReport(["a.ts"]) });
    assert.deepEqual(await t.services.history.list({ workspaceId: workspace.id, branch: "pr-7" }), []);
    // The same upload by a token is recorded.
    const token: Actor = { name: "ci", userId: null, tokenId: "t1", via: "token" };
    await t.services.reports.upload(token, project, { branch: "pr-8", report: ocrReport(["a.ts"]) });
    assert.equal((await t.services.history.list({ workspaceId: workspace.id, branch: "pr-8" }))[0]?.details.requestedBy, "ci");
});

test("a refused upload records nothing", async () => {
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const before = (await t.services.history.list({ workspaceId: workspace.id })).length;
    // feature has unresolved issues: replacing it needs confirm.
    const res = await t.request("/api/v1/w/acme/p/app/reports", {
        method: "POST",
        session: admin,
        body: { branch: "feature", report: report("z.ts") },
    });
    assert.equal(res.status, 409);
    const preview = await t.request("/api/v1/w/acme/p/app/reports/preview", {
        method: "POST",
        session: admin,
        body: { branch: "new", report: report("z.ts") },
    });
    assert.equal(preview.status, 200);
    assert.equal((await t.services.history.list({ workspaceId: workspace.id })).length, before);
});

test("report metrics ignore odd shapes and values", () => {
    const m = reportMetrics({
        comments: [{ path: "a", content: "x", severity: "weird" }],
        summary: { total_tokens: -5, input_tokens: "lots" },
        tool_calls: { total: 3, by_tool: { __proto__: 1, "bad name!": 2, ok: Number.NaN, fine: 3 } },
        llm: { model: 42 },
        status: "partial",
    });
    assert.equal(m.tokens, null);
    assert.equal(m.model, null);
    assert.equal(m.partial, true);
    assert.deepEqual(m.toolCalls?.byTool, { fine: 3 });
    assert.deepEqual(m.findings.bySeverity, { critical: 0, high: 0, medium: 0, low: 1 });
});
