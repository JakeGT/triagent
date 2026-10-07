// Projects keep their data apart; branches can be moved and deleted without losing triage by accident.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expectStatus, finding, issueAt, report, skip, unique, useTarget } from "./harness/index.ts";

describe("projects", { skip }, () => {
    const target = useTarget();

    test("project ids are validated and unique", async () => {
        const t = target();
        const admin = await t.admin();
        const id = unique("proj");
        expectStatus(await t.createProject(admin, id, "My project"), 201);
        expectStatus(await t.createProject(admin, id), 409);
        expectStatus(await t.createProject(admin, "Not A Valid Id!"), 400);
        expectStatus(await t.createProject(admin, "../escape"), 400);
    });

    test("each project's reports and triage are separate", async () => {
        const t = target();
        const admin = await t.admin();
        const [p1, p2] = [unique("one"), unique("two")];
        expectStatus(await t.createProject(admin, p1), 201);
        expectStatus(await t.createProject(admin, p2), 201);
        expectStatus(await t.upload(admin, p1, { branch: "main", report: report(finding("src/a.ts", "Only in the first project.")) }), 200);
        assert.equal((await t.listIssues(admin, p1, "main")).body.total, 1);
        assert.equal((await t.listIssues(admin, p2, "main")).body.total, 0);
        const issue = await issueAt(t, admin, p1, "main", "src/a.ts");
        expectStatus(await t.getIssue(admin, p2, "main", issue.id), 404);
    });

    test("deleting a project removes it, and a default project (if the target has one) can't be deleted", async () => {
        const t = target();
        const admin = await t.admin();
        const id = unique("gone");
        expectStatus(await t.createProject(admin, id), 201);
        expectStatus(await t.deleteProject(admin, id), 200);
        expectStatus(await t.listIssues(admin, id, "main"), 404);
        if (t.defaultProject) expectStatus(await t.deleteProject(admin, t.defaultProject), 400);
    });
});

describe("branches", { skip }, () => {
    const target = useTarget();

    async function setup() {
        const t = target();
        const admin = await t.admin();
        const project = unique("branches");
        expectStatus(await t.createProject(admin, project), 201);
        return { t, admin, project };
    }

    test("moving a branch's review takes its report and triage with it", async () => {
        const { t, admin, project } = await setup();
        const [from, to] = [unique("wrong"), unique("right")];
        expectStatus(
            await t.upload(admin, project, { branch: from, report: report(finding("src/a.ts", "Uploaded to the wrong branch.")) }),
            200,
        );
        const issue = await issueAt(t, admin, project, from, "src/a.ts");
        expectStatus(await t.updateIssue(admin, project, from, issue.id, { status: "in_progress", note: "Working on it." }), 200);

        expectStatus(await t.moveBranch(admin, project, { from, to }), 200);
        const names = (await t.branches(admin, project)).body.items.map((b: { name: string }) => b.name);
        assert.ok(names.includes(to) && !names.includes(from));
        const moved = (await t.getIssue(admin, project, to, issue.id)).body;
        assert.equal(moved.status, "in_progress");
        assert.ok(moved.notes.some((n: { text: string }) => n.text === "Working on it."));
    });

    test("a review can't be moved onto a branch that already has one", async () => {
        const { t, admin, project } = await setup();
        const [a, b] = [unique("a"), unique("b")];
        expectStatus(await t.upload(admin, project, { branch: a, report: report(finding("src/a.ts", "On branch a.")) }), 200);
        expectStatus(await t.upload(admin, project, { branch: b, report: report(finding("src/b.ts", "On branch b.")) }), 200);
        expectStatus(await t.moveBranch(admin, project, { from: a, to: b }), 409);
    });

    test("deleting a branch with unresolved issues needs confirmation; the default branch can't be deleted", async () => {
        const { t, admin, project } = await setup();
        const branch = unique("old");
        expectStatus(await t.upload(admin, project, { branch, report: report(finding("src/a.ts", "Still unresolved.")) }), 200);
        const refused = await t.deleteBranch(admin, project, { branch });
        expectStatus(refused, 409);
        assert.equal(refused.body.unresolved, 1);
        expectStatus(await t.deleteBranch(admin, project, { branch, confirm: true }), 200);
        const names = (await t.branches(admin, project)).body.items.map((b: { name: string }) => b.name);
        assert.ok(!names.includes(branch));

        expectStatus(
            await t.upload(admin, project, { branch: t.defaultBranch, report: report(finding("src/m.ts", "On the default branch.")) }),
            200,
        );
        expectStatus(await t.deleteBranch(admin, project, { branch: t.defaultBranch, confirm: true }), 400);
    });

    test("branch names are validated", async () => {
        const { t, admin, project } = await setup();
        expectStatus(await t.upload(admin, project, { branch: "bad..name", report: report(finding("src/a.ts", "Never stored.")) }), 400);
        expectStatus(
            await t.upload(admin, project, { branch: "-starts-with-dash", report: report(finding("src/a.ts", "Never stored.")) }),
            400,
        );
    });
});
