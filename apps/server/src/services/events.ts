// Live updates. Every change recorded in the activity log is announced to the open pages and agents of
// the same workspace, as a small "something changed" notice; they fetch the details themselves, with
// their own permissions. Nothing crosses from one workspace to another.
//
// With more than one server process, a relay (Postgres LISTEN/NOTIFY) carries each notice, and each
// "close these streams", to the other processes, which deliver it to their own subscribers.

import { randomUUID } from "node:crypto";
import type { Permission } from "@triagent/shared";
import { log } from "@triagent/shared/log";
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
    /** "user:<id>" or "token:<id>". */
    userKey: string;
    permissions: ReadonlySet<Permission>;
    send(event: LiveEvent): void;
    /** End the stream (the person lost access, or the token was revoked). */
    close(): void;
}

/** Passes messages between server processes. */
export interface Relay {
    send(message: string): void;
    /** Start receiving every message sent, this process's own included. */
    listen(receive: (message: string) => void): Promise<void>;
}

type Notice = Omit<LiveEvent, "seq">;
type Message = { origin: string } & ({ type: "change"; event: Notice } | { type: "disconnect"; userKey: string; workspaceId?: string });

export const MAX_SUBSCRIBERS = 1000;
export const MAX_PER_USER = 12;

export class EventBus {
    private readonly subscribers = new Set<Subscriber>();
    private seq = 0;
    /** Tells this process's messages apart when the relay hands them back. */
    private readonly origin = randomUUID();
    private relay: Relay | null = null;

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

    /** Share notices with other server processes through `relay`. */
    async connect(relay: Relay): Promise<void> {
        await relay.listen((text) => this.receive(text));
        this.relay = relay;
    }

    private send(message: Message): void {
        try {
            this.relay?.send(JSON.stringify(message));
        } catch (err) {
            log.error("Couldn't pass a live update to other server processes", { err });
        }
    }

    private receive(text: string): void {
        let m: Message;
        try {
            m = JSON.parse(text);
        } catch {
            return;
        }
        if (!m || m.origin === this.origin) return;
        if (m.type === "change" && m.event && typeof m.event.workspace === "string") this.deliver(m.event);
        else if (m.type === "disconnect" && typeof m.userKey === "string") this.close(m.userKey, m.workspaceId);
    }

    /** Close the streams of `userKey` (in one workspace, or all); they reconnect with their current access, if any. */
    disconnect(userKey: string, workspaceId?: string): void {
        this.close(userKey, workspaceId);
        this.send({ origin: this.origin, type: "disconnect", userKey, ...(workspaceId ? { workspaceId } : {}) });
    }

    private close(userKey: string, workspaceId?: string): void {
        for (const s of [...this.subscribers]) {
            if (s.userKey !== userKey || (workspaceId && s.workspaceId !== workspaceId)) continue;
            this.subscribers.delete(s);
            try {
                s.close();
            } catch {
                // already closed
            }
        }
    }

    publish(row: ActivityRow, project: string | null, clientId?: string): void {
        const notice: Notice = {
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
        this.deliver(notice);
        this.send({ origin: this.origin, type: "change", event: notice });
    }

    /** Announce something that isn't an activity row (a review's progress, say) to the workspace. */
    announce(notice: Omit<Notice, "at" | "actor" | "via"> & Partial<Pick<Notice, "actor" | "via">>): void {
        const full: Notice = { at: new Date().toISOString(), actor: "Triagent", via: "system", ...notice };
        this.deliver(full);
        this.send({ origin: this.origin, type: "change", event: full });
    }

    private deliver(notice: Notice): void {
        const event: LiveEvent = { seq: ++this.seq, ...notice };
        const needs = NEEDS[event.kind];
        for (const s of this.subscribers) {
            if (s.workspaceId !== event.workspace) continue;
            if (needs && !s.permissions.has(needs)) continue;
            try {
                s.send(event);
            } catch {
                this.subscribers.delete(s);
            }
        }
    }
}
