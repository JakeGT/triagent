import type { ReactNode } from "react";
import { PageMeta } from "@/components/page";
import { cn } from "@/lib/utils";

/** One settings page: its title (an h2; the layout has the h1), a description and its sections. */
export function SettingsPage({
    title,
    description,
    children,
    className,
}: {
    title: string;
    description?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("grid max-w-3xl content-start gap-6", className)}>
            <PageMeta title={`${title} · Settings`} />
            <div className="space-y-1">
                <h2 className="text-lg font-semibold">{title}</h2>
                {description && <div className="text-sm text-muted-foreground">{description}</div>}
            </div>
            {children}
        </div>
    );
}

/** A titled group of settings within a page. */
export function SettingsSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
    return (
        <section className="grid gap-4 rounded-lg border bg-card p-4">
            <div className="space-y-1">
                <h3 className="font-medium">{title}</h3>
                {description && <div className="text-sm text-muted-foreground">{description}</div>}
            </div>
            {children}
        </section>
    );
}

/** Shown on pages someone can see but not change. */
export function ReadOnlyNote({ children = "Only admins of this workspace can change these settings." }: { children?: ReactNode }) {
    return <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">{children}</p>;
}
