// A secret the server shows exactly once (a new API token, a webhook secret, a generated password).
// It's kept only in the state of the page that asked for it, never in the query cache, so live updates
// and refetches can't redraw or drop it; it's forgotten as soon as the person navigates away.

import { useRouterState } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { memo, useEffect, useId, useRef } from "react";
import { announce } from "@/components/announcer";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface OneTimeRevealProps {
    value: string;
    /** What it is, e.g. "New API token". */
    label: string;
    /** Where to put it, e.g. "Paste it into GitHub's webhook settings." */
    hint?: string;
    /** Called when the person is done or navigates away; must be a stable function. */
    onDismiss(): void;
}

export const OneTimeReveal = memo(function OneTimeReveal({ value, label, hint, onDismiss }: OneTimeRevealProps) {
    const id = useId();
    const box = useRef<HTMLDivElement>(null);
    const href = useRouterState({ select: (s) => s.location.href });
    const shownAt = useRef(href);

    useEffect(() => {
        if (href !== shownAt.current) onDismiss();
    }, [href, onDismiss]);

    useEffect(() => {
        box.current?.focus();
        announce(`${label} created. Copy it now: it won't be shown again.`);
    }, [label]);

    return (
        <div
            ref={box}
            tabIndex={-1}
            className="grid gap-2 rounded-lg border border-primary/40 bg-primary/5 p-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            data-testid="one-time-reveal"
        >
            <p className="flex items-center gap-2 font-medium">
                <KeyRound className="size-4" aria-hidden="true" />
                Copy it now: it won't be shown again.
            </p>
            {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
            <Label htmlFor={id}>{label}</Label>
            <div className="flex flex-wrap gap-2">
                <Input
                    id={id}
                    readOnly
                    value={value}
                    className="min-w-0 flex-1 font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                    spellCheck={false}
                    autoComplete="off"
                />
                <CopyButton value={value} />
            </div>
            <div>
                <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
                    I've saved it
                </Button>
            </div>
        </div>
    );
});
