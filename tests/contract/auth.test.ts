// Who can do what: sessions, request forgery, roles and token scopes.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expectStatus, finding, issueAt, report, skip, unique, useTarget } from "./harness/index.ts";

describe("authentication and permissions", { skip }, () => {
    const target = useTarget();
    const branch = "main";

    async function projectWithIssue() {
        const t = target();
        const admin = await t.admin();
        const project = unique("auth");
        expectStatus(await t.createProject(admin, project), 201);
        expectStatus(
            await t.upload(admin, project, { branch, report: report(finding("src/a.ts", "Unchecked input reaches the query builder.")) }),
            200,
        );
        const issue = await issueAt(t, admin, project, branch, "src/a.ts");
        return { t, admin, project, issue };
    }

    test("the API refuses callers who aren't signed in", async () => {
        const t = target();
        expectStatus(await t.listIssues({ kind: "anonymous" }, t.defaultProject, branch), 401);
        expectStatus(await t.mcp({ kind: "anonymous" }, { id: 1, method: "tools/list" }), 401);
    });

    test("the API refuses an unknown token", async () => {
        const t = target();
        expectStatus(await t.listIssues({ kind: "token", name: "nobody", token: "ocr_not-a-real-token" }, t.defaultProject, branch), 401);
    });

    test("browser writes need the session's CSRF token and the site's own origin", async () => {
        const { t, admin, project, issue } = await projectWithIssue();
        expectStatus(await t.updateIssue({ ...admin, csrf: null }, project, branch, issue.id, { status: "in_progress" }), 403);
        expectStatus(await t.updateIssue({ ...admin, csrf: "forged" }, project, branch, issue.id, { status: "in_progress" }), 403);
        expectStatus(
            await t.updateIssue({ ...admin, origin: "https://evil.example" }, project, branch, issue.id, { status: "in_progress" }),
            403,
        );
        expectStatus(await t.updateIssue(admin, project, branch, issue.id, { status: "in_progress" }), 200);
    });

    test("viewers can read but not triage; editors can triage", async () => {
        const { t, project, issue } = await projectWithIssue();
        const viewer = await t.user("viewer");
        const editor = await t.user("editor");
        expectStatus(await t.getIssue(viewer, project, branch, issue.id), 200);
        expectStatus(await t.updateIssue(viewer, project, branch, issue.id, { status: "resolved" }), 403);
        expectStatus(await t.updateIssue(editor, project, branch, issue.id, { status: "resolved" }), 200);
    });

    test("only admins can manage projects and API tokens", async () => {
        const t = target();
        const editor = await t.user("editor");
        expectStatus(await t.createProject(editor, unique("nope")), 403);
        expectStatus(await t.createToken(editor, "read"), 403);
    });

    test("token scopes limit what a token can do", async () => {
        const { t, admin, project, issue } = await projectWithIssue();
        const upload = (c: Parameters<typeof t.upload>[0], b: string) =>
            t.upload(c, project, { branch: b, report: report(finding("src/b.ts", "A second finding for the scope test.")) });

        const read = await t.token(admin, "read");
        expectStatus(await t.listIssues(read, project, branch), 200);
        expectStatus(await t.updateIssue(read, project, branch, issue.id, { assignee: "x" }), 403);
        expectStatus(await upload(read, unique("b")), 403);

        const write = await t.token(admin, "write");
        expectStatus(await t.updateIssue(write, project, branch, issue.id, { assignee: "write-agent" }), 200);
        expectStatus(await upload(write, unique("b")), 403);

        const ci = await t.token(admin, "upload");
        expectStatus(await upload(ci, unique("b")), 200);
        expectStatus(await t.updateIssue(ci, project, branch, issue.id, { assignee: "ci" }), 403);

        const full = await t.token(admin, "full");
        expectStatus(await upload(full, unique("b")), 200);
        expectStatus(await t.updateIssue(full, project, branch, issue.id, { assignee: "full-agent" }), 200);
        expectStatus(await t.createProject(full, unique("nope")), 403);

        const manage = await t.token(admin, "manage");
        expectStatus(await t.createProject(manage, unique("managed")), 201);
    });

    test("no token can create tokens or set secrets, whatever its scope", async () => {
        const { t, admin, project } = await projectWithIssue();
        const manage = await t.token(admin, "manage");
        expectStatus(await t.createToken(manage, "read"), 403);
        expectStatus(await t.generateWebhookSecret(manage, project), 403);
    });

    test("a new token is shown once and never listed again", async () => {
        const t = target();
        const admin = await t.admin();
        const created = await t.createToken(admin, "read");
        expectStatus(created, 201);
        assert.match(created.body.token, /\S{30,}/);
        const listed = await t.listTokens(admin);
        expectStatus(listed, 200);
        assert.ok(listed.body.items.length > 0);
        assert.ok(!JSON.stringify(listed.body).includes(created.body.token), "the token list must not contain the token itself");
    });
});
