// Which guided setup is open, if any: your account's, a workspace's or a project's. Anything can open one
// (creating a workspace or project does); the setup host (setup-host.tsx) shows it once the page is on
// the workspace or project it's about.

import { useSyncExternalStore } from "react";

export type SetupTarget = { kind: "account" } | { kind: "workspace"; ws: string } | { kind: "project"; ws: string; project: string };

export type Opened = SetupTarget & { step?: string };

let current: Opened | null = null;
const listeners = new Set<() => void>();

function set(next: Opened | null) {
    current = next;
    for (const l of listeners) l();
}

/** Open a guided setup, at `step` if given (otherwise at the first thing still to do). */
export function openSetup(target: SetupTarget, step?: string): void {
    set({ ...target, ...(step ? { step } : {}) });
}

export function closeSetup(): void {
    set(null);
}

export function useOpenSetup(): Opened | null {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => current,
        () => null,
    );
}
