import { cn } from "@/lib/utils";

/** Four bars, longest to shortest: critical, high, medium, low. */
export function Logo({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 32 32" className={cn("shrink-0", className)} aria-hidden="true" focusable="false">
            <rect width="32" height="32" rx="7" fill="#20262b" />
            <rect x="7" y="7" width="18" height="3.5" rx="1.75" fill="#ef5b56" />
            <rect x="7" y="12.5" width="14" height="3.5" rx="1.75" fill="#f08a4f" />
            <rect x="7" y="18" width="10" height="3.5" rx="1.75" fill="#ddb03d" />
            <rect x="7" y="23.5" width="6" height="3.5" rx="1.75" fill="#8fb0c2" />
        </svg>
    );
}
