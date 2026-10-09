// Which parts of a finished review didn't finish (domain/review-metrics.ts has its tokens and timings), and the
// comment and commit status Triagent posts on a pull request. Pure functions, so they're easy to test.

import { SEVERITIES, type Severity } from "@triagent/shared";
import type { Issue } from "./report.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

export interface ReviewGaps {
    /** File groups whose review didn't finish. */
    groups: number;
    files: string[];
    reasons: string[];
    /** Models whose review failed, when the review ran with several. */
    models: string[];
    note: string;
}

/**
 * What OCR says it couldn't finish, from its report's warnings (e.g. `review_round_failed` for a group of
 * files). It still reports such a run as complete, with the findings it did get. Warnings about repairs it
 * made along the way lose nothing and don't count. A review run with several models also lists those that
 * failed (`model_failed`, domain/merge.ts). Null when nothing was lost.
 */
export function reviewGaps(report: unknown): ReviewGaps | null {
    const warnings = Array.isArray(obj(report).warnings) ? (obj(report).warnings as unknown[]) : [];
    // Only warnings OCR writes (objects with a string type); anything else in the list is skipped.
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    const failedModels = warnings.map(obj).filter((w) => text(w.type) === "model_failed");
    const lost = warnings
        .map(obj)
        .filter((w) => text(w.type) !== "model_failed" && /fail|budget|skip|timeout|cancel|incomplete/i.test(text(w.type)));
    if (!lost.length && !failedModels.length) return null;
    const models = [...new Set(failedModels.map((w) => text(w.model).slice(0, 200)).filter(Boolean))].slice(0, 10);
    const files = [
        ...new Set(
            lost.flatMap((w) =>
                text(w.file)
                    .split(",")
                    .map((f) => f.trim())
                    .filter(Boolean),
            ),
        ),
    ].slice(0, 200);
    const reasons = [...new Set(lost.map((w) => text(w.message).slice(0, 300)).filter(Boolean))].slice(0, 10);
    const n = lost.length;
    const shown = files.slice(0, 3).join(", ");
    const more = files.length > 3 ? ` and ${files.length - 3} more file${files.length - 3 === 1 ? "" : "s"}` : "";
    const parts: string[] = [];
    // Not why: a model's error is the runner's (paths, OCR's output), and this note is posted on GitHub.
    if (models.length) parts.push(`${models.join(", ")} didn't finish`);
    if (n)
        parts.push(
            `${n} file group${n === 1 ? "" : "s"}${files.length ? ` (${shown}${more})` : ""}` +
                `${reasons.length ? `, ${reasons.slice(0, 2).join("; ")}${reasons.length > 2 ? "; …" : ""}` : ""}`,
        );
    const note = `Part of the review didn't finish: ${parts.join("; and ")}. The findings it did get are included.`;
    return { groups: n, files, reasons, models, note };
}

const ZWSP = "\u200B"; // zero-width space
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/**
 * Text from the model, made safe to show in a GitHub comment: one line, every Markdown character
 * escaped (so no links, emphasis or HTML), and what GitHub links after rendering broken up with a
 * zero-width space: mentions, `#12` and `owner/repo#12` references, `GH-12`, and bare addresses.
 */
export function plain(s: string, max = 140): string {
    const flat = s.replace(/[\r\n]+/g, " ").trim();
    // Cut before escaping, so an escape is never cut in half (and never between the halves of an emoji).
    const short = flat.length > max ? `${flat.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "")}…` : flat;
    return (
        short
            // One pass, so nothing is escaped twice: entities for &, < and >, a backslash before other punctuation.
            .replace(/[!-/:-@[-`{-~]/g, (c) => ENTITIES[c] ?? `\\${c}`)
            .replace(/@/g, `@${ZWSP}`)
            .replace(/#(?=\d)/g, `#${ZWSP}`)
            .replace(/\b(GH)\\-(?=\d)/gi, `$1\\-${ZWSP}`)
            .replace(/\/\\\//g, `/${ZWSP}\\/`)
            .replace(/\b(www)\\\./gi, `$1${ZWSP}\\.`)
    );
}

export const code = (s: string) =>
    `\`${s
        .replace(/`/g, "'")
        .replace(/[\r\n]/g, " ")
        .slice(0, 200)}\``;

/** A link target that can't end the Markdown link early: parentheses and spaces encoded (encodeURIComponent leaves parentheses). */
const href = (url: string) => url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

export interface CommentInput {
    marker: string;
    total: number;
    bySeverity: Record<Severity, number>;
    /** The branch's most urgent issues (critical and high), in priority order. */
    urgent: readonly Pick<Issue, "id" | "severity" | "path" | "startLine" | "title">[];
    gaps: ReviewGaps | null;
    /** The models it ran with, when there were several. */
    models?: readonly string[] | null;
    failOnCritical: boolean;
    commit: string;
    /** Links into Triagent: the branch's issues, and one issue. */
    issuesUrl: string;
    issueUrl(id: string): string;
    /** The project's Pull requests page, where Review now is. */
    pullRequestsUrl?: string | null;
}

/** The one comment Triagent keeps on a pull request, updated after every review. */
export function commentBody(c: CommentInput): string {
    const lines = [
        c.marker,
        `### Open Code Review: ${c.total ? `${c.total} finding${c.total === 1 ? "" : "s"} in this pull request` : "no findings in this pull request"}`,
        "",
    ];
    if (c.total) {
        const s = c.bySeverity;
        lines.push("| Critical | High | Medium | Low |", "|---|---|---|---|", `| ${s.critical} | ${s.high} | ${s.medium} | ${s.low} |`, "");
        const top = c.urgent.slice(0, 10);
        if (top.length) {
            lines.push("**Most urgent:**", "");
            for (const x of top) {
                const where = `${x.path}${x.startLine ? `:${x.startLine}` : ""}`;
                lines.push(`- **${x.severity}** ${code(where)} [${plain(x.title)}](${href(c.issueUrl(x.id))})`);
            }
            if (c.urgent.length > top.length) lines.push(`- …and ${c.urgent.length - top.length} more`);
            lines.push("");
        }
    }
    if (c.models && c.models.length > 1)
        lines.push(
            `Reviewed by ${c.models.length} models: ${c.models.map((m) => code(m)).join(", ")}. Findings show which found them.`,
            "",
        );
    if (c.gaps)
        lines.push(`> [!WARNING]`, `> **Partial review.** ${plain(c.gaps.note, 600)} Review it again from Triagent, or push again.`, "");
    if (c.failOnCritical && c.bySeverity.critical)
        lines.push(
            `The **Triagent** check fails because of ${c.bySeverity.critical} critical finding${c.bySeverity.critical === 1 ? "" : "s"}. Fix ${c.bySeverity.critical === 1 ? "it" : "them"}, or mark ${c.bySeverity.critical === 1 ? "it" : "them"} won't fix in Triagent, and push again.`,
            "",
        );
    lines.push(
        `[Triage these in Triagent](${href(c.issuesUrl)}). Reviewed commit ${code(c.commit.slice(0, 10))}. This comment is updated on every review.`,
    );
    // Later pushes aren't reviewed by themselves: how to ask.
    lines.push(
        "",
        `New commits aren't reviewed until someone asks. To have this pull request reviewed again, comment \`/review\`, add the \`review\` label, or use ${c.pullRequestsUrl ? `[Review now in Triagent](${href(c.pullRequestsUrl)})` : "Review now in Triagent"}.`,
    );
    return lines.join("\n");
}

/** The commit status for a finished review of a pull request. */
export function finishedStatus(input: {
    status: "done" | "partial";
    total: number;
    bySeverity: Record<Severity, number>;
    failOnCritical: boolean;
}): { state: "success" | "failure"; description: string } {
    const s = input.bySeverity;
    const counts = input.total
        ? SEVERITIES.filter((k) => s[k])
              .map((k) => `${s[k]} ${k}`)
              .join(", ")
        : "No findings";
    const description = `${counts}${input.status === "partial" ? " (partial review)" : ""}`;
    if (input.failOnCritical && s.critical) return { state: "failure", description: `${s.critical} critical: ${description}` };
    return { state: "success", description };
}
