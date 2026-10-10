import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The document title, and a Markdown version of the page for agents (<link rel="alternate">). React
 * moves both into <head>.
 */
export function PageMeta({ title, markdown }: { title: string; markdown?: string }) {
    return (
        <>
            <title>{`${title} · Triagent`}</title>
            {markdown && <link rel="alternate" type="text/markdown" href={markdown} />}
        </>
    );
}

export function PageHeader({
    title,
    description,
    actions,
    className,
}: {
    title: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
            <div className="min-w-0 space-y-0.5">
                <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
                {description && <div className="max-w-measure text-sm text-muted-foreground">{description}</div>}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
}

export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
    // One column that may shrink below its content's width, so a wide table scrolls inside its frame
    // instead of widening the page on a phone. It starts at the left edge of the content area, like every
    // page (DESIGN.md): nothing is centred but a dialog and the sign-in form.
    return (
        <div
            className={cn(
                "grid w-full grid-cols-[minmax(0,1fr)] content-start gap-section p-4 md:p-6",
                wide ? "max-w-none" : "max-w-6xl",
                className,
            )}
        >
            {children}
        </div>
    );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
    return (
        <div className="grid justify-items-start gap-2 rounded-lg border border-dashed p-6">
            <h2 className="section-title">{title}</h2>
            {children && <div className="max-w-prose text-sm text-muted-foreground">{children}</div>}
            {action}
        </div>
    );
}
