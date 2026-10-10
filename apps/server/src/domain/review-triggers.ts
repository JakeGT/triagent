// When a pull request is reviewed, decided in one place for the webhook and the poller alike
// (services/github/automation.ts gathers what this needs from GitHub and acts on the answer).
// Pure functions: the decision and its reason in words, the checks on a commit summed up, the
// fingerprint of a diff, and the patterns for files a project doesn't review.

import { createHash } from "node:crypto";

/** The label that asks for a review (removed once it's queued), and the one that stops automatic ones. */
export const REVIEW_LABEL = "review";
export const SKIP_LABEL = "skip-review";

/** A repository with no checks is reviewed once none have appeared for this long. */
export const NO_CHECKS_WAIT_MS = 2 * 60_000;

/** GitHub's author_association values for people who can write to the repository. */
const CAN_WRITE = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function canAsk(association: string | null | undefined): boolean {
    return CAN_WRITE.has(String(association ?? "NONE").toUpperCase());
}

/** Whether a comment asks for a review: its first line starts with `/review` (not `/reviewer`). */
export function isReviewCommand(body: unknown): boolean {
    if (typeof body !== "string") return false;
    const first = body.slice(0, 200).split(/\r?\n/, 1)[0] ?? "";
    return /^\/review(?:\s|$)/.test(first.trimStart());
}

/** GitHub's own mark of a bot account, or the "[bot]" every app's login ends with. */
export function isBot(user: { login?: string | null; type?: string | null } | null | undefined): boolean {
    return user?.type === "Bot" || Boolean(user?.login?.toLowerCase().endsWith("[bot]"));
}

// ---- paths a project doesn't review ---------------------------------------------------------------

/** One path segment against a pattern segment: `*` is any run of characters, `?` any one. Never a regular expression. */
function segmentMatches(pattern: string, text: string): boolean {
    let p = 0;
    let t = 0;
    let star = -1;
    let mark = 0;
    while (t < text.length) {
        if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
            p++;
            t++;
        } else if (p < pattern.length && pattern[p] === "*") {
            star = p++;
            mark = t;
        } else if (star !== -1) {
            p = star + 1;
            t = ++mark;
        } else return false;
    }
    while (pattern[p] === "*") p++;
    return p === pattern.length;
}

/**
 * Whether `file` (a path in the repository) matches `pattern`, read much as .gitignore reads one:
 * `*` and `?` stay within a directory, `**` spans directories, a pattern with no slash matches a file
 * of that name in any directory (`*.md`) unless it starts with one (`/package-lock.json`), and one
 * ending in a slash matches everything under it.
 */
export function matchesPath(pattern: string, file: string): boolean {
    const trimmed = pattern.trim();
    // A leading slash: from the top of the repository only.
    const anchored = /^\.?\//.test(trimmed);
    let glob = trimmed.replace(/^\.?\//, "");
    if (!glob) return false;
    if (glob.endsWith("/")) glob += "**";
    const parts = glob.split("/").filter(Boolean);
    const names = file.split("/").filter(Boolean);
    if (parts.length === 1 && parts[0] !== "**" && !anchored) return segmentMatches(parts[0] as string, names.at(-1) ?? "");
    // reach[j]: the pattern so far can match the first j directories and file name.
    let reach = new Array<boolean>(names.length + 1).fill(false);
    reach[0] = true;
    for (const part of parts) {
        const next = new Array<boolean>(names.length + 1).fill(false);
        for (let j = 0; j <= names.length; j++) {
            if (part === "**") next[j] = Boolean(reach[j]) || (j > 0 && Boolean(next[j - 1]));
            else next[j] = j > 0 && Boolean(reach[j - 1]) && segmentMatches(part, names[j - 1] as string);
        }
        reach = next;
    }
    return Boolean(reach[names.length]);
}

/** The patterns that between them cover every file, or null if some file matches none (or there are no files). */
export function coveringPatterns(patterns: readonly string[], files: readonly string[]): string[] | null {
    if (!patterns.length || !files.length) return null;
    const used = new Set<string>();
    for (const file of files) {
        const hit = patterns.find((p) => matchesPath(p, file));
        if (!hit) return null;
        used.add(hit);
    }
    return patterns.filter((p) => used.has(p));
}

// ---- the fingerprint of a diff --------------------------------------------------------------------

/** A diff larger than this has no fingerprint (so the "same changes" rule doesn't apply to it). */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/**
 * A hash of what a unified diff changes: each file's name and its added and removed lines. Not commit
 * ids, where the hunks sit or their context, so the same changes on a moved base hash the same. Binary
 * files count by the id of their new content. Null for a diff too large, or one that can't be read.
 */
export function diffFingerprint(diff: string | null | undefined): string | null {
    if (typeof diff !== "string" || diff.length > MAX_DIFF_BYTES) return null;
    const hash = createHash("sha256");
    const lines = diff.split("\n");
    let oldLeft = 0;
    let newLeft = 0;
    let index = "";
    for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (oldLeft > 0 || newLeft > 0) {
            // Inside a hunk: as many old and new lines as its header said.
            const c = line[0];
            if (c === "+") newLeft--;
            else if (c === "-") oldLeft--;
            else if (c === "\\") {
                hash.update(`${line}\n`);
                continue;
            } else {
                oldLeft--;
                newLeft--;
                continue;
            }
            hash.update(`${line}\n`);
            continue;
        }
        const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
        if (hunk) {
            oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
            newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
            continue;
        }
        if (line.startsWith("diff --git ")) {
            index = "";
            hash.update(`${line}\n`);
        } else if (line.startsWith("index ")) index = line;
        else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
            // Which bytes changed isn't in the diff: the new content's id (after "..") stands for them.
            hash.update(`binary ${/\.\.([0-9a-f]+)/.exec(index)?.[1] ?? ""}\n`);
        } else if (/^(?:new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to) /.test(line))
            hash.update(`${line}\n`);
        else if (line.startsWith("\\")) hash.update(`${line}\n`);
    }
    // A hunk cut short: not a whole diff, so nothing to compare by.
    if (oldLeft > 0 || newLeft > 0) return null;
    return hash.digest("hex");
}

// ---- checks ----------------------------------------------------------------------------------------

export interface CheckRun {
    name: string;
    /** queued, in_progress, completed… */
    status: string;
    /** success, failure, neutral, cancelled, skipped, timed_out, action_required… (once completed). */
    conclusion: string | null;
}

export interface CommitStatus {
    context: string;
    /** success, pending, failure or error. */
    state: string;
}

/** What the checks on a commit come to. */
export type Checks =
    | { state: "passed"; total: number }
    | { state: "pending"; total: number; waiting: number }
    | { state: "failed"; total: number; failed: string[] }
    /** Nothing has reported on the commit (yet). */
    | { state: "none" }
    /** GitHub won't show this connection the check runs (the app lacks "Checks: read"), and what it does show has passed. */
    | { state: "unreadable" }
    /** Asking failed this time: not known, to be asked again. */
    | { state: "unknown"; error: string };

const PASSED = new Set(["success", "neutral", "skipped"]);

/**
 * Sum up a commit's check runs and commit statuses, leaving out the status Triagent sets itself
 * (`own`). Either list is "unreadable" when GitHub refuses it to this connection: the other still counts.
 */
export function summariseChecks(
    runs: readonly CheckRun[] | "unreadable",
    statuses: readonly CommitStatus[] | "unreadable",
    own: string,
): Checks {
    const failed: string[] = [];
    let waiting = 0;
    let total = 0;
    for (const r of runs === "unreadable" ? [] : runs) {
        total++;
        if (r.status !== "completed") waiting++;
        else if (!PASSED.has(String(r.conclusion))) failed.push(r.name);
    }
    for (const s of statuses === "unreadable" ? [] : statuses) {
        if (s.context === own) continue;
        total++;
        if (s.state === "pending") waiting++;
        else if (s.state !== "success") failed.push(s.context);
    }
    if (failed.length) return { state: "failed", total, failed: [...new Set(failed)].sort() };
    if (waiting) return { state: "pending", total, waiting };
    if (runs === "unreadable" || statuses === "unreadable") return { state: "unreadable" };
    return total ? { state: "passed", total } : { state: "none" };
}

// ---- the decision ----------------------------------------------------------------------------------

export interface TriggerSettings {
    /** Automatic reviews are on for the project. */
    enabled: boolean;
    firstReview: "checks" | "ready" | "manual";
    skipPaths: readonly string[];
    skipBots: boolean;
}

/** Someone asking for a review: with a `/review` comment, or the `review` label. */
export type ReviewRequest = { via: "comment"; by: string; association: string | null } | { via: "label" };

export interface DecisionInput {
    pull: { headSha: string; draft: boolean; author: string | null; bot: boolean; labels: readonly string[] };
    settings: TriggerSettings;
    /** What Triagent has recorded about the pull request. */
    state: {
        reviewedSha: string | null;
        /** The fingerprint of the diff that was reviewed, if one could be taken. */
        reviewedFingerprint: string | null;
        /** A commit whose review failed or was cancelled. */
        attemptedSha: string | null;
        /** It was open when automatic reviews were switched on, and hasn't been pushed to since. */
        baseline: boolean;
        /** Reviews of this pull request that are queued or running. */
        active: readonly { status: string; headSha: string | null }[];
    };
    /** This check is the first with automatic reviews on: it sets the baseline. */
    settingBaseline?: boolean;
    /** Why a fork's pull request waits for approval (the reviewPullRequestsFrom rule), or null. */
    approval?: string | null;
    request?: ReviewRequest | null;
    /** When this head commit was first seen, and the time now (for a repository with no checks). */
    firstSeenAt: number;
    now: number;
    // What's only asked of GitHub when the decision needs it: left out until then (the answer says which it needs).
    checks?: Checks;
    /** The files the pull request changes; null when there are too many to tell, "unknown" when asking failed. */
    files?: readonly string[] | null | "unknown";
    /** The fingerprint of the head commit's diff; null when it has none. */
    fingerprint?: string | null;
    /** Commits on the head that the reviewed commit doesn't have; null when GitHub can't say (a rebase). */
    commitsSince?: number | null;
}

export type Need = "checks" | "files" | "fingerprint" | "commitsSince";

export type DecisionCode =
    | "asked"
    | "refused"
    | "running"
    | "draft"
    | "baseline"
    | "reviewed"
    | "attempted"
    | "off"
    | "approval"
    | "skip-label"
    | "bot"
    | "earlier-running"
    | "same-changes"
    | "commits-since"
    | "manual"
    | "skip-paths"
    | "ready"
    | "checks-passed"
    | "checks-pending"
    | "checks-failed"
    | "checks-none"
    | "checks-unreadable"
    | "checks-unknown"
    | "files-unknown"
    | "over-budget";

export type Decision =
    /** Ask GitHub for this, and decide again with it. */
    | { action: "need"; need: Need }
    | {
          /**
           * review: queue one. wait: not yet, look again. skip: not reviewed. carry: the reviewed commit's
           * review stands for this one too (same changes). refuse: someone asked who may not.
           */
          action: "review" | "wait" | "skip" | "carry" | "refuse";
          code: DecisionCode;
          /** The reason, in words that follow "Queued:" or "Not queued:". */
          why: string;
          /** The pull request's state in a few words, for the Pull requests page; null to leave it as it is. */
          status: string | null;
      };

const short = (sha: string | null | undefined) => (sha ?? "").slice(0, 7);
const HOW_TO_ASK = "comment /review on the pull request, add the review label, or use Review now";

/**
 * Over the month's budget: automatic reviews wait. The budget arrives with cost controls (Phase 6 of
 * the plan); until then nothing is ever over it. Asking for a review is never stopped by this.
 */
export function overBudget(_input: DecisionInput): Decision | null {
    return null;
}

/** An automatic review about to be queued, unless something that only stops automatic reviews says otherwise. */
function automatic(input: DecisionInput, code: DecisionCode, why: string): Decision {
    return overBudget(input) ?? { action: "review", code, why, status: "queued" };
}

/**
 * Whether to review a pull request's head commit now, and why (or why not). Someone asking is decided
 * first, and needs neither green checks nor a pull request that's ready; everything after that is
 * about reviews Triagent starts by itself.
 */
export function decide(input: DecisionInput): Decision {
    const { pull, settings, state } = input;
    const sha = pull.headSha;
    const sameCommit = state.active.find((j) => j.headSha === sha);

    if (input.request) {
        const r = input.request;
        if (r.via === "comment" && !canAsk(r.association))
            return {
                action: "refuse",
                code: "refused",
                why: `${r.by} asked with /review, but only people with write access to the repository can`,
                status: null,
            };
        const who = r.via === "comment" ? `${r.by} asked with /review` : "the review label was added";
        if (sameCommit)
            return {
                action: "skip",
                code: "running",
                why: `${who}, and a review of this commit is already ${sameCommit.status}`,
                status: null,
            };
        const behind = state.active.some((j) => j.status === "running");
        return {
            action: "review",
            code: "asked",
            why: `${who}${behind ? "; it starts when the review of this pull request that's running has finished" : ""}`,
            status: "queued",
        };
    }

    if (sameCommit)
        return { action: "skip", code: "running", why: `a review of this commit is already ${sameCommit.status}`, status: null };
    if (pull.draft) return { action: "skip", code: "draft", why: "it's a draft", status: "draft" };
    const baseline =
        "it was already open when automatic reviews were switched on; its next push will be reviewed once its checks pass, or use Review now";
    if (input.settingBaseline && state.reviewedSha !== sha)
        return { action: "skip", code: "baseline", why: baseline, status: "not reviewed (was already open)" };
    if (state.reviewedSha === sha) return { action: "skip", code: "reviewed", why: "this commit was already reviewed", status: null };
    if (state.attemptedSha === sha)
        return {
            action: "skip",
            code: "attempted",
            why: "its last review of this commit failed or was cancelled; use Review now to try again",
            status: null,
        };
    if (state.baseline) return { action: "skip", code: "baseline", why: baseline, status: "not reviewed (was already open)" };
    if (!settings.enabled)
        return {
            action: "skip",
            code: "off",
            why: "automatic reviews are off for this project; use Review now, or switch them on in Automation settings",
            status: "not reviewed (automatic reviews are off)",
        };
    if (input.approval) return { action: "skip", code: "approval", why: input.approval, status: "waiting for approval" };
    if (pull.labels.includes(SKIP_LABEL))
        return {
            action: "skip",
            code: "skip-label",
            why: `it has the label ${SKIP_LABEL}; to review it anyway, ${HOW_TO_ASK}`,
            status: `skipped: label ${SKIP_LABEL}`,
        };
    if (pull.bot && settings.skipBots)
        return {
            action: "skip",
            code: "bot",
            why: `it was opened by a bot${pull.author ? ` (${pull.author})` : ""}; to review it anyway, ${HOW_TO_ASK}`,
            status: "skipped: opened by a bot",
        };

    // Later pushes: a review of an earlier commit exists, or is on its way.
    const earlier = state.active[0];
    if (earlier && !state.reviewedSha)
        return {
            action: "skip",
            code: "earlier-running",
            why: `a review of an earlier commit (${short(earlier.headSha)}) is ${earlier.status}, and later pushes aren't reviewed until someone asks: ${HOW_TO_ASK}`,
            status: `review of ${short(earlier.headSha)} ${earlier.status}`,
        };
    if (state.reviewedSha) {
        const at = short(state.reviewedSha);
        if (state.reviewedFingerprint) {
            if (input.fingerprint === undefined) return { action: "need", need: "fingerprint" };
            if (input.fingerprint === state.reviewedFingerprint)
                return {
                    action: "carry",
                    code: "same-changes",
                    why: `it has the same changes as the reviewed commit (${at}): a rebase, or a merge from the base, so that review stands`,
                    status: "same changes as the reviewed commit",
                };
        }
        if (input.commitsSince === undefined) return { action: "need", need: "commitsSince" };
        const n = input.commitsSince;
        const since = n === null ? "new commits" : `${n} commit${n === 1 ? "" : "s"}`;
        return {
            action: "skip",
            code: "commits-since",
            why: `${since} since the last review (of ${at}), and later pushes aren't reviewed until someone asks: ${HOW_TO_ASK}`,
            status: `reviewed at ${at}, ${since} since`,
        };
    }

    // The first review.
    if (settings.firstReview === "manual")
        return {
            action: "skip",
            code: "manual",
            why: `this project only reviews pull requests when asked: ${HOW_TO_ASK}`,
            status: "not reviewed (only when asked)",
        };
    if (settings.skipPaths.length) {
        if (input.files === undefined) return { action: "need", need: "files" };
        if (input.files === "unknown")
            return {
                action: "wait",
                code: "files-unknown",
                why: "couldn't ask GitHub which files it changes; trying again at the next check",
                status: "waiting (couldn't read its files)",
            };
        const only = input.files ? coveringPatterns(settings.skipPaths, input.files) : null;
        if (only)
            return {
                action: "skip",
                code: "skip-paths",
                why: `it only changes files this project doesn't review (${only.join(", ")}); to review it anyway, ${HOW_TO_ASK}`,
                status: `skipped: only ${only.join(", ")}`,
            };
    }
    if (settings.firstReview === "ready") return automatic(input, "ready", "it's ready for review, and hasn't been reviewed yet");
    if (input.checks === undefined) return { action: "need", need: "checks" };
    const checks = input.checks;
    switch (checks.state) {
        case "passed":
            return automatic(
                input,
                "checks-passed",
                `it's ready for review and its ${checks.total === 1 ? "check has" : `${checks.total} checks have`} passed`,
            );
        case "pending":
            return {
                action: "wait",
                code: "checks-pending",
                why: `waiting for ${checks.waiting} of ${checks.total} checks`,
                status: `waiting for checks (${checks.waiting} of ${checks.total})`,
            };
        case "failed":
            return {
                action: "skip",
                code: "checks-failed",
                why: `checks failed (${checks.failed.slice(0, 5).join(", ")}${checks.failed.length > 5 ? ` and ${checks.failed.length - 5} more` : ""}); it's reviewed once they pass, or ${HOW_TO_ASK}`,
                status: "checks failed",
            };
        case "none": {
            const left = input.firstSeenAt + NO_CHECKS_WAIT_MS - input.now;
            if (left <= 0)
                return automatic(input, "checks-none", "it's ready for review, and no checks appeared on the commit within two minutes");
            return {
                action: "wait",
                code: "checks-none",
                why: "waiting to see whether any checks start on the commit (two minutes); with none, it's reviewed then",
                status: "waiting for checks to start",
            };
        }
        case "unreadable":
            return automatic(input, "checks-unreadable", "can't see checks, so reviewing when ready");
        case "unknown":
            return {
                action: "wait",
                code: "checks-unknown",
                why: `couldn't ask GitHub about its checks (${checks.error.slice(0, 200)}); trying again at the next check`,
                status: "waiting for checks (couldn't read them)",
            };
    }
}
