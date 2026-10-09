import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";

/** A centred card for signing in and the forced password change. */
export function AuthLayout({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
    return (
        <main id="content" className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
            <div className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-6 shadow-sm">
                {/* To the page that says what Triagent is. */}
                <Link to="/welcome" className="flex w-fit items-center gap-2 rounded-sm text-lg font-semibold hover:underline">
                    <Logo className="size-7" />
                    Triagent
                </Link>
                <div className="space-y-1">
                    <h1 className="text-xl font-semibold">{title}</h1>
                    {description && <div className="text-sm text-muted-foreground">{description}</div>}
                </div>
                {children}
            </div>
        </main>
    );
}
