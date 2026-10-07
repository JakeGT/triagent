import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidBranch, normaliseRepoUrl } from "../src/domain/names.ts";
import { parseReport, titleOf } from "../src/domain/report.ts";

const finding = (path: string, content: string, extra = {}) => ({
    path,
    content,
    severity: "high",
    category: "bug",
    start_line: 3,
    end_line: 4,
    ...extra,
});

test("a finding's id is stable across reports, so its triage carries over", () => {
    const a = parseReport({ comments: [finding("a.ts", "First problem here."), finding("b.ts", "Second problem here.")] }, null);
    const b = parseReport({ comments: [finding("b.ts", "Second problem here."), finding("c.ts", "Third.")] }, null);
    assert.equal(a.issues[1]?.id, b.issues[0]?.id);
    assert.notEqual(a.issues[0]?.id, a.issues[1]?.id);
});

test("identical findings get distinct ids", () => {
    const r = parseReport({ comments: [finding("a.ts", "Same."), finding("a.ts", "Same.")] }, null);
    assert.equal(new Set(r.issues.map((x) => x.id)).size, 2);
});

test("unknown severities and categories are shown as low/other, with a warning", () => {
    const r = parseReport({ comments: [finding("a.ts", "Odd values here.", { severity: "urgent", category: "vibes" })] }, null);
    assert.equal(r.issues[0]?.severity, "low");
    assert.equal(r.issues[0]?.category, "other");
    assert.equal(r.meta.warnings.length, 2);
});

test("reports that aren't OCR reports are refused with a reason", () => {
    assert.throws(() => parseReport([], null), /JSON object/);
    assert.throws(() => parseReport({}, null), /comments/);
    assert.throws(() => parseReport({ comments: [{ path: "a.ts" }] }, null), /no text/);
    assert.throws(() => parseReport({ comments: [], project_summary: 5 }, null), /project_summary/);
});

test("summary items become tasks linked to the files they name", () => {
    const r = parseReport(
        {
            comments: [
                finding("src/db/query.ts", "SQL built from strings."),
                finding("src/api/routes.ts", "No auth check."),
                finding("lib/util.ts", "Dead code."),
            ],
            project_summary:
                "## Top issues\n\n1. **Injection risk**: `src/db/query.ts` builds SQL from strings.\n2. **Auth gaps** — everything under `src/api/`.\n\n## Quick wins\n\n- Remove `util.ts` helpers.",
        },
        null,
    );
    assert.deepEqual(
        r.sections.map((s) => s.id),
        ["top-issues", "quick-wins"],
    );
    const [injection, auth, wins] = r.tasks;
    assert.equal(injection?.title, "Injection risk");
    assert.deepEqual(injection?.files, ["src/db/query.ts"]);
    assert.deepEqual(auth?.files, ["src/api/routes.ts"]);
    assert.deepEqual(wins?.files, ["lib/util.ts"]);
    assert.equal(injection?.issueIds.length, 1);
});

test("titles are the first sentence, ignoring abbreviations and code", () => {
    assert.equal(titleOf("Use `a.b()` here, e.g. in loops. Then more."), "Use `a.b()` here, e.g. in loops");
    assert.ok(titleOf("x".repeat(400)).endsWith("…"));
});

test("branch names follow git's rules", () => {
    for (const ok of ["main", "feature/x", "release-1.2", "user@fix", "a+b"]) assert.ok(isValidBranch(ok), ok);
    for (const bad of ["", "-x", "/x", ".x", "x/", "x.", "a..b", "a//b", "x.lock", "a b", "a;b", "$(x)"])
        assert.ok(!isValidBranch(bad), bad);
});

test("repository addresses are normalised to https", () => {
    assert.equal(normaliseRepoUrl("git@github.com:Owner/repo.git"), "https://github.com/Owner/repo");
    assert.equal(normaliseRepoUrl("ssh://git@github.com/Owner/repo"), "https://github.com/Owner/repo");
    assert.equal(normaliseRepoUrl("https://GitHub.com/Owner/repo/"), "https://github.com/Owner/repo");
    assert.equal(normaliseRepoUrl("https://github.com/Owner/repo/tree/main"), null);
    assert.equal(normaliseRepoUrl("javascript:alert(1)"), null);
});
