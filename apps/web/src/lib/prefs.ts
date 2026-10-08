// Small per-browser preferences in localStorage, readable from React with useSyncExternalStore. Storage
// can be blocked (private modes, policies), so every access tolerates failure.

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function read(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string | null): void {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        // storage blocked: the preference lasts until the page reloads
        memory.set(key, value);
    }
    for (const l of listeners) l();
}

const memory = new Map<string, string | null>();

function get(key: string): string | null {
    return memory.has(key) ? (memory.get(key) ?? null) : read(key);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    const onStorage = () => listener();
    window.addEventListener("storage", onStorage);
    return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
    };
}

export const PREF = {
    theme: "triagent-theme",
    shortcuts: "triagent-shortcuts",
    lastWorkspace: "triagent-last-workspace",
    /** "on": also show finished reviews as desktop notifications in this browser. */
    desktopNotify: "triagent-desktop-notify",
    lastProject: (ws: string) => `triagent-last-project:${ws}`,
} as const;

export const prefs = { get, set: write };

export function usePref(key: string): string | null {
    return useSyncExternalStore(
        subscribe,
        () => get(key),
        () => null,
    );
}

/** Single-key shortcuts (j, k, x, 1–4, /) on the Issues page. On unless turned off (WCAG 2.1.4). */
export function useShortcutsEnabled(): boolean {
    return usePref(PREF.shortcuts) !== "off";
}
