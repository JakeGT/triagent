import { RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { announce } from "@/components/announcer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shown instead of replacing what someone is editing when the server's copy changes under them.
 * Announced once through the page's live region when it appears.
 */
export function ChangedElsewhere({
    show,
    onReload,
    what = "This",
    reloadLabel = "Reload",
    keepsInput = false,
    className,
}: {
    show: boolean;
    onReload(): void;
    what?: string;
    reloadLabel?: string;
    /** Reloading keeps what's being typed (otherwise unsaved changes are lost). */
    keepsInput?: boolean;
    className?: string;
}) {
    const message = `${what} changed elsewhere while you were editing.`;
    useEffect(() => {
        if (show) announce(message);
    }, [show, message]);
    if (!show) return null;
    return (
        <div
            className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm",
                className,
            )}
            data-testid="changed-elsewhere"
        >
            <p className="flex-1">
                <strong className="font-semibold">{message}</strong>{" "}
                {keepsInput ? "Reload to see the latest version; what you've typed stays." : "Reloading discards your unsaved changes."}
            </p>
            <Button size="sm" variant="outline" onClick={onReload}>
                <RefreshCw /> {reloadLabel}
            </Button>
        </div>
    );
}
