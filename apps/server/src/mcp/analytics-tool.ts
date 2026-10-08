// The get_analytics MCP tool: the Analytics page's figures as a short text summary, with everything in
// structuredContent.

import { SEVERITIES } from "@triagent/shared";
import { z } from "zod";
import { ANALYTICS_DAYS } from "../domain/analytics.ts";
import type { Analytics } from "../services/analytics.ts";
import type { Tool } from "./tools.ts";

const n = (v: number) => v.toLocaleString("en-GB");
const usd = (v: number | null) => (v === null ? "not priced" : `US$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`);
const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
const dur = (s: number | null) => (s === null ? "not recorded" : s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)} min`);
const hrs = (h: number | null) => (h === null ? "not recorded" : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

export function analyticsText(a: Analytics): string {
    const r = a.reviews;
    const f = a.findings;
    const t = a.triage;
    const p = a.performance;
    const scope = `${a.scope.project ?? "all projects"}, ${a.scope.branch ? `branch ${a.scope.branch}` : "all branches"}`;
    const range = a.range.days ? `the last ${a.range.days} days` : "all time";
    const lines = [
        `# Analytics: ${scope}, ${range}`,
        "",
        "## Reviews",
        `- ${n(r.total)} reviews (${n(r.runs)} run on the server, ${n(r.uploads)} uploaded): ${n(r.byStatus.done)} done, ${n(r.byStatus.partial)} partial, ${n(r.byStatus.failed)} failed, ${n(r.byStatus.cancelled)} cancelled`,
        `- Run time: median ${dur(r.runSeconds.median)}, 90th percentile ${dur(r.runSeconds.p90)}; queue time: median ${dur(r.queueSeconds.median)}`,
        `- Tokens: ${n(r.tokens.total)} (${n(r.tokens.input)} input, ${n(r.tokens.output)} output, ${n(r.tokens.cacheRead)} cache reads)${r.tokens.estimated ? `, including an estimate of ${n(r.tokens.estimatedTotal)} for ${n(r.tokens.estimated)} review(s) that stopped without saying (counted at their token budget)` : ""}`,
        `- Cost: ${usd(r.cost.total)}; per review ${usd(r.cost.perReview)}, per pull request ${usd(r.cost.perPr)}, per finding ${usd(r.cost.perFinding)}`,
        ...(a.unpriced.length ? [`- No price for: ${a.unpriced.map((u) => `${u.model} (${n(u.tokens)} tokens)`).join(", ")}`] : []),
        "",
        "## Findings and backlog",
        `- Open now: ${n(f.open)} (${SEVERITIES.map((s) => `${f.openBySeverity[s]} ${s}`).join(", ")}); ${n(f.unassigned)} unassigned, ${n(f.needsDiscussion)} need discussion`,
        `- In range: ${n(f.added)} new, ${n(f.closed)} closed (${n(f.resolved)} resolved, ${n(f.wontFix)} won't fix, won't-fix rate ${pct(f.wontFixRate)}), ${n(f.removed)} no longer reported, ${n(f.reopenedByReview + f.reopenedByPeople)} reopened`,
        `- Rating corrections: ${n(f.corrections.severity)} severity, ${n(f.corrections.category)} category`,
        ...(f.hotspots.files.length
            ? [
                  `- Hotspots: ${f.hotspots.files
                      .slice(0, 5)
                      .map((h) => `${h.key} (${h.open} open)`)
                      .join(", ")}`,
              ]
            : []),
        "",
        "## Triage",
        `- ${n(t.closed)} closed (${t.closedPerWeek.toFixed(1)} a week); ${pct(t.agentShare)} by agents`,
        `- Time to resolve: median ${hrs(t.timeToResolve.medianHours)}, 90th percentile ${hrs(t.timeToResolve.p90Hours)}`,
        ...t.people
            .slice(0, 10)
            .map(
                (x) =>
                    `- ${x.actor}${x.agent ? " (agent)" : ""}: ${x.resolved} resolved, ${x.wontFix} won't fix, ${x.reopened} reopened, ${x.notes} notes, ${x.claims} claimed`,
            ),
        "",
        "## Model and OCR performance",
        `- Partial reviews: ${n(p.partial)} (${pct(p.partialRate)}); failed file groups: ${p.groups.recorded ? n(p.groups.failed) : "not recorded"}`,
        `- Model requests: ${p.llm.recorded ? `${n(p.llm.requests)}, ${n(p.llm.retries)} retried, ${n(p.llm.failures)} failed` : "not recorded"}`,
        `- Tokens a minute: ${p.tokensPerMinute.value === null ? "not recorded" : n(Math.round(p.tokensPerMinute.value))}; per file: ${p.tokensPerFile.value === null ? "not recorded" : n(Math.round(p.tokensPerFile.value))}`,
        `- Tool calls: ${p.tools.recorded ? `${n(p.tools.calls)}, ${pct(p.tools.failureRate)} failed` : "not recorded"}`,
    ];
    if (a.truncated.history || a.truncated.activity) lines.push("", "_Only the most recent rows were read, so older ones are left out._");
    return lines.join("\n");
}

export const analyticsTool: Tool = {
    name: "get_analytics",
    title: "Get analytics",
    description:
        "Reviews (outcomes, time, tokens, cost), findings and backlog, triage throughput (by people and agents) and model performance, over a range. Leave project out for every project in the workspace.",
    permission: "read",
    readOnly: true,
    input: z.object({
        project: z.string().max(40).optional().describe("Project id (see list_projects); leave out for all projects"),
        branch: z.string().max(200).optional().describe("One branch; leave out for all branches"),
        days: z
            .number()
            .int()
            .refine((d) => (ANALYTICS_DAYS as readonly number[]).includes(d), "Use 7, 30, 90, 365 or 0 (all time).")
            .optional()
            .describe("7, 30 (default), 90, 365, or 0 for all time"),
    }),
    async run(ctx, args) {
        const data = await ctx.services.analytics.compute(ctx.access.workspace, {
            project: typeof args.project === "string" ? args.project : undefined,
            branch: typeof args.branch === "string" ? args.branch : undefined,
            days: (args.days as Analytics["range"]["days"] | undefined) ?? 30,
        });
        return { text: analyticsText(data), data };
    },
};
