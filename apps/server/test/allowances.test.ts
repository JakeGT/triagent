// Which key pays for a review (Models.forRun): the workspace's own key first, then the instance key for a
// workspace with an allowance left this month, otherwise not ready with the reason. The clock is injected,
// so month boundaries are tested exactly.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { Actor } from "../src/services/core.ts";
import type { RunModel } from "../src/services/models.ts";
import type { ReviewRecord, Workspace } from "../src/store/types.ts";
import { ADMIN_PASSWORD, type Session, type TestApp, testApp } from "./helpers.ts";

let t: TestApp;
let admin: Session;
let clock = new Date("2026-10-31T23:59:59.000Z");
const actor: Actor = { name: "admin", userId: null, via: "web" };

before(async () => {
    t = await testApp(undefined, { now: () => clock });
    admin = await t.signIn("admin", ADMIN_PASSWORD);
});

let n = 0;
async function newWorkspace(): Promise<Workspace> {
    const slug = `org-${++n}`;
    assert.equal((await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug } })).status, 201);
    return (await t.services.store.workspaces.bySlug(slug)) as Workspace;
}

async function spend(workspace: Workspace, at: string, total: number, keySource: ReviewRecord["keySource"]) {
    await t.services.store.transaction((tx) =>
        t.services.history.record(tx, {
            workspaceId: workspace.id,
            projectId: null,
            branch: "main",
            at,
            source: "run",
            kind: "pr",
            status: "done",
            model: "m",
            provider: "openrouter",
            keySource,
            tokens: { input: total, output: 0, cacheRead: 0, total },
            details: {},
        }),
    );
}

test("with no key and no allowance, reviews wait for a key", async () => {
    const w = await newWorkspace();
    const r = await t.services.models.forRun(w);
    assert.deepEqual(r, { ready: false, reason: "Add an OpenRouter API key in Settings → Review model & keys." });
});

test("the workspace's own key wins over the instance key, even with an allowance", async () => {
    const w = await newWorkspace();
    await t.services.allowances.setKey(actor, "openrouter", "sk-or-instance-key-0001");
    await t.services.allowances.setGrant(actor, w.id, 1_000_000);
    await t.services.settings.setModelKey(actor, w, "openrouter", "sk-or-workspace-key-0002");
    await t.services.settings.setReviewModel(actor, w, { model: "openai/gpt-5" });
    const r = (await t.services.models.forRun(w)) as RunModel;
    assert.equal(r.ready, true);
    assert.equal(r.keySource, "workspace");
    assert.equal(r.apiKey, "sk-or-workspace-key-0002");
    assert.equal(r.model, "openai/gpt-5");
    assert.equal(r.allowance, undefined);
});

test("a key for another provider doesn't count: the chosen provider needs one", async () => {
    const w = await newWorkspace();
    await t.services.settings.setModelKey(actor, w, "meta", "meta-key-123456789");
    const r = await t.services.models.forRun(w);
    assert.equal(r.ready, false);
    await t.services.settings.setReviewModel(actor, w, { provider: "meta" });
    const meta = (await t.services.models.forRun(w)) as RunModel;
    assert.equal(meta.provider, "meta");
    assert.equal(meta.keySource, "workspace");
});

test("with an allowance and no key of its own, the instance key, provider and model pay", async () => {
    const w = await newWorkspace();
    await t.services.allowances.setKey(actor, "openrouter", "sk-or-instance-key-0001");
    await t.services.allowances.setModel(actor, { provider: "openrouter", model: "deepseek/deepseek-v3" });
    await t.services.allowances.setGrant(actor, w.id, 2_000_000);
    const r = (await t.services.models.forRun(w)) as RunModel;
    assert.equal(r.ready, true);
    assert.equal(r.keySource, "instance");
    assert.equal(r.apiKey, "sk-or-instance-key-0001");
    assert.equal(r.model, "deepseek/deepseek-v3");
    assert.deepEqual(r.allowance, {
        monthlyTokens: 2_000_000,
        used: 0,
        reserved: 0,
        remaining: 2_000_000,
        resetsAt: "2026-11-01T00:00:00.000Z",
    });
});

test("a granted workspace waits while the instance has no key for its provider", async () => {
    const w = await newWorkspace();
    await t.services.allowances.setGrant(actor, w.id, 2_000_000);
    await t.services.allowances.setModel(actor, { provider: "meta" });
    const r = await t.services.models.forRun(w);
    assert.equal(r.ready, false);
    assert.match((r as { reason: string }).reason, /instance administrator hasn't set one up/);
    await t.services.allowances.setModel(actor, { provider: "openrouter" });
});

test("a used-up allowance stops instance-key reviews until the 1st of next month (UTC)", async () => {
    const w = await newWorkspace();
    await t.services.allowances.setKey(actor, "openrouter", "sk-or-instance-key-0001");
    await t.services.allowances.setGrant(actor, w.id, 2_000_000);
    clock = new Date("2026-10-31T23:59:59.000Z");
    // Last month's use and the workspace's own-key use don't count.
    await spend(w, "2026-09-30T23:59:59.999Z", 5_000_000, "instance");
    await spend(w, "2026-10-10T00:00:00.000Z", 9_000_000, "workspace");
    await spend(w, "2026-10-01T00:00:00.000Z", 1_500_000, "instance");
    const partway = (await t.services.models.forRun(w)) as RunModel;
    assert.equal(partway.keySource, "instance");
    assert.equal(partway.allowance?.remaining, 500_000);

    await spend(w, "2026-10-31T23:00:00.000Z", 500_000, "instance");
    const out = await t.services.models.forRun(w);
    assert.equal(out.ready, false);
    assert.match(
        (out as { reason: string }).reason,
        /^This month's allowance of 2,000,000 tokens is used up; it resets on 1 November\. To keep reviewing before then, add your own OpenRouter API key/,
    );

    // One second later it's November: a fresh allowance.
    clock = new Date("2026-11-01T00:00:00.000Z");
    const fresh = (await t.services.models.forRun(w)) as RunModel;
    assert.equal(fresh.keySource, "instance");
    assert.deepEqual(fresh.allowance, {
        monthlyTokens: 2_000_000,
        used: 0,
        reserved: 0,
        remaining: 2_000_000,
        resetsAt: "2026-12-01T00:00:00.000Z",
    });

    // December's allowance resets in the new year, and says so.
    clock = new Date("2026-12-15T12:00:00.000Z");
    await spend(w, "2026-12-02T00:00:00.000Z", 3_000_000, "instance");
    assert.match(((await t.services.models.forRun(w)) as { reason: string }).reason, /resets on 1 January 2027\./);
    clock = new Date("2026-10-31T23:59:59.000Z");
});

test("removing the allowance stops instance-key reviews; the workspace sees its usage, never a key", async () => {
    const w = await newWorkspace();
    await t.services.allowances.setKey(actor, "openrouter", "sk-or-instance-key-0001");
    await t.services.allowances.setGrant(actor, w.id, 1_000_000);
    await spend(w, "2026-10-05T00:00:00.000Z", 250_000, "instance");
    const view = await t.request(`/api/v1/w/${w.slug}/settings/model-allowance`, { session: admin });
    assert.equal(view.status, 200);
    assert.equal(view.body.granted, true);
    assert.equal(view.body.monthlyTokens, 1_000_000);
    assert.equal(view.body.used, 250_000);
    assert.equal(view.body.remaining, 750_000);
    assert.equal(view.body.now.ready, true);
    assert.equal(view.body.now.keySource, "instance");
    assert.ok(!view.text.includes("sk-or-instance-key"));

    const del = await t.request(`/api/v1/instance/workspaces/${w.id}/grant`, { method: "DELETE", session: admin });
    assert.equal(del.status, 200, del.text);
    assert.equal((await t.services.models.forRun(w)).ready, false);
    const after = await t.request(`/api/v1/w/${w.slug}/settings/model-allowance`, { session: admin });
    assert.equal(after.body.granted, false);
    assert.equal(after.body.now.ready, false);
});

test("instance pages: keys never returned, grants listed with usage, every change audited", async () => {
    const w = await newWorkspace();
    const put = await t.request("/api/v1/instance/model/keys/openrouter", {
        method: "PUT",
        session: admin,
        body: { key: "sk-or-secret-value-9876" },
    });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.body.hint, "…9876");
    const model = await t.request("/api/v1/instance/model", { session: admin });
    assert.equal(model.status, 200);
    assert.ok(!model.text.includes("sk-or-secret-value"));
    assert.equal(model.body.providers.find((p: { id: string }) => p.id === "openrouter").key.set, true);

    const grant = await t.request(`/api/v1/instance/workspaces/${w.id}/grant`, {
        method: "PUT",
        session: admin,
        body: { monthlyTokens: 3_000_000 },
    });
    assert.equal(grant.status, 200, grant.text);
    assert.equal(
        (await t.request(`/api/v1/instance/workspaces/${w.id}/grant`, { method: "PUT", session: admin, body: { monthlyTokens: 5 } }))
            .status,
        400,
    );
    assert.equal(
        (await t.request("/api/v1/instance/workspaces/nope/grant", { method: "PUT", session: admin, body: { monthlyTokens: 5000 } }))
            .status,
        404,
    );
    await spend(w, "2026-10-02T00:00:00.000Z", 1_000, "instance");
    const list = await t.request("/api/v1/instance/workspaces", { session: admin });
    const row = list.body.items.find((x: { id: string }) => x.id === w.id);
    assert.deepEqual(row.grant.monthlyTokens, 3_000_000);
    assert.equal(row.used, 1000);
    assert.equal(row.remaining, 2_999_000);
    assert.equal(list.body.resetsAt, "2026-11-01T00:00:00.000Z");

    const instanceAudit = await t.services.store.audit.list({ workspaceId: null }, { limit: 50 });
    assert.ok(instanceAudit.some((a) => a.target === "instance:model-key:openrouter" && JSON.stringify(a.changes).includes('"set"')));
    assert.ok(instanceAudit.some((a) => a.target === `workspace:${w.slug}:model-grant`));
    assert.ok(!JSON.stringify(instanceAudit).includes("sk-or-secret-value"));
    const wsAudit = await t.services.store.audit.list({ workspaceId: w.id }, { limit: 50 });
    assert.ok(wsAudit.some((a) => a.target === "model-grant"));
});
