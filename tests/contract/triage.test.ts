// Triage: statuses and revisions, rating corrections, duplicates, claiming work, bulk changes and notes.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expectStatus, finding, issueAt, report, skip, unique, useTarget } from "./harness/index.ts";

describe("triage", { skip }, () => {
    const target = useTarget();
    const branch = "main";

    /** A project whose main branch has one finding per entry in `severities`, at src/<severity>.ts. */
    async function setup(severities: string[] = ["critical", "high", "medium", "low"]) {
        const t = target();
        const admin = await t.admin();
        const project = unique("triage");
        expectStatus(await t.createProject(admin, project), 201);
        const findings = severities.map((s, i) => finding(`src/${s}${i}.ts`, `A ${s} problem number ${i} in this file.`, { severity: s }));
        expectStatus(await t.upload(admin, project, { branch, report: report(...findings) }), 200);
        const at = (s: string, i: number) => issueAt(t, admin, project, branch, `src/${s}${i}.ts`);
        return { t, admin, project, at };
    }

    test("each change bumps the issue's revision, and a stale revision is refused with the current version", async () => {
        const { t, admin, project, at } = await setup(["medium"]);
        const issue = await at("medium", 0);
        assert.equal(issue.rev, 0);
        const first = await t.updateIssue(admin, project, branch, issue.id, { status: "in_progress", assignee: "alice", rev: 0 });
        expectStatus(first, 200);
        assert.equal(first.body.issue.rev, 1);
        assert.equal(first.body.issue.assignee, "alice");

        const stale = await t.updateIssue(admin, project, branch, issue.id, { status: "resolved", rev: 0 });
        expectStatus(stale, 409);
        assert.equal(stale.body.current.rev, 1);
        assert.equal(stale.body.current.status, "in_progress");
    });

    test("a no-op change reports that nothing changed", async () => {
        const { t, admin, project, at } = await setup(["low"]);
        const issue = await at("low", 0);
        const r = await t.updateIssue(admin, project, branch, issue.id, { status: "open" });
        expectStatus(r, 200);
        assert.equal(r.body.changed, false);
    });

    test("correcting a rating keeps the reviewer's original and records the change", async () => {
        const { t, admin, project, at } = await setup(["low"]);
        const issue = await at("low", 0);
        const raised = await t.updateIssue(admin, project, branch, issue.id, {
            severity: "critical",
            category: "security",
            note: "Reachable from the public API.",
        });
        expectStatus(raised, 200);
        const view = (await t.getIssue(admin, project, branch, issue.id)).body;
        assert.equal(view.severity, "critical");
        assert.equal(view.reviewerSeverity, "low");
        assert.equal(view.category, "security");
        assert.equal(view.reviewerCategory, "bug");
        assert.ok(view.notes.some((n: { text: string }) => /low to critical/.test(n.text)));

        // The corrected rating is what filters use.
        const critical = await t.listIssues(admin, project, branch, { severity: "critical" });
        assert.ok(critical.body.items.some((x: { id: string }) => x.id === issue.id));

        expectStatus(await t.updateIssue(admin, project, branch, issue.id, { severity: "reviewer", category: "reviewer" }), 200);
        const restored = (await t.getIssue(admin, project, branch, issue.id)).body;
        assert.equal(restored.severity, "low");
        assert.equal(restored.reviewerSeverity, null);
        assert.equal(restored.category, "bug");
    });

    test("duplicates become won't fix, point at the original of a chain, and can be undone", async () => {
        const { t, admin, project, at } = await setup(["medium", "medium", "medium"]);
        const [a, b, c] = [await at("medium", 0), await at("medium", 1), await at("medium", 2)];

        const marked = await t.updateIssue(admin, project, branch, a.id, { duplicateOf: b.id });
        expectStatus(marked, 200);
        assert.equal(marked.body.issue.status, "wont_fix");
        assert.equal(marked.body.issue.duplicateOf, b.id);

        // c → a, which is itself a duplicate of b, so c points at b.
        const chained = await t.updateIssue(admin, project, branch, c.id, { duplicateOf: a.id });
        assert.equal(chained.body.issue.duplicateOf, b.id);

        expectStatus(await t.updateIssue(admin, project, branch, b.id, { duplicateOf: b.id }), 400);
        expectStatus(await t.updateIssue(admin, project, branch, b.id, { duplicateOf: a.id }), 400); // a loop
        expectStatus(await t.updateIssue(admin, project, branch, b.id, { duplicateOf: "ocr-00000000" }), 404);

        const original = (await t.getIssue(admin, project, branch, b.id)).body;
        assert.deepEqual(original.duplicates.map((d: { id: string }) => d.id).sort(), [a.id, c.id].sort());

        const undone = await t.updateIssue(admin, project, branch, a.id, { duplicateOf: null });
        expectStatus(undone, 200);
        assert.equal(undone.body.issue.duplicateOf, null);
        assert.equal(undone.body.issue.status, "open");
    });

    test("claiming hands out the most urgent open, unassigned issue, never one flagged for discussion", async () => {
        const { t, admin, project, at } = await setup(["low", "critical", "high"]);
        const high = await at("high", 2);
        expectStatus(await t.updateIssue(admin, project, branch, high.id, { needsDiscussion: true }), 200);
        const agent1 = await t.token(admin, "write");
        const agent2 = await t.token(admin, "write");

        const first = await t.claimNext(agent1, project, branch);
        expectStatus(first, 200);
        assert.equal(first.body.issue.severity, "critical");
        assert.equal(first.body.issue.status, "in_progress");
        assert.equal(first.body.issue.assignee, agent1.name);

        const second = await t.claimNext(agent2, project, branch);
        assert.equal(second.body.issue.severity, "low");
        assert.equal(second.body.issue.assignee, agent2.name);

        const none = await t.claimNext(agent2, project, branch);
        expectStatus(none, 200);
        assert.equal(none.body.issue, null);
    });

    test("only the assignee releases a claim unless forced, and an in-progress issue goes back to open", async () => {
        const { t, admin, project } = await setup(["high"]);
        const agent1 = await t.token(admin, "write");
        const agent2 = await t.token(admin, "write");
        const claimed = (await t.claimNext(agent1, project, branch)).body.issue;

        expectStatus(await t.releaseIssue(agent2, project, branch, claimed.id), 409);
        const forced = await t.releaseIssue(agent2, project, branch, claimed.id, { force: true, note: "Agent 1 stopped responding." });
        expectStatus(forced, 200);
        assert.equal(forced.body.issue.status, "open");
        assert.equal(forced.body.issue.assignee, null);
    });

    test("bulk updates change many issues at once, but take no revision", async () => {
        const { t, admin, project, at } = await setup(["medium", "low", "high"]);
        const ids = [(await at("medium", 0)).id, (await at("low", 1)).id];
        const r = await t.bulkUpdate(admin, project, branch, { ids, status: "resolved", note: "Fixed in one commit." });
        expectStatus(r, 200);
        assert.equal(r.body.matched, 2);
        assert.equal(r.body.changed, 2);
        const resolved = await t.listIssues(admin, project, branch, { status: "resolved" });
        assert.equal(resolved.body.total, 2);

        expectStatus(await t.bulkUpdate(admin, project, branch, { ids, status: "open", rev: 1 }), 400);
        expectStatus(await t.bulkUpdate(admin, project, branch, { ids: ["ocr-00000000"], status: "open" }), 404);
    });

    test("people edit and delete their own notes; admins can also delete anyone's", async () => {
        const { t, admin, project, at } = await setup(["medium"]);
        const issue = await at("medium", 0);
        const alice = await t.user("editor");
        const bob = await t.user("editor");

        const noted = await t.updateIssue(alice, project, branch, issue.id, { note: "Looking at this now." });
        expectStatus(noted, 200);
        const note = (await t.getIssue(alice, project, branch, issue.id)).body.notes.at(-1);
        assert.equal(note.text, "Looking at this now.");

        expectStatus(await t.editNote(bob, project, branch, issue.id, note.id, "Not my note."), 403);
        expectStatus(await t.deleteNote(bob, project, branch, issue.id, note.id), 403);
        const edited = await t.editNote(alice, project, branch, issue.id, note.id, "Fixed in the next commit.");
        expectStatus(edited, 200);
        assert.equal(edited.body.note.text, "Fixed in the next commit.");

        expectStatus(await t.deleteNote(admin, project, branch, issue.id, note.id), 200);
        const notes = (await t.getIssue(admin, project, branch, issue.id)).body.notes;
        assert.ok(!notes.some((n: { id: string }) => n.id === note.id));
    });

    test("filters narrow the list and counts describe the filtered set", async () => {
        const { t, admin, project, at } = await setup(["critical", "high", "high", "low"]);
        expectStatus(await t.updateIssue(admin, project, branch, (await at("high", 1)).id, { status: "resolved" }), 200);
        const high = await t.listIssues(admin, project, branch, { severity: "high" });
        assert.equal(high.body.total, 2);
        const openHigh = await t.listIssues(admin, project, branch, { severity: "high", status: "open" });
        assert.equal(openHigh.body.total, 1);
        const search = await t.listIssues(admin, project, branch, { q: "critical problem" });
        assert.equal(search.body.total, 1);
    });
});
