import type { Via } from "@triagent/shared";
import type { Config } from "../config.ts";
import { now, randomId } from "../security.ts";
import type { ActivityRow, AuditRow, Repos, Store } from "../store/types.ts";
import type { EventBus } from "./events.ts";
import type { Secrets } from "./secrets.ts";

/** Who is making a change, as it's recorded in logs and shown to others. */
export interface Actor {
    /** A person's display name, or a token's name. */
    name: string;
    userId: string | null;
    /** Set when an API token is acting (its owner, if any, is `userId`). */
    tokenId?: string;
    via: Via;
    ip?: string | null;
    /** The browser tab that made the change (it ignores its own live updates). */
    clientId?: string;
}

/** Who wrote something, for "only its author may edit it" checks: a token, a person, or (for links) a name. */
export function authorKey(actor: Actor): string {
    if (actor.tokenId) return `token:${actor.tokenId}`;
    if (actor.userId) return `user:${actor.userId}`;
    return `name:${actor.name}`;
}

export interface Write {
    tx: Repos;
    /** Record a triage or content change; announced to the workspace once the change is saved. */
    activity(row: Omit<ActivityRow, "id" | "at" | "actor" | "actorUserId" | "via">, project?: string | null): Promise<void>;
    /** Run `fn` once the change is saved (e.g. closing a removed member's live connections). */
    afterCommit(fn: () => void): void;
    /** Record an administrative change (people, tokens, settings, secrets). */
    audit(row: Omit<AuditRow, "id" | "at" | "actor" | "actorUserId" | "via" | "ip">): Promise<void>;
}

export class Core {
    readonly store: Store;
    readonly config: Config;
    readonly events: EventBus;
    readonly secrets: Secrets;

    constructor(store: Store, config: Config, events: EventBus, secrets: Secrets) {
        this.store = store;
        this.config = config;
        this.events = events;
        this.secrets = secrets;
    }

    /** Run `fn` in one transaction; its live updates go out only once everything is saved. */
    async write<T>(actor: Actor, fn: (w: Write) => Promise<T>): Promise<T> {
        const announce: (() => void)[] = [];
        const out = await this.store.transaction((tx) =>
            fn({
                tx,
                activity: async (row, project = null) => {
                    const full: ActivityRow = {
                        ...row,
                        id: randomId(),
                        at: now(),
                        actor: actor.name,
                        actorUserId: actor.userId,
                        via: actor.via,
                    };
                    await tx.activity.add(full);
                    announce.push(() => this.events.publish(full, project, actor.clientId));
                },
                afterCommit: (f) => announce.push(f),
                audit: async (row) => {
                    await tx.audit.add({
                        ...row,
                        id: randomId(),
                        at: now(),
                        actor: actor.name,
                        actorUserId: actor.userId,
                        via: actor.via,
                        ip: actor.ip ?? null,
                    });
                },
            }),
        );
        for (const send of announce) send();
        return out;
    }
}
