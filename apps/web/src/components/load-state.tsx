// How pages show loading and failure: a quiet skeleton while loading, and a persistent alert (not a
// toast) when a page's data couldn't be loaded, with a way to try again.

import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

export function LoadError({
    error,
    onRetry,
    title = "Couldn't load this page",
    className,
}: {
    error: unknown;
    onRetry?: () => void;
    title?: string;
    className?: string;
}) {
    return (
        <Alert variant="destructive" className={cn("max-w-2xl", className)}>
            <AlertTriangle />
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>
                <p>{errorMessage(error)}</p>
                {onRetry && (
                    <Button variant="outline" size="sm" className="mt-1" onClick={() => onRetry()}>
                        <RotateCw /> Try again
                    </Button>
                )}
            </AlertDescription>
        </Alert>
    );
}

export function RouteError({ error, reset }: ErrorComponentProps) {
    const router = useRouter();
    return (
        <div className="p-6">
            <LoadError
                error={error}
                onRetry={() => {
                    reset();
                    void router.invalidate();
                }}
            />
        </div>
    );
}

export function LoadingRows({ rows = 6, className }: { rows?: number; className?: string }) {
    return (
        <div className={cn("space-y-2", className)} aria-busy="true">
            <span className="sr-only">Loading…</span>
            {Array.from({ length: rows }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
                <Skeleton key={i} className="h-7 w-full" />
            ))}
        </div>
    );
}
