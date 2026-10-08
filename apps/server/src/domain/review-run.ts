// What a finished review's report says beyond its findings (tokens, timings, what didn't finish), and the
// comment and commit status Triagent posts on a pull request. Pure functions, so they're easy to test.

import { SEVERITIES, type Severity } from "@triagent/shared";
import type { Issue } from "./report.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);

export interface ReviewGaps {
    /** File groups whose review didn't finish. */
    groups: number;
    files: string[];
    reasons: string[];
    note: string;
}

/**
 * What OCR says it couldn't finish, from its report's warnings (e.g. `review_round_failed` for a group of
 * files). It still reports such a run as complete, with the findings it did get. Warnings about repairs it
 * made along the way lose nothing and don't count. Null when nothing was lost.
 */
export function reviewGaps(report: unknown): ReviewGaps | null {
    const warnings = Array.isArray(obj(report).warnings) ? (obj(report).warnings as unknown[]) : [];
    const lost = warnings.map(obj).filter((w) => /fail|budget|skip|timeout|cancel|incomplete/i.test(String(w.type ?? "")));
    if (!lost.length) return null;
    const files = [
        ...new Set(
            lost.flatMap((w) =>
                String(w.file ?? "")
                    .split(",")
                    .map((f) => f.trim())
                    .filter(Boolean),
            ),
        ),
    ].slice(0, 200);
    const reasons = [...new Set(lost.map((w) => String(w.message ?? "").slice(0, 300)).filter(Boolean))].slice(0, 10);
    const n = lost.length;
    const shown = files.slice(0, 3).join(", ");
    const more = files.length > 3 ? ` and ${files.length - 3} more file${files.length - 3 === 1 ? "" : "s"}` : "";
    const note =
        `Part of the review didn't finish: ${n} file group${n === 1 ? "" : "s"}${files.length ? ` (${shown}${more})` : ""}` +
        `${reasons.length ? `, ${reasons.slice(0, 2).join("; ")}${reasons.length > 2 ? "; …" : ""}` : ""}. The findings it did get are included.`;
    return { groups: n, files, reasons, note };
}

export interface ReportMetrics {
    ocrVersion: string | null;
    model: string | null;
    tokens: { input: number; output: number; cacheRead: number; total: number } | null;
    filesReviewed: number | null;
    groups: number | null;
    toolCalls: { total: number; failed: number; byTool: Record<string, number> } | null;
    llm: { requests?: number; retries?: number; failures?: number } | null;
    findings: { total: number; bySeverity: Record<Severity, number> };
}

export function bySeverity(comments: unknown): { total: number; bySeverity: Record<Severity, number> } {
    const list = Array.isArray(comments) ? comments.map(obj) : [];
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    for (const c of list) {
        const s = (SEVERITIES as readonly unknown[]).includes(c.severity) ? (c.severity as Severity) : "low";
        counts[s]++;
    }
    return { total: list.length, bySeverity: counts };
}

/** Tokens, timings and tool use from an OCR report (any field may be missing). */
export function reportMetrics(report: unknown): ReportMetrics {
    const r = obj(report);
    const s = obj(r.summary);
    const total = num(s.total_tokens);
    const input = num(s.input_tokens);
    const output = num(s.output_tokens);
    const cacheRead = num(s.cache_read_tokens);
    const tc = obj(r.tool_calls);
    const rr = obj(r.retry_report);
    const byTool = Object.fromEntries(
        Object.entries(obj(tc.by_tool)).filter(([k, v]) => /^[\w.-]{1,60}$/.test(k) && num(v) !== null) as [string, number][],
    );
    return {
        ocrVersion: text(obj(obj(r.manifest).execution).ocr_version, 30)?.replace(/^v/, "") ?? null,
        model: text(obj(r.llm).model, 150),
        tokens:
            total !== null || input !== null || output !== null
                ? { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, total: total ?? (input ?? 0) + (output ?? 0) }
                : null,
        filesReviewed: num(s.files_reviewed),
        groups: Array.isArray(r.groups) ? r.groups.length : null,
        toolCalls: num(tc.total) !== null ? { total: num(tc.total) ?? 0, failed: num(tc.failure) ?? 0, byTool } : null,
        llm:
            num(rr.total_requests) !== null
                ? {
                      requests: num(rr.total_requests) ?? 0,
                      retries: num(rr.retried_requests) ?? 0,
                      failures: num(rr.failed_requests) ?? 0,
                  }
                : null,
        findings: bySeverity(r.comments),
    };
}

/** Text from the model, made safe to show in a GitHub comment: one line, no mentions, links or HTML. */
export function plain(s: string, max = 140): string {
    const flat = s
        .replace(/[\r\n|]+/g, " ")
        .replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"))
        .replace(/@/g, "@\u200b")
        .replace(/[[\]]/g, (c) => `\\${c}`)
        // No autolinks: a finding's text shouldn't become a link someone clicks on GitHub.
        .replace(/:\/\//g, ":\u200b//")
        .trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const code = (s: string) =>
    `\`${s
        .replace(/`/g, "'")
        .replace(/[\r\n]/g, " ")
        .slice(0, 200)}\``;

export interface CommentInput {
    marker: string;
    total: number;
    bySeverity: Record<Severity, number>;
    /** The branch's most urgent issues (critical and high), in priority order. */
    urgent: readonly Pick<Issue, "id" | "severity" | "path" | "startLine" | "title">[];
    gaps: ReviewGaps | null;
    failOnCritical: boolean;
    commit: string;
    /** Links into Triagent: the branch's issues, and one issue. */
    issuesUrl: string;
    issueUrl(id: string): string;
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
                lines.push(`- **${x.severity}** ${code(where)} [${plain(x.title)}](${c.issueUrl(x.id)})`);
            }
            if (c.urgent.length > top.length) lines.push(`- …and ${c.urgent.length - top.length} more`);
            lines.push("");
        }
    }
    if (c.gaps)
        lines.push(`> [!WARNING]`, `> **Partial review.** ${plain(c.gaps.note, 600)} Review it again from Triagent, or push again.`, "");
    if (c.failOnCritical && c.bySeverity.critical)
        lines.push(
            `The **Triagent** check fails because of ${c.bySeverity.critical} critical finding${c.bySeverity.critical === 1 ? "" : "s"}. Fix ${c.bySeverity.critical === 1 ? "it" : "them"}, or mark ${c.bySeverity.critical === 1 ? "it" : "them"} won't fix in Triagent, and push again.`,
            "",
        );
    lines.push(
        `[Triage these in Triagent](${c.issuesUrl}). Reviewed commit ${code(c.commit.slice(0, 10))}. This comment is updated on every review.`,
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
