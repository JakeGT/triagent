// The record of finished reviews (runs on the server, and uploaded reports), for analytics and for
// counting model tokens against allowances.

import { randomId } from "../security.ts";
import type { Repos, ReviewRecord } from "../store/types.ts";
import type { Core } from "./core.ts";

/** The first moment of `now`'s calendar month (UTC), as ISO time: allowances count from here. */
export function monthStart(now: Date): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export class History {
    private readonly core: Core;

    constructor(core: Core) {
        this.core = core;
    }

    /** Record a finished review, as part of the caller's transaction. */
    async record(tx: Repos, record: Omit<ReviewRecord, "id">): Promise<ReviewRecord> {
        const full: ReviewRecord = { ...record, id: randomId() };
        await tx.reviewHistory.add(full);
        return full;
    }

    list(filter: { workspaceId: string; projectId?: string; branch?: string; since?: string }, limit = 1000): Promise<ReviewRecord[]> {
        return this.core.store.reviewHistory.list(filter, limit);
    }

    /** Tokens a workspace has used since the start of this calendar month (UTC). */
    tokensThisMonth(workspaceId: string, keySource?: ReviewRecord["keySource"], now = new Date()): Promise<number> {
        return this.core.store.reviewHistory.tokensSince(workspaceId, monthStart(now), keySource);
    }
}
