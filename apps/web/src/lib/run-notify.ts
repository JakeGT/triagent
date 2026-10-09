// Telling people a review has finished: a toast, and a desktop notification if they've allowed them in
// this browser and the tab isn't in view. Which reviews follow their notification settings: the ones they
// started (or a token acting for them started), every one, or none; and optionally only problems.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { api, paths } from "./api";
import { PREF, prefs } from "./prefs";
import { meQuery } from "./queries";
import type { LiveEvent, Me, Run } from "./types";

/** Whether a finished review should be announced to this person. */
export function shouldNotify(run: Pick<Run, "status" | "startedAt" | "requestedBy" | "result">, me: Pick<Me, "user" | "notify">): boolean {
    // Never started (replaced by a newer commit, or cancelled while queued): nothing to tell.
    if (!run.startedAt) return false;
    const { scope, problemsOnly } = me.notify;
    if (scope === "none") return false;
    if (scope === "mine" && run.requestedBy.userId !== me.user.id) return false;
    if (!problemsOnly) return true;
    return run.status === "failed" || run.status === "partial" || (run.result?.bySeverity?.critical ?? 0) > 0;
}

export function describeRun(run: Pick<Run, "status" | "title" | "result" | "error">): { title: string; body: string } {
    const total = run.result?.total ?? 0;
    const critical = run.result?.bySeverity?.critical ?? 0;
    const findings = `${total.toLocaleString("en-GB")} finding${total === 1 ? "" : "s"}${critical ? `, ${critical} critical` : ""}`;
    switch (run.status) {
        case "done":
            return { title: "Review finished", body: `${run.title}: ${findings}.` };
        case "partial":
            return { title: "Review partly finished", body: `${run.title}: ${findings}. Part of it didn't finish.` };
        case "cancelled":
            return { title: "Review cancelled", body: run.title };
        default:
            return { title: "Review failed", body: `${run.title}: ${run.error ?? "see its log."}` };
    }
}

export const desktopNotificationsOn = () =>
    prefs.get(PREF.desktopNotify) === "on" && "Notification" in window && Notification.permission === "granted";

async function announce(queryClient: QueryClient, ws: string, id: string, open: (run: Run) => void): Promise<void> {
    const me = queryClient.getQueryData<Me>(meQuery.queryKey);
    if (!me) return;
    // `after` is the last log line we have: past any real one, so the run comes back without its log.
    const run = await api.get<Run>(`${paths.workspace(ws)}/runs/${encodeURIComponent(id)}`, { after: 1_000_000_000 });
    if (!shouldNotify(run, me)) return;
    const { title, body } = describeRun(run);
    const problem = run.status === "failed" || run.status === "partial" || (run.result?.bySeverity?.critical ?? 0) > 0;
    // A run whose project has gone has no page to open.
    const show = { description: body, ...(run.project ? { action: { label: "View", onClick: () => open(run) } } : {}) };
    if (run.status === "cancelled") toast.info(title, show);
    else if (problem) toast.warning(title, show);
    else toast.success(title, show);
    if (desktopNotificationsOn() && document.visibilityState === "hidden") {
        const n = new Notification(title, { body, tag: `triagent-run-${run.id}` });
        n.onclick = () => {
            window.focus();
            open(run);
        };
    }
}

/** A live-event listener for the workspace's app shell. */
export function useRunNotifications(ws: string): (event: LiveEvent) => void {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const seen = useRef(new Set<string>());
    return useCallback(
        (event: LiveEvent) => {
            // The server's own notice of a finished review (the activity row about it says the same again).
            if (event.kind !== "run" || event.via !== "system" || !event.fields.includes("finished") || seen.current.has(event.id)) return;
            seen.current.add(event.id);
            const open = (run: Run) =>
                run.project && void navigate({ to: "/w/$ws/p/$project/runs/$runId", params: { ws, project: run.project, runId: run.id } });
            void announce(queryClient, ws, event.id, open).catch(() => {});
        },
        [ws, queryClient, navigate],
    );
}
