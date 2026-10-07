// GitHub webhook signatures, and the MCP endpoint agents use.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { expectStatus, finding, issueAt, knownGap, report, skip, unique, useTarget } from "./harness/index.ts";

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("GitHub webhooks", { skip }, () => {
    const target = useTarget();

    async function setup() {
        const t = target();
        const admin = await t.admin();
        const project = unique("hooks");
        expectStatus(await t.createProject(admin, project), 201);
        return { t, admin, project };
    }

    test("deliveries are refused until the project has a webhook secret", async () => {
        const { t, project } = await setup();
        const body = JSON.stringify({ zen: "hello" });
        expectStatus(await t.deliverWebhook(project, { event: "ping", body, signature: sign("guess", body) }), 404);
    });

    test("only deliveries signed with the project's secret are accepted", async () => {
        const { t, admin, project } = await setup();
        const created = await t.generateWebhookSecret(admin, project);
        expectStatus(created, 200);
        const secret: string = created.body.webhookSecret;
        assert.ok(secret && secret.length >= 24);

        const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
        expectStatus(await t.deliverWebhook(project, { event: "ping", body, signature: null }), 401);
        expectStatus(await t.deliverWebhook(project, { event: "ping", body, signature: sign("wrong secret", body) }), 401);
        // The signature covers the exact bytes: a body changed in transit fails.
        expectStatus(await t.deliverWebhook(project, { event: "ping", body: `${body} `, signature: sign(secret, body) }), 401);
        const ok = await t.deliverWebhook(project, { event: "ping", body, signature: sign(secret, body) });
        expectStatus(ok, 200);
        assert.equal(ok.body.ok, true);
    });

    test("the webhook secret is shown once and never again", async () => {
        const { t, admin, project } = await setup();
        const secret: string = (await t.generateWebhookSecret(admin, project)).body.webhookSecret;
        const settings = await t.githubSettings(admin, project);
        expectStatus(settings, 200);
        assert.ok(!JSON.stringify(settings.body).includes(secret));
    });
});

describe("MCP", { skip }, () => {
    const target = useTarget();

    async function setup() {
        const t = target();
        const admin = await t.admin();
        const project = unique("mcp");
        expectStatus(await t.createProject(admin, project), 201);
        expectStatus(
            await t.upload(admin, project, { branch: "main", report: report(finding("src/a.ts", "Found by the reviewer for MCP.")) }),
            200,
        );
        const issue = await issueAt(t, admin, project, "main", "src/a.ts");
        return { t, admin, project, issue };
    }

    test("initialize names the server and agrees a protocol version", async () => {
        const { t, admin } = await setup();
        const read = await t.token(admin, "read");
        const r = await t.mcp(read, {
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        });
        expectStatus(r, 200);
        assert.equal(r.body.result.protocolVersion, "2025-06-18");
        assert.ok(r.body.result.serverInfo.name);
        assert.ok(r.body.result.capabilities.tools);
    });

    test("the core triage tools are listed with input schemas", async () => {
        const { t, admin } = await setup();
        const full = await t.token(admin, "full");
        const r = await t.mcp(full, { id: 2, method: "tools/list" });
        const tools = new Map(r.body.result.tools.map((x: { name: string }) => [x.name, x]));
        for (const name of [
            "list_projects",
            "list_issues",
            "get_issue",
            "update_issue",
            "claim_next_issue",
            "release_issue",
            "create_upload_link",
            "add_issue",
        ]) {
            assert.ok(tools.has(name), `missing tool ${name}`);
        }
        assert.equal((tools.get("update_issue") as { inputSchema: { type: string } }).inputSchema.type, "object");
    });

    test(
        "a token is only offered the tools its scope allows",
        knownGap("legacy", "lists every tool whatever the token's scope"),
        async () => {
            const { t, admin } = await setup();
            const read = await t.token(admin, "read");
            const r = await t.mcp(read, { id: 6, method: "tools/list" });
            const names = r.body.result.tools.map((x: { name: string }) => x.name);
            assert.ok(names.includes("list_issues") && names.includes("get_issue"));
            assert.ok(
                !names.includes("update_issue") && !names.includes("create_upload_link"),
                `read token was offered: ${names.join(", ")}`,
            );
        },
    );

    test("tools respect the token's scope", async () => {
        const { t, admin, project, issue } = await setup();
        const read = await t.token(admin, "read");
        const write = await t.token(admin, "write");
        const call = (c: typeof read, args: Record<string, unknown>) =>
            t.mcp(c, {
                id: 3,
                method: "tools/call",
                params: { name: "update_issue", arguments: { project, branch: "main", id: issue.id, ...args } },
            });

        const refused = await call(read, { status: "resolved" });
        expectStatus(refused, 200);
        assert.equal(refused.body.result.isError, true);
        assert.equal((await t.getIssue(admin, project, "main", issue.id)).body.status, "open");

        const done = await call(write, { status: "resolved", note: "Fixed by an agent." });
        assert.equal(done.body.result.isError, false);
        assert.equal((await t.getIssue(admin, project, "main", issue.id)).body.status, "resolved");
    });

    test("an unknown tool or method is a JSON-RPC error", async () => {
        const { t, admin } = await setup();
        const read = await t.token(admin, "read");
        const tool = await t.mcp(read, { id: 4, method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
        assert.ok(tool.body.error);
        const method = await t.mcp(read, { id: 5, method: "no/such/method" });
        assert.equal(method.body.error.code, -32601);
    });
});
