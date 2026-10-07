// Light, dark or follow the system. Adapted from shadcn-admin's theme provider (MIT, see
// THIRD_PARTY_NOTICES.md): kept in localStorage rather than a cookie, and applied before the first paint
// by public/theme-init.js.

import { createContext, type ReactNode, use, useEffect, useSyncExternalStore } from "react";
import { PREF, prefs, usePref } from "@/lib/prefs";

export type Theme = "dark" | "light" | "system";
type ResolvedTheme = Exclude<Theme, "system">;

interface ThemeState {
    theme: Theme;
    resolvedTheme: ResolvedTheme;
    setTheme(theme: Theme): void;
}

const ThemeContext = createContext<ThemeState | null>(null);

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

function subscribeSystem(listener: () => void): () => void {
    const mq = darkQuery();
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const stored = usePref(PREF.theme);
    const theme: Theme = stored === "dark" || stored === "light" ? stored : "system";
    const systemDark = useSyncExternalStore(
        subscribeSystem,
        () => darkQuery().matches,
        () => false,
    );
    const resolvedTheme: ResolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

    useEffect(() => {
        const root = document.documentElement;
        root.classList.remove("light", "dark");
        root.classList.add(resolvedTheme);
    }, [resolvedTheme]);

    const setTheme = (next: Theme) => prefs.set(PREF.theme, next === "system" ? null : next);

    return <ThemeContext value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeContext>;
}

export function useTheme(): ThemeState {
    const ctx = use(ThemeContext);
    if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
    return ctx;
}
