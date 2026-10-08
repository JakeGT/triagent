// The first-run tutorial's state on the server, and a way for any page (Settings → Tutorial) to ask the
// tour to start again.

import { useSyncExternalStore } from "react";
import { api, paths } from "./api";
import type { Me, TutorialStatus, TutorialView } from "./types";

export const tutorialPath = `${paths.me}/tutorial`;

export const tutorialApi = {
    get: () => api.get<TutorialView>(tutorialPath),
    update: (patch: { status?: TutorialStatus; step?: number }) => api.patch<TutorialView>(tutorialPath, patch),
    /** Make the example project, or return the one there is. */
    createExample: () => api.post<TutorialView>(`${tutorialPath}/example`),
    removeExample: () => api.delete<TutorialView>(`${tutorialPath}/example`),
};

/** Is this the person's example project? */
export function isExample(me: Me, ws: string, project: string | undefined): boolean {
    const e = me.tutorial.example;
    return Boolean(e && project && e.workspace === ws && e.project === project);
}

// A request to start the tour from the beginning, made by a page and picked up by the tour.
let requested = 0;
const listeners = new Set<() => void>();

export function requestTour(): void {
    requested++;
    for (const l of listeners) l();
}

export function useTourRequests(): number {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => requested,
    );
}
