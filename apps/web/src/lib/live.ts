// Live updates: one EventSource per workspace. Each `change` notice invalidates the cached queries it
// touches, and TanStack Query refetches whatever is on screen; nothing polls. Our own changes come back
// with this tab's client id and are skipped (the mutation already updated the cache). When the stream
// says goodbye or drops, the session is checked again before reconnecting.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { announce } from "@/components/announcer";
import { CLIENT_ID, isApiError, paths } from "./api";
import { keys, meQuery } from "./queries";
import type { LiveEvent } from "./types";

export type LiveStatus = "connecting" | "live" | "reconnecting" | "paused";

/** Mark stale (and refetch, if on screen) everything a change could affect. */
export function invalidateFor(queryClient: QueryClient, ws: string, event: Pick<LiveEvent, "kind" | "project" | "fields">): void {
    // A review's progress arrives up to once a second: refresh what shows runs, and nothing else until it ends.
    if (event.kind === "run") {
        void queryClient.invalidateQueries({ queryKey: keys.runs(ws) });
        if (event.project && !event.fields.includes("progress"))
            void queryClient.invalidateQueries({ queryKey: keys.pullRequests(ws, event.project) });
        if (event.project && event.fields.includes("finished")) {
            void queryClient.invalidateQueries({
                queryKey: keys.project(ws, event.project),
                predicate: (q) => q.queryKey[4] !== "settings",
            });
            void queryClient.invalidateQueries({ queryKey: keys.projects(ws) });
        }
        return;
    }
    if (!event.project) {
        void queryClient.invalidateQueries({ queryKey: keys.ws(ws) });
        return;
    }
    // A project's settings only change through Settings, which reloads them itself.
    void queryClient.invalidateQueries({
        queryKey: keys.project(ws, event.project),
        predicate: (q) => q.queryKey[4] !== "settings",
    });
    if (event.kind === "project" || event.kind === "report" || event.kind === "branch")
        void queryClient.invalidateQueries({ queryKey: keys.projects(ws) });
}

export function useLiveUpdates(
    ws: string,
    onSessionEnded: () => void,
    onLostAccess: () => void,
    /** Every live notice, after the cache has been told (finished-review notifications listen here). */
    onEvent?: (event: LiveEvent) => void,
): LiveStatus {
    const queryClient = useQueryClient();
    const [status, setStatus] = useState<LiveStatus>("connecting");

    useEffect(() => {
        let source: EventSource | null = null;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let attempts = 0;
        let stopped = false;
        let hadConnection = false;

        const connect = () => {
            if (stopped) return;
            source = new EventSource(`${paths.workspace(ws)}/events`);
            source.addEventListener("hello", () => {
                // Anything could have changed while we weren't listening.
                if (hadConnection) void queryClient.invalidateQueries({ queryKey: keys.ws(ws) });
                hadConnection = true;
                attempts = 0;
                setStatus("live");
            });
            source.addEventListener("change", (e) => {
                let event: LiveEvent;
                try {
                    event = JSON.parse((e as MessageEvent<string>).data) as LiveEvent;
                } catch {
                    return;
                }
                if (event.clientId === CLIENT_ID) return;
                invalidateFor(queryClient, ws, event);
                onEvent?.(event);
            });
            source.addEventListener("bye", () => drop());
            source.addEventListener("error", (e) => {
                // An `error` event with data is the server refusing the stream (too many tabs).
                if ((e as MessageEvent).data) {
                    source?.close();
                    setStatus("paused");
                    return;
                }
                if (source?.readyState === EventSource.CLOSED) drop();
                else setStatus("reconnecting");
            });
        };

        /** The stream ended: check the session is still good, then reconnect with a growing delay. */
        const drop = async () => {
            source?.close();
            source = null;
            if (stopped) return;
            setStatus("reconnecting");
            try {
                const me = await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
                if (!me.workspaces.some((w) => w.slug === ws)) {
                    announce("You no longer have access to this workspace.");
                    onLostAccess();
                    return;
                }
            } catch (err) {
                if (isApiError(err, 401)) {
                    onSessionEnded();
                    return;
                }
                // The server is unreachable: try again later.
            }
            attempts++;
            retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)));
        };

        connect();
        return () => {
            stopped = true;
            clearTimeout(retry);
            source?.close();
        };
    }, [ws, queryClient, onSessionEnded, onLostAccess, onEvent]);

    return status;
}
