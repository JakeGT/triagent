// Uploading OCR reports: previews, confirmation, carrying triage over, reopening and upload links.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expectStatus, finding, issueAt, knownGap, report, skip, unique, useTarget } from "./harness/index.ts";

describe("reports", { skip }, () => {
    const target = useTarget();
    const A = finding("src/a.ts", "Unchecked input reaches the query builder.");
    const B = finding("src/b.ts", "The retry loop never backs off.");
    const C = finding("src/c.ts", "The cache key ignores the user id.");

    async function setup() {
        const t = target();
        const admin = await t.admin();
        const project = unique("reports");
        expectStatus(await t.createProject(admin, project), 201);
        return { t, admin, project, branch: unique("feature") };
    }

    test("uploading a report to a new branch creates the branch and its issues", async () => {
        const { t, admin, project, branch } = await setup();
        expectStatus(await t.upload(admin, project, { branch, report: report(A, B, C) }), 200);
        const branches = await t.branches(admin, project);
        const row = branches.body.items.find((b: { name: string }) => b.name === branch);
        assert.equal(row?.issues, 3);
        assert.equal((await t.listIssues(admin, project, branch)).body.total, 3);
    });

    test("a preview says what an upload would change, without changing anything", async () => {
        const { t, admin, project, branch } = await setup();
        expectStatus(await t.upload(admin, project, { branch, report: report(A, B) }), 200);
        const preview = await t.previewUpload(admin, project, { branch, report: report(B, C) });
        expectStatus(preview, 200);
        assert.equal(preview.body.carriedOver, 1);
        assert.equal(preview.body.added, 1);
        assert.equal(preview.body.removed, 1);
        assert.equal(preview.body.requiresConfirmation, true);
        const paths = (await t.listIssues(admin, project, branch)).body.items.map((x: { path: string }) => x.path).sort();
        assert.deepEqual(paths, ["src/a.ts", "src/b.ts"]);
    });

    test("replacing a report that has unresolved issues needs confirmation", async () => {
        const { t, admin, project, branch } = await setup();
        expectStatus(await t.upload(admin, project, { branch, report: report(A) }), 200);
        expectStatus(await t.upload(admin, project, { branch, report: report(B) }), 409);
        expectStatus(await t.upload(admin, project, { branch, report: report(B), confirm: true }), 200);
        assert.equal((await t.listIssues(admin, project, branch)).body.items[0].path, "src/b.ts");
    });

    test("triage carries over to the next report for findings it still contains", async () => {
        const { t, admin, project, branch } = await setup();
        expectStatus(await t.upload(admin, project, { branch, report: report(A, B) }), 200);
        const a = await issueAt(t, admin, project, branch, "src/a.ts");
        expectStatus(await t.updateIssue(admin, project, branch, a.id, { status: "wont_fix", note: "Input is validated upstream." }), 200);
        expectStatus(await t.upload(admin, project, { branch, report: report(A, C), confirm: true }), 200);
        const after = (await t.getIssue(admin, project, branch, a.id)).body;
        assert.equal(after.status, "wont_fix");
        assert.ok(after.notes.some((n: { text: string }) => n.text.includes("validated upstream")));
    });

    test("a resolved finding that a new report still contains is reopened, with a note", async () => {
        const { t, admin, project, branch } = await setup();
        expectStatus(await t.upload(admin, project, { branch, report: report(A, B) }), 200);
        const a = await issueAt(t, admin, project, branch, "src/a.ts");
        expectStatus(await t.updateIssue(admin, project, branch, a.id, { status: "resolved" }), 200);
        const r = await t.upload(admin, project, { branch, report: report(A, C), confirm: true });
        expectStatus(r, 200);
        assert.equal(r.body.reopened, 1);
        const after = (await t.getIssue(admin, project, branch, a.id)).body;
        assert.equal(after.status, "open");
        assert.ok(after.notes.some((n: { text: string }) => /reopened/i.test(n.text)));
    });

    test("reopening can be turned off, and never happens when the same file is uploaded again", async () => {
        const { t, admin, project, branch } = await setup();
        const first = report(A, B);
        expectStatus(await t.upload(admin, project, { branch, report: first }), 200);
        const a = await issueAt(t, admin, project, branch, "src/a.ts");
        expectStatus(await t.updateIssue(admin, project, branch, a.id, { status: "resolved" }), 200);

        const same = await t.upload(admin, project, { branch, report: first, confirm: true });
        expectStatus(same, 200);
        assert.equal(same.body.reopened, 0);

        const off = await t.upload(admin, project, { branch, report: report(A, C), confirm: true, reopen: false });
        expectStatus(off, 200);
        assert.equal(off.body.reopened, 0);
        assert.equal((await t.getIssue(admin, project, branch, a.id)).body.status, "resolved");
    });

    test("a file that isn't an OCR report is refused and the current report stays", async () => {
        const { t, admin, project, branch } = await setup();
        expectStatus(await t.upload(admin, project, { branch, report: report(A) }), 200);
        expectStatus(await t.upload(admin, project, { branch, report: { not: "a report" }, confirm: true }), 422);
        expectStatus(await t.upload(admin, project, { branch, report: { comments: [{ path: "x.ts" }] }, confirm: true }), 422);
        assert.equal((await t.listIssues(admin, project, branch)).body.total, 1);
    });

    test("findings added by hand survive a new report, unless it contains them itself", async () => {
        const { t, admin, project, branch } = await setup();
        expectStatus(await t.upload(admin, project, { branch, report: report(A) }), 200);
        const added = await t.addFinding(admin, project, branch, {
            ...finding("src/manual.ts", "Spotted by hand: the lock is never released."),
            severity: "high",
        });
        expectStatus(added, 201);
        assert.ok(added.body.issue.addedBy);

        const r = await t.upload(admin, project, { branch, report: report(B), confirm: true });
        expectStatus(r, 200);
        assert.equal(r.body.keptAdded, 1);
        const manual = await issueAt(t, admin, project, branch, "src/manual.ts");
        assert.equal(manual.severity, "high");
    });

    test("an identical finding can't be added twice", async () => {
        const { t, admin, project, branch } = await setup();
        expectStatus(await t.upload(admin, project, { branch, report: report(A) }), 200);
        const f = finding("src/dup.ts", "The same problem, reported twice by hand.");
        expectStatus(await t.addFinding(admin, project, branch, f), 201);
        expectStatus(await t.addFinding(admin, project, branch, f), 409);
    });

    test(
        "a finding can be added by hand to a branch that has no report yet",
        knownGap("legacy", "the route looks the branch up before adding, so it answers 404"),
        async () => {
            const { t, admin, project, branch } = await setup();
            expectStatus(
                await t.addFinding(admin, project, branch, finding("src/new.ts", "Found before any OCR run on this branch.")),
                201,
            );
            assert.equal((await t.listIssues(admin, project, branch)).body.total, 1);
        },
    );

    test("an upload link accepts exactly one report, without any other credential", async () => {
        const { t, admin, project, branch } = await setup();
        const ci = await t.token(admin, "upload");
        const link = await t.createUploadLink(ci, project, { branch });
        expectStatus(link, 201);
        assert.match(link.body.url, /^https?:\/\//);
        expectStatus(await t.useUploadLink(link.body.url, report(A, B)), 200);
        assert.equal((await t.listIssues(admin, project, branch)).body.total, 2);
        expectStatus(await t.useUploadLink(link.body.url, report(C)), 410);
    });

    test("tokens without upload access can't make upload links", async () => {
        const { t, admin, project, branch } = await setup();
        const read = await t.token(admin, "read");
        expectStatus(await t.createUploadLink(read, project, { branch }), 403);
    });
});
