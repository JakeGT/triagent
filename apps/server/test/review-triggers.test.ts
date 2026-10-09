// When a pull request is reviewed (domain/review-triggers.ts): the decision and its reason for each
// case, the checks on a commit summed up, the fingerprint of a diff, and the patterns for skipped files.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    type Checks,
    type Decision,
    type DecisionInput,
    decide,
    diffFingerprint,
    isBot,
    isReviewCommand,
    MAX_DIFF_BYTES,
    matchesPath,
    NO_CHECKS_WAIT_MS,
    overBudget,
    summariseChecks,
} from "../src/domain/review-triggers.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const NOW = Date.parse("2026-10-09T12:00:00Z");

type Overrides = {
    pull?: Partial<DecisionInput["pull"]>;
    settings?: Partial<DecisionInput["settings"]>;
    state?: Partial<DecisionInput["state"]>;
} & Partial<Omit<DecisionInput, "pull" | "settings" | "state">>;

/** A pull request that's ready, in a project reviewing automatically once checks pass, never reviewed. */
function input(o: Overrides = {}): DecisionInput {
    const { pull, settings, state, ...rest } = o;
    return {
        pull: { headSha: HEAD, draft: false, author: "octo", bot: false, labels: [], ...pull },
        settings: { enabled: true, firstReview: "checks", skipPaths: [], skipBots: true, ...settings },
        state: { reviewedSha: null, reviewedFingerprint: null, attemptedSha: null, baseline: false, active: [], ...state },
        firstSeenAt: NOW,
        now: NOW,
        ...rest,
    };
}

type Made = Exclude<Decision, { action: "need" }>;
const made = (o: Overrides = {}): Made => {
    const d = decide(input(o));
    assert.notEqual(d.action, "need", `it asked for ${(d as { need?: string }).need}`);
    return d as Made;
};
const passed: Checks = { state: "passed", total: 4 };

describe("the first review", () => {
    test("a draft is never reviewed by itself", () => {
        const d = made({ pull: { draft: true }, checks: passed });
        assert.deepEqual([d.action, d.code, d.why, d.status], ["skip", "draft", "it's a draft", "draft"]);
    });

    test("checks are only asked about when everything else allows a review", () => {
        assert.deepEqual(decide(input()), { action: "need", need: "checks" });
        // Not for a draft, a project with automatic reviews off, or one that only reviews when asked.
        for (const o of [{ pull: { draft: true } }, { settings: { enabled: false } }, { settings: { firstReview: "manual" as const } }])
            assert.equal(decide(input(o)).action, "skip");
    });

    test("checks pending: it waits, saying for how many", () => {
        const d = made({ checks: { state: "pending", total: 4, waiting: 2 } });
        assert.deepEqual(
            [d.action, d.code, d.why, d.status],
            ["wait", "checks-pending", "waiting for 2 of 4 checks", "waiting for checks (2 of 4)"],
        );
    });

    test("checks green: reviewed", () => {
        const d = made({ checks: passed });
        assert.deepEqual([d.action, d.code, d.status], ["review", "checks-passed", "queued"]);
        assert.match(d.why, /ready for review and its 4 checks have passed/);
    });

    test("checks failed: not reviewed, saying which", () => {
        const d = made({ checks: { state: "failed", total: 3, failed: ["lint", "test"] } });
        assert.deepEqual([d.action, d.code, d.status], ["skip", "checks-failed", "checks failed"]);
        assert.match(d.why, /^checks failed \(lint, test\)/);
    });

    test("no checks at all: reviewed once none have appeared for two minutes", () => {
        const early = made({ checks: { state: "none" }, now: NOW + NO_CHECKS_WAIT_MS - 1 });
        assert.deepEqual([early.action, early.code, early.status], ["wait", "checks-none", "waiting for checks to start"]);
        const late = made({ checks: { state: "none" }, now: NOW + NO_CHECKS_WAIT_MS });
        assert.deepEqual([late.action, late.code], ["review", "checks-none"]);
        assert.match(late.why, /no checks appeared on the commit within two minutes/);
    });

    test("checks that can't be read: reviewed when ready, and it says so", () => {
        const d = made({ checks: { state: "unreadable" } });
        assert.deepEqual([d.action, d.code, d.why], ["review", "checks-unreadable", "can't see checks, so reviewing when ready"]);
    });

    test("a failed call about checks is unknown, to be tried again: never green", () => {
        const d = made({ checks: { state: "unknown", error: "GitHub said 502" } });
        assert.deepEqual([d.action, d.code], ["wait", "checks-unknown"]);
        assert.match(d.why, /couldn't ask GitHub about its checks \(GitHub said 502\); trying again/);
    });

    test('"when it\'s ready" ignores checks; "only when asked" never reviews by itself', () => {
        const ready = made({ settings: { firstReview: "ready" } });
        assert.deepEqual([ready.action, ready.code], ["review", "ready"]);
        const manual = made({ settings: { firstReview: "manual" }, checks: passed });
        assert.deepEqual([manual.action, manual.code, manual.status], ["skip", "manual", "not reviewed (only when asked)"]);
    });

    test("automatic reviews off, the baseline, a fork's author and a failed attempt are as before", () => {
        assert.equal(made({ settings: { enabled: false } }).code, "off");
        assert.equal(made({ settingBaseline: true }).status, "not reviewed (was already open)");
        assert.equal(made({ state: { baseline: true } }).code, "baseline");
        const fork = made({ approval: "it's from a fork, by stranger" });
        assert.deepEqual([fork.action, fork.status, fork.why], ["skip", "waiting for approval", "it's from a fork, by stranger"]);
        assert.match(made({ state: { attemptedSha: HEAD } }).why, /failed or was cancelled; use Review now/);
        assert.equal(made({ state: { reviewedSha: HEAD } }).why, "this commit was already reviewed");
    });
});

describe("pushes that never start a review by themselves", () => {
    test("a later push isn't reviewed, and says how many commits since", () => {
        const state = { reviewedSha: OLD };
        assert.deepEqual(decide(input({ state })), { action: "need", need: "commitsSince" });
        const d = made({ state, commitsSince: 3, checks: passed });
        assert.deepEqual([d.action, d.code, d.status], ["skip", "commits-since", "reviewed at bbbbbbb, 3 commits since"]);
        assert.match(
            d.why,
            /^3 commits since the last review \(of bbbbbbb\), and later pushes aren't reviewed until someone asks: comment \/review/,
        );
        assert.equal(made({ state, commitsSince: 1 }).status, "reviewed at bbbbbbb, 1 commit since");
        // After a rebase GitHub can't count them.
        assert.equal(made({ state, commitsSince: null }).status, "reviewed at bbbbbbb, new commits since");
    });

    test("the same diff after a rebase: the review moves to the new commit, without another", () => {
        const state = { reviewedSha: OLD, reviewedFingerprint: "f1" };
        assert.deepEqual(decide(input({ state })), { action: "need", need: "fingerprint" });
        const same = made({ state, fingerprint: "f1" });
        assert.deepEqual([same.action, same.code, same.status], ["carry", "same-changes", "same changes as the reviewed commit"]);
        // A different diff, or one too large to fingerprint, is a later push like any other.
        assert.equal(made({ state, fingerprint: "f2", commitsSince: 2 }).code, "commits-since");
        assert.equal(made({ state, fingerprint: null, commitsSince: 2 }).code, "commits-since");
        // No fingerprint was kept of the reviewed commit: the rule doesn't apply, and GitHub isn't asked for one.
        assert.deepEqual(decide(input({ state: { reviewedSha: OLD } })), { action: "need", need: "commitsSince" });
    });

    test("a push while the first review is still queued or running waits to be asked for", () => {
        const d = made({ state: { active: [{ status: "running", headSha: OLD }] }, checks: passed });
        assert.deepEqual([d.action, d.code], ["skip", "earlier-running"]);
        assert.match(d.why, /a review of an earlier commit \(bbbbbbb\) is running/);
    });

    test("only skipped paths", () => {
        const settings = { skipPaths: ["docs/**", "*.md", "**/*.lock"] };
        assert.deepEqual(decide(input({ settings })), { action: "need", need: "files" });
        const d = made({ settings, files: ["docs/a/b.txt", "README.md"] });
        assert.deepEqual([d.action, d.code, d.status], ["skip", "skip-paths", "skipped: only docs/**, *.md"]);
        // One file that needs a review, too many files to tell, or no files: reviewed as usual.
        assert.equal(made({ settings, files: ["docs/a.md", "src/a.ts"], checks: passed }).action, "review");
        assert.equal(made({ settings, files: null, checks: passed }).action, "review");
        assert.equal(made({ settings, files: [], checks: passed }).action, "review");
        // GitHub couldn't be asked: wait, rather than guess.
        assert.deepEqual(
            [made({ settings, files: "unknown" }).action, made({ settings, files: "unknown" }).code],
            ["wait", "files-unknown"],
        );
    });

    test("opened by a bot", () => {
        const d = made({ pull: { bot: true, author: "dependabot[bot]" }, checks: passed });
        assert.deepEqual([d.action, d.code, d.status], ["skip", "bot", "skipped: opened by a bot"]);
        assert.match(d.why, /opened by a bot \(dependabot\[bot\]\)/);
        assert.equal(made({ pull: { bot: true }, settings: { skipBots: false }, checks: passed }).action, "review");
        assert.equal(isBot({ login: "renovate[bot]", type: "User" }), true);
        assert.equal(isBot({ login: "app", type: "Bot" }), true);
        assert.equal(isBot({ login: "octo", type: "User" }), false);
    });

    test("the label skip-review", () => {
        const d = made({ pull: { labels: ["skip-review"] }, checks: passed });
        assert.deepEqual([d.action, d.code, d.status], ["skip", "skip-label", "skipped: label skip-review"]);
    });

    test("over budget has its place, and stops nothing yet", () => {
        assert.equal(overBudget(input({ checks: passed })), null);
    });
});

describe("asking for a review", () => {
    const collaborator = { via: "comment", by: "alice", association: "COLLABORATOR" } as const;

    test("/review from a collaborator: reviewed, whatever the checks, a draft included", () => {
        for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
            const d = made({
                request: { via: "comment", by: "alice", association },
                pull: { draft: true, bot: true, labels: ["skip-review"] },
                settings: { firstReview: "manual" },
                state: { reviewedSha: OLD, baseline: true },
                approval: "it's from a fork",
            });
            assert.deepEqual([d.action, d.code, d.why], ["review", "asked", "alice asked with /review"]);
        }
    });

    test("/review from a stranger: refused", () => {
        for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", null]) {
            const d = made({ request: { via: "comment", by: "mallory", association } });
            assert.deepEqual([d.action, d.code], ["refuse", "refused"]);
            assert.match(d.why, /mallory asked with \/review, but only people with write access/);
        }
    });

    test("the review label: reviewed", () => {
        const d = made({ request: { via: "label" }, pull: { draft: true } });
        assert.deepEqual([d.action, d.code, d.why], ["review", "asked", "the review label was added"]);
    });

    test("asked while one runs: the same commit's run stands, a newer commit waits behind it", () => {
        const same = made({ request: collaborator, state: { active: [{ status: "running", headSha: HEAD }] } });
        assert.deepEqual([same.action, same.code], ["skip", "running"]);
        assert.match(same.why, /a review of this commit is already running/);
        const newer = made({ request: collaborator, state: { active: [{ status: "running", headSha: OLD }] } });
        assert.equal(newer.action, "review");
        assert.match(newer.why, /starts when the review of this pull request that's running has finished/);
    });

    test("only a first line starting with /review asks", () => {
        for (const body of ["/review", "/review please", "  /review\nthanks", "/review\r\nmore"])
            assert.equal(isReviewCommand(body), true, body);
        for (const body of ["/reviewer", "please /review", "thanks\n/review", "", null, 5, "/Review"])
            assert.equal(isReviewCommand(body), false);
    });
});

describe("the checks on a commit", () => {
    const run = (name: string, status: string, conclusion: string | null = null) => ({ name, status, conclusion });

    test("check runs and commit statuses count together, Triagent's own status left out", () => {
        const runs = [run("build", "completed", "success"), run("lint", "completed", "skipped"), run("docs", "completed", "neutral")];
        assert.deepEqual(summariseChecks(runs, [{ context: "ci/test", state: "success" }], "Triagent"), { state: "passed", total: 4 });
        // Triagent's pending "Waiting for checks to pass" is never waited on itself.
        assert.deepEqual(summariseChecks(runs, [{ context: "Triagent", state: "pending" }], "Triagent"), { state: "passed", total: 3 });
        assert.deepEqual(summariseChecks([], [{ context: "Triagent", state: "failure" }], "Triagent"), { state: "none" });
    });

    test("pending, failed and none", () => {
        assert.deepEqual(
            summariseChecks(
                [run("build", "in_progress"), run("lint", "completed", "success")],
                [{ context: "ci", state: "pending" }],
                "Triagent",
            ),
            { state: "pending", total: 3, waiting: 2 },
        );
        assert.deepEqual(
            summariseChecks(
                [run("build", "queued"), run("test", "completed", "failure"), run("e2e", "completed", "timed_out")],
                [{ context: "ci", state: "error" }],
                "Triagent",
            ),
            { state: "failed", total: 4, failed: ["ci", "e2e", "test"] },
        );
        assert.deepEqual(summariseChecks([], [], "Triagent"), { state: "none" });
    });

    test("each API degrades on its own", () => {
        // The app can't read check runs: statuses still count, and with nothing against, it's "unreadable", not "passed".
        assert.deepEqual(summariseChecks("unreadable", [{ context: "ci", state: "success" }], "Triagent"), { state: "unreadable" });
        assert.deepEqual(summariseChecks("unreadable", [], "Triagent"), { state: "unreadable" });
        assert.deepEqual(summariseChecks("unreadable", [{ context: "ci", state: "pending" }], "Triagent"), {
            state: "pending",
            total: 1,
            waiting: 1,
        });
        assert.deepEqual(summariseChecks("unreadable", [{ context: "ci", state: "failure" }], "Triagent"), {
            state: "failed",
            total: 1,
            failed: ["ci"],
        });
        assert.deepEqual(summariseChecks([run("build", "completed", "success")], "unreadable", "Triagent"), { state: "unreadable" });
    });
});

describe("skipped paths", () => {
    test("patterns read as .gitignore reads them", () => {
        const cases: [string, string, boolean][] = [
            ["docs/**", "docs/a.md", true],
            ["docs/**", "docs/a/b/c.txt", true],
            ["docs/**", "src/docs/a.md", false],
            ["docs/", "docs/a/b.md", true],
            ["**/*.lock", "yarn.lock", true],
            ["**/*.lock", "a/b/Cargo.lock", true],
            ["**/*.lock", "a/lock", false],
            ["*.md", "README.md", true],
            ["*.md", "docs/deep/NOTES.md", true],
            ["*.md", "README.mdx", false],
            ["src/*.ts", "src/a.ts", true],
            ["src/*.ts", "src/deep/a.ts", false],
            ["src/**/gen/*.ts", "src/a/b/gen/x.ts", true],
            ["src/**/gen/*.ts", "src/gen/x.ts", true],
            ["/package-lock.json", "package-lock.json", true],
            ["/package-lock.json", "web/package-lock.json", false],
            ["a?c.txt", "abc.txt", true],
            ["a?c.txt", "a/c.txt", false],
            ["**", "anything/at/all", true],
            ["", "a", false],
        ];
        for (const [pattern, file, expected] of cases) assert.equal(matchesPath(pattern, file), expected, `${pattern} against ${file}`);
    });

    test("a pattern is only ever a pattern: nothing in it is a regular expression", () => {
        assert.equal(matchesPath("a.c", "abc"), false);
        assert.equal(matchesPath("(a|b)+", "a"), false);
        assert.equal(matchesPath("[ab].md", "a.md"), false);
        assert.equal(matchesPath("[ab].md", "[ab].md"), true);
        // One that would take a regular expression for ever is quick.
        const started = Date.now();
        assert.equal(matchesPath(`${"*a".repeat(60)}b`, `${"a".repeat(190)}c`), false);
        assert.ok(Date.now() - started < 500);
    });
});

describe("the fingerprint of a diff", () => {
    const diff = (index: string, at: string, context: string) =>
        [
            "diff --git a/src/a.ts b/src/a.ts",
            `index ${index} 100644`,
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            `@@ ${at} @@ function a() {`,
            ` ${context}`,
            "-const a = 1;",
            "+const a = 2;",
            "+const b = 3;",
            " }",
            "",
        ].join("\n");

    test("the same changes hash the same wherever they sit: not commit ids, hunk positions or context", () => {
        const one = diffFingerprint(diff("1111111..2222222", "-10,3 +10,4", "// before"));
        assert.match(one ?? "", /^[0-9a-f]{64}$/);
        assert.equal(diffFingerprint(diff("3333333..4444444", "-40,3 +52,4", "// moved, with other lines around it")), one);
    });

    test("a changed line, another file, or a removed line that looks like a header changes it", () => {
        const base = diff("1..2", "-10,3 +10,4", "x");
        const one = diffFingerprint(base);
        assert.notEqual(diffFingerprint(base.replace("+const b = 3;", "+const b = 4;")), one);
        assert.notEqual(diffFingerprint(base.replaceAll("src/a.ts", "src/b.ts")), one);
        assert.notEqual(diffFingerprint(base.replace("-const a = 1;", "--- a/src/a.ts")), one);
    });

    test("binary files count by their new content; a diff too large or cut short has no fingerprint", () => {
        const binary = (to: string) =>
            `diff --git a/logo.png b/logo.png\nindex aaaaaaa..${to} 100644\nBinary files a/logo.png and b/logo.png differ\n`;
        assert.notEqual(diffFingerprint(binary("bbbbbbb")), diffFingerprint(binary("ccccccc")));
        assert.equal(diffFingerprint(binary("bbbbbbb")), diffFingerprint(binary("bbbbbbb")));
        assert.equal(diffFingerprint("x".repeat(MAX_DIFF_BYTES + 1)), null);
        assert.equal(diffFingerprint("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n-a\n"), null);
        assert.equal(diffFingerprint(null), null);
    });
});
