// Numbers for analytics and prices, written for people: "1.2M tokens", "US$3.42", "2 min 30 s".

const whole = new Intl.NumberFormat("en-GB");

export const NOT_RECORDED = "Not recorded";

export function count(n: number): string {
    return whole.format(n);
}

/** 1,284 / 12.9K / 4.2M. */
export function compactCount(n: number): string {
    const a = Math.abs(n);
    if (a < 10_000) return whole.format(Math.round(n));
    const [div, unit] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : [1e3, "K"];
    return `${(n / div).toLocaleString("en-GB", { maximumFractionDigits: 1 })}${unit}`;
}

/** US dollars: cents for amounts of a dollar or more, more places for small ones. */
export function usd(v: number | null | undefined): string {
    if (v === null || v === undefined) return "No price";
    if (v === 0) return "US$0";
    const digits = Math.abs(v) >= 1 ? 2 : Math.abs(v) >= 0.01 ? 3 : 4;
    return `US$${v.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** A price per million tokens, as entered: up to four decimal places, no trailing zeros. */
export function perMillion(v: number | null | undefined): string {
    if (v === null || v === undefined) return "—";
    return `US$${v.toLocaleString("en-GB", { maximumFractionDigits: 4 })}`;
}

export function percent(v: number | null | undefined): string {
    if (v === null || v === undefined) return "—";
    return `${(v * 100).toLocaleString("en-GB", { maximumFractionDigits: v < 0.1 && v > 0 ? 1 : 0 })}%`;
}

/** 45 s, 2 min 30 s, 1 h 5 min. */
export function seconds(s: number | null | undefined): string {
    if (s === null || s === undefined) return NOT_RECORDED;
    const v = Math.round(s);
    if (v < 60) return `${v} s`;
    if (v < 3600) return `${Math.floor(v / 60)} min${v % 60 ? ` ${v % 60} s` : ""}`;
    const m = Math.round((v % 3600) / 60);
    return `${Math.floor(v / 3600)} h${m ? ` ${m} min` : ""}`;
}

/** 5.5 hours, 3.2 days. */
export function hours(h: number | null | undefined): string {
    if (h === null || h === undefined) return NOT_RECORDED;
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
    if (h < 48) return `${h.toLocaleString("en-GB", { maximumFractionDigits: 1 })} hours`;
    return `${(h / 24).toLocaleString("en-GB", { maximumFractionDigits: 1 })} days`;
}

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** A bucket's label: "8 Oct", or "w/c 6 Oct" for weeks. */
export function bucketLabel(date: string, unit: "day" | "week"): string {
    const d = new Date(`${date}T00:00:00Z`);
    const text = dayMonth.format(d);
    return unit === "week" ? `w/c ${text}` : text;
}

/** A bucket spelt out, for tables and screen readers: "8 October 2026", "week starting 6 October 2026". */
export function bucketLong(date: string, unit: "day" | "week"): string {
    const d = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
    });
    return unit === "week" ? `Week starting ${d}` : d;
}

export const KIND_LABEL: Record<string, string> = {
    pr: "Pull request",
    changes: "Branch changes",
    full: "Full scan",
    upload: "Upload",
};

export const STATUS_LABEL: Record<string, string> = {
    done: "Done",
    partial: "Partial",
    failed: "Failed",
    cancelled: "Cancelled",
};

export const VIA_LABEL: Record<string, string> = {
    web: "browser",
    token: "API token",
    mcp: "MCP",
    link: "upload link",
    github: "GitHub",
    system: "system",
    cli: "command line",
};

export const SOURCE_LABEL: Record<string, string> = {
    workspace: "This workspace",
    instance: "Instance",
    openrouter: "OpenRouter",
};

/** A date in UTC, e.g. "1 November 2026": allowances reset at midnight UTC. */
export function utcDay(iso: string): string {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
