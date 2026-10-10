// Sections and actions of a form, with one set of headings and spacing for every form and card in the
// app: a section's title and description, then its fields `gap-form` apart, then its actions.

import { type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

/**
 * A titled group. Boxed by default: a settings section, a form saved as one, a table. `plain` is for
 * figures, short lists and prose, which sit on the page under their heading with no box (DESIGN.md).
 */
export function FormSection({
    title,
    description,
    aside,
    level = 3,
    plain,
    className,
    children,
    ...props
}: {
    title: ReactNode;
    description?: ReactNode;
    /** Beside the title: a link to do it another way, a count. */
    aside?: ReactNode;
    /** h3 inside a page with its own h2 (Settings), h2 on an ordinary page. */
    level?: 2 | 3;
    /** No border or background: a heading and what's under it. */
    plain?: boolean;
    className?: string;
    children?: ReactNode;
} & Omit<React.ComponentProps<"section">, "title">) {
    const id = useId();
    const Heading = level === 2 ? "h2" : "h3";
    return (
        <section
            // Page-level sections are landmarks; a settings page's sections are just headed groups.
            aria-labelledby={level === 2 ? id : undefined}
            className={cn(
                "grid grid-cols-[minmax(0,1fr)] content-start",
                plain ? "gap-3" : "gap-form rounded-lg border bg-card p-inset",
                className,
            )}
            {...props}
        >
            <div className="grid gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <Heading id={id} className="section-title">
                        {title}
                    </Heading>
                    {aside}
                </div>
                {description && <div className="max-w-measure text-sm text-muted-foreground">{description}</div>}
            </div>
            {children}
        </section>
    );
}

/** A form's buttons, at its end: the main action first. */
export function FormActions({ children, className, ...props }: React.ComponentProps<"div">) {
    return (
        <div className={cn("flex flex-wrap items-center gap-2", className)} {...props}>
            {children}
        </div>
    );
}
