import type { Category, Severity, Status } from "@triagent/shared";
import { CATEGORY_LABEL, SEVERITY_LABEL, STATUS_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Severity as coloured text with a shape (triangle, diamond, square, circle), never colour alone. */
export function SeverityMark({ severity, was, className }: { severity: Severity; was?: Severity | null; className?: string }) {
    return (
        <span className={cn("sev", `sev-${severity}`, className)}>
            {SEVERITY_LABEL[severity]}
            {was && <span className="font-normal text-muted-foreground">, was {SEVERITY_LABEL[was].toLowerCase()}</span>}
        </span>
    );
}

export function StatusMark({ status, className }: { status: Status; className?: string }) {
    return <span className={cn("status", `status-${status}`, className)}>{STATUS_LABEL[status]}</span>;
}

export function CategoryMark({ category, was, className }: { category: Category; was?: Category | null; className?: string }) {
    return (
        <span className={cn("text-muted-foreground", className)}>
            {CATEGORY_LABEL[category]}
            {was && <span>, was {CATEGORY_LABEL[was].toLowerCase()}</span>}
        </span>
    );
}

const SEV_BG: Record<Severity, string> = {
    critical: "bg-sev-critical",
    high: "bg-sev-high",
    medium: "bg-sev-medium",
    low: "bg-sev-low",
};

/** A thin stacked bar of severity counts, with the numbers for screen readers. */
export function SeverityBar({ counts, className }: { counts: Record<Severity, number>; className?: string }) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const label = (["critical", "high", "medium", "low"] as const)
        .filter((s) => counts[s])
        .map((s) => `${counts[s]} ${s}`)
        .join(", ");
    return (
        <span className={cn("flex h-2 w-24 overflow-hidden rounded-full bg-muted", className)} role="img" aria-label={label || "none"}>
            {total > 0 &&
                (["critical", "high", "medium", "low"] as const).map((s) =>
                    counts[s] ? (
                        <span key={s} className={cn("h-full", SEV_BG[s])} style={{ width: `${(counts[s] / total) * 100}%` }} />
                    ) : null,
                )}
        </span>
    );
}
