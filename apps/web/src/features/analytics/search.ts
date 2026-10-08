// The Analytics page's scope in the URL: ?project=&branch=&days=. Kept apart from the page so the router
// can read it without loading the page.

import type { Days } from "@/lib/insights-types";

export const RANGES: { days: Days; label: string }[] = [
    { days: 7, label: "Last 7 days" },
    { days: 30, label: "Last 30 days" },
    { days: 90, label: "Last 90 days" },
    { days: 365, label: "Last 12 months" },
    { days: 0, label: "All time" },
];

export interface AnalyticsSearch {
    project?: string;
    branch?: string;
    days?: Days;
}

export function parseAnalyticsSearch(s: Record<string, unknown>): AnalyticsSearch {
    const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
    const days = Number(s.days);
    const out: AnalyticsSearch = {};
    const project = text(s.project, 40);
    const branch = text(s.branch, 200);
    if (project) out.project = project;
    if (project && branch) out.branch = branch;
    if (s.days !== undefined && RANGES.some((r) => r.days === days)) out.days = days as Days;
    return out;
}
