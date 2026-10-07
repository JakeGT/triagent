// Live updates. Every change recorded in the activity log is announced to the open pages and agents of
// the same workspace, as a small "something changed" notice; they fetch the details themselves, with
// their own permissions. Nothing crosses from one workspace to another.

import type { Permission } from "@triagent/shared";
import type { ActivityRow } from "../store/types.ts";

export interface LiveEvent {
    seq: number;
    at: string;
    workspace: string;
    project: string | null;
    branch: string | null;
    kind: string;
    id: string;
    actor: string;
    via: string;
    fields: string[];
    /** The browser tab that made the change, so it can ignore its own echo. */
    clientId?: string;
}

/** Kinds of change only people who manage the workspace hear about. */
const NEEDS: Record<string, Permission> = { settings: "configure", member: "members", token: "tokens", secret: "secrets" };

export interface Subscriber {
    workspaceId: string;
    userKey: string;
    permissions: ReadonlySet<Permission>;
    send(event: LiveEvent): void;
}

export const MAX_SUBSCRIBERS = 1000;
export const MAX_PER_USER = 12;

export class EventBus {
    private readonly subscribers = new Set<Subscriber>();
    private seq = 0;

    get size(): number {
        return this.subscribers.size;
    }

    /** Returns an unsubscribe function, or null when there are too many connections. */
    subscribe(s: Subscriber): (() => void) | null {
        const theirs = [...this.subscribers].filter((x) => x.userKey === s.userKey).length;
        if (this.subscribers.size >= MAX_SUBSCRIBERS || theirs >= MAX_PER_USER) return null;
        this.subscribers.add(s);
        return () => this.subscribers.delete(s);
    }

    publish(row: ActivityRow, project: string | null, clientId?: string): void {
        const event: LiveEvent = {
            seq: ++this.seq,
            at: row.at,
            workspace: row.workspaceId,
            project,
            branch: row.branch,
            kind: row.kind,
            id: row.itemId,
            actor: row.actor,
            via: row.via,
            fields: Object.keys(row.changes),
            ...(clientId ? { clientId } : {}),
        };
        const needs = NEEDS[row.kind];
        for (const s of this.subscribers) {
            if (s.workspaceId !== row.workspaceId) continue;
            if (needs && !s.permissions.has(needs)) continue;
            try {
                s.send(event);
            } catch {
                this.subscribers.delete(s);
            }
        }
    }
}
