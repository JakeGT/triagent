import type { ReactNode } from "react";
import { FormSection } from "@/components/form";
import { PageMeta } from "@/components/page";
import { cn } from "@/lib/utils";

/**
 * One settings page: its title (an h2; the layout has the h1), a description and its sections. Every
 * settings page is the same width; pages that are mostly a wide table can be `wide`.
 */
export function SettingsPage({
    title,
    description,
    children,
    wide,
    className,
}: {
    title: string;
    description?: ReactNode;
    children: ReactNode;
    wide?: boolean;
    className?: string;
}) {
    return (
        <div className={cn("grid grid-cols-[minmax(0,1fr)] content-start gap-section", wide ? "max-w-wide" : "max-w-narrow", className)}>
            <PageMeta title={`${title} · Settings`} />
            <div className="grid gap-1">
                <h2 className="text-lg leading-tight font-semibold">{title}</h2>
                {description && <div className="max-w-measure text-sm text-muted-foreground">{description}</div>}
            </div>
            {children}
        </div>
    );
}

/** A titled group of settings within a page. */
export function SettingsSection(props: { title: ReactNode; description?: ReactNode; aside?: ReactNode; children: ReactNode }) {
    return <FormSection {...props} />;
}

/** Shown on pages someone can see but not change. */
export function ReadOnlyNote({ children = "Only admins of this workspace can change these settings." }: { children?: ReactNode }) {
    return <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">{children}</p>;
}

/** What a page's settings add up to ("Ready: …"), shown first. */
export function StatusNote({ children, className, ...props }: { children: ReactNode } & React.ComponentProps<"p">) {
    return (
        <p className={cn("rounded-md border bg-muted/40 px-3 py-2 text-sm", className)} {...props}>
            {children}
        </p>
    );
}
