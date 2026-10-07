import type { Category, Severity, Status } from "@triagent/shared";

const dateTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
const relative = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });

export function formatDateTime(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : dateTime.format(d);
}

export function formatDate(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : dateOnly.format(d);
}

/** "3 minutes ago", "yesterday". */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "";
    const seconds = Math.round((t - now) / 1000);
    const steps: [Intl.RelativeTimeFormatUnit, number][] = [
        ["second", 60],
        ["minute", 60],
        ["hour", 24],
        ["day", 30],
        ["month", 12],
        ["year", Number.POSITIVE_INFINITY],
    ];
    let value = seconds;
    for (const [unit, size] of steps) {
        if (Math.abs(value) < size) return unit === "second" && Math.abs(value) < 30 ? "just now" : relative.format(value, unit);
        value = Math.round(value / size);
    }
    return "";
}

export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export const STATUS_LABEL: Record<Status, string> = {
    open: "Open",
    in_progress: "In progress",
    resolved: "Resolved",
    wont_fix: "Won't fix",
};

export const CATEGORY_LABEL: Record<Category, string> = {
    security: "Security",
    bug: "Bug",
    performance: "Performance",
    test: "Test",
    maintainability: "Maintainability",
    documentation: "Documentation",
    style: "Style",
    other: "Other",
};

export function lines(start: number | null, end: number | null): string {
    if (!start) return "";
    return end && end !== start ? `${start}–${end}` : String(start);
}

export function plural(n: number, one: string, many = `${one}s`): string {
    return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}
