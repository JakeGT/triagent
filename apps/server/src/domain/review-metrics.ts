// What an Open Code Review JSON report says about its own run: the model, tokens, timing, tools and what
// it couldn't finish. Everything is optional, since older or hand-made reports leave most of it out, and
// nothing here trusts the report's shapes or sizes.

import { SEVERITIES, type Severity } from "@triagent/shared";
import type { RawReport } from "./report.ts";

export interface ReportMetrics {
    model: string | null;
    provider: string | null;
    ocrVersion: string | null;
    tokens: { input: number; output: number; cacheRead: number; total: number } | null;
    runSeconds: number | null;
    /** Parts of the review OCR couldn't finish (file groups whose rounds failed, timed out or ran out of budget). */
    partial: boolean;
    files: { reviewed?: number; groups?: number; failedGroups?: number } | null;
    llm: { requests?: number; retries?: number; failures?: number } | null;
    toolCalls: { total: number; failed: number; byTool: Record<string, number>; failedByTool: Record<string, number> } | null;
    findings: { total: number; bySeverity: Record<Severity, number> };
}

/** A count from the report, or null. Bounded, so an absurd figure can't break storing it. */
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 1e12) : null);
const label = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const obj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The longest a review can plausibly take, in seconds. */
const MAX_ELAPSED = 7 * 24 * 3600;

/** "1h37m45s", "31m3s" or "45s" in seconds. */
export function parseElapsed(text: unknown): number | null {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(String(text ?? "").trim());
    if (!m || !(m[1] || m[2] || m[3])) return null;
    const seconds = Math.round(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
    // No review runs for a week: anything longer is a broken report, and would skew every average it joins.
    return seconds <= MAX_ELAPSED ? seconds : null;
}

/** Warning types that mean part of the review was lost; repairs OCR made along the way don't count. */
const LOST = /fail|budget|skip|timeout|cancel|incomplete/i;

/** Tool names become object keys: keep them plain, and only a few dozen. */
function counts(v: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(obj(v) ?? {}).slice(0, 60)) {
        const c = count(n);
        if (/^[\w.-]{1,60}$/.test(k) && k !== "__proto__" && c !== null) out[k] = c;
    }
    return out;
}

export function reportMetrics(report: RawReport): ReportMetrics {
    const summary = obj(report.summary) ?? {};
    const llm = obj(report.llm) ?? {};
    const manifest = obj(report.manifest) ?? {};
    const execution = obj(manifest.execution) ?? {};

    const input = count(summary.input_tokens);
    const output = count(summary.output_tokens);
    const cacheRead = count(summary.cache_read_tokens);
    const total = count(summary.total_tokens) ?? (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
    const tokens =
        total === null
            ? null
            : { input: input ?? Math.max(0, total - (output ?? 0)), output: output ?? 0, cacheRead: cacheRead ?? 0, total };

    const elapsedMs = count(manifest.elapsed_ms);
    const fromManifest = elapsedMs !== null ? Math.round(elapsedMs / 1000) : null;
    const runSeconds = fromManifest !== null ? (fromManifest <= MAX_ELAPSED ? fromManifest : null) : parseElapsed(summary.elapsed);

    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    const lost = warnings.filter((w) => obj(w) && LOST.test(String((w as Record<string, unknown>).type ?? ""))).length;
    const groups = Array.isArray(report.groups) ? report.groups.length : null;
    const reviewed = count(summary.files_reviewed);
    const files =
        reviewed !== null || groups !== null || lost
            ? {
                  ...(reviewed !== null ? { reviewed } : {}),
                  ...(groups !== null ? { groups } : {}),
                  failedGroups: lost,
              }
            : null;

    const retry = obj(report.retry_report);
    const llmStats = retry
        ? Object.fromEntries(
              Object.entries({
                  requests: count(retry.total_requests),
                  retries: count(retry.retried_requests),
                  failures: count(retry.failed_requests),
              }).filter(([, v]) => v !== null),
          )
        : null;

    const tc = obj(report.tool_calls);
    const toolCalls = tc
        ? {
              total: count(tc.total) ?? 0,
              failed: count(tc.failure) ?? 0,
              byTool: counts(tc.by_tool),
              failedByTool: counts(tc.failure_by_tool),
          }
        : null;

    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    // Only findings: anything else in the list (null, a number) isn't one.
    const findings = (Array.isArray(report.comments) ? report.comments : []).filter((c) => obj(c) !== null);
    for (const c of findings) {
        const s = (SEVERITIES as readonly unknown[]).includes(c.severity) ? (c.severity as Severity) : "low";
        bySeverity[s]++;
    }

    return {
        model: label(llm.model, 150),
        provider: label(llm.provider, 40),
        ocrVersion: label(execution.ocr_version, 30)?.replace(/^v(?=\d)/, "") ?? null,
        tokens,
        runSeconds,
        partial: lost > 0 || report.status === "partial",
        files,
        llm: llmStats && Object.keys(llmStats).length ? llmStats : null,
        toolCalls,
        findings: { total: findings.length, bySeverity },
    };
}
