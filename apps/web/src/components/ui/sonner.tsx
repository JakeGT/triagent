import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/context/theme-provider";

/** Toasts, for confirmations only. Sonner's stylesheet is imported statically (src/main.tsx). */
export function Toaster(props: ToasterProps) {
    const { resolvedTheme } = useTheme();
    return (
        <Sonner
            theme={resolvedTheme}
            className="toaster group"
            style={
                {
                    "--normal-bg": "var(--popover)",
                    "--normal-text": "var(--popover-foreground)",
                    "--normal-border": "var(--border)",
                } as CSSProperties
            }
            {...props}
        />
    );
}
