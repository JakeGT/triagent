// A labelled form field with its hint and inline error, wired together with unique ids so assistive
// technology reads the label, the hint and the error with the input.

import { type ReactNode, useId } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface FieldControlProps {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: true;
}

export function Field({
    label,
    hint,
    error,
    className,
    children,
}: {
    label: ReactNode;
    hint?: ReactNode;
    error?: string | null;
    className?: string;
    children: (props: FieldControlProps) => ReactNode;
}) {
    const id = useId();
    const hintId = `${id}-hint`;
    const errorId = `${id}-error`;
    const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
    return (
        <div className={cn("grid gap-1.5", className)}>
            <Label htmlFor={id}>{label}</Label>
            {children({ id, "aria-describedby": describedBy, ...(error ? { "aria-invalid": true as const } : {}) })}
            {hint && (
                <p id={hintId} className="text-xs text-muted-foreground">
                    {hint}
                </p>
            )}
            <FieldError id={errorId} message={error} />
        </div>
    );
}

/** An inline error. Rendered as an alert so it's read out when it appears. */
export function FieldError({ id, message, className }: { id?: string; message?: string | null; className?: string }) {
    if (!message) return null;
    return (
        <p id={id} role="alert" className={cn("text-sm text-destructive", className)}>
            {message}
        </p>
    );
}

/** A native select, styled like the inputs. Changing it never navigates. */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
    return (
        <select
            className={cn(
                "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none",
                "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
                "aria-invalid:border-destructive dark:bg-input/30",
                className,
            )}
            {...props}
        />
    );
}
