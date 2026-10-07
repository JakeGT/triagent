// An in-memory Store, for tests and local development. Nothing survives a restart.
//
// Transactions run one at a time. Each write inside one records how to undo it, and if the transaction
// throws, the undo steps run in reverse, so a failed request leaves nothing half-done. A write made
// outside a transaction runs as a transaction of its own, so it can't slip between another's steps.
// Hooks registered with afterCommit run once the outermost transaction has succeeded.
// Stored values are frozen copies, so a caller can't change what others read.

import { AsyncLocalStorage } from "node:async_hooks";
import type {
    ActivityRow,
    ApiToken,
    ArchivedReport,
    AuditRow,
    Membership,
    Page,
    Project,
    Repos,
    SecretRecord,
    Session,
    SettingRecord,
    Store,
    StoredReport,
    TriageRecord,
    UploadLink,
    User,
    Workspace,
} from "./types.ts";

type Undo = () => void;

interface Tx {
    undo: Undo[];
    after: (() => void)[];
}

function freeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const v of Object.values(value)) freeze(v);
    }
    return value;
}

const own = <T>(value: T): T => freeze(structuredClone(value));
const key = (...parts: string[]) => parts.join("\0");

/** A keyed table whose changes can be undone. */
class Table<V> {
    readonly rows = new Map<string, V>();
    private readonly journal: () => Undo[] | null;

    constructor(journal: () => Undo[] | null) {
        this.journal = journal;
    }

    get(k: string): V | null {
        return this.rows.get(k) ?? null;
    }

    values(): V[] {
        return [...this.rows.values()];
    }

    set(k: string, value: V): void {
        this.remember(k);
        this.rows.set(k, own(value));
    }

    delete(k: string): void {
        if (!this.rows.has(k)) return;
        this.remember(k);
        this.rows.delete(k);
    }

    private remember(k: string): void {
        const undo = this.journal();
        if (!undo) throw new Error("Store writes must run inside a transaction.");
        const had = this.rows.has(k);
        const before = this.rows.get(k);
        undo.push(() => (had ? this.rows.set(k, before as V) : this.rows.delete(k)));
    }
}

/** An append-only log whose appends can be undone. */
class Log<V extends { id: string }> {
    readonly rows: V[] = [];
    private readonly journal: () => Undo[] | null;

    constructor(journal: () => Undo[] | null) {
        this.journal = journal;
    }

    add(value: V): void {
        const undo = this.journal();
        if (!undo) throw new Error("Store writes must run inside a transaction.");
        this.rows.push(own(value));
        undo.push(() => {
            const i = this.rows.findLastIndex((r) => r.id === value.id);
            if (i !== -1) this.rows.splice(i, 1);
        });
    }

    /** Remove matching rows (for deletes that take a log's rows with them). */
    remove(match: (row: V) => boolean): void {
        const undo = this.journal();
        if (!undo) throw new Error("Store writes must run inside a transaction.");
        const before = [...this.rows];
        const kept = this.rows.filter((r) => !match(r));
        if (kept.length === before.length) return;
        this.rows.splice(0, this.rows.length, ...kept);
        undo.push(() => this.rows.splice(0, this.rows.length, ...before));
    }

    /** Newest first, starting after the row with id `before`. */
    list(match: (row: V) => boolean, page: Page): V[] {
        const out: V[] = [];
        let started = !page.before;
        for (let i = this.rows.length - 1; i >= 0 && out.length < page.limit; i--) {
            const row = this.rows[i] as V;
            if (!started) {
                started = row.id === page.before;
                continue;
            }
            if (match(row)) out.push(row);
        }
        return out;
    }
}

export class MemoryStore implements Store {
    private readonly context = new AsyncLocalStorage<Tx>();
    private queue: Promise<unknown> = Promise.resolve();
    private version = 0;

    private readonly t = {
        users: this.table<User>(),
        sessions: this.table<Session>(),
        workspaces: this.table<Workspace>(),
        memberships: this.table<Membership>(),
        tokens: this.table<ApiToken>(),
        projects: this.table<Project>(),
        reports: this.table<StoredReport>(),
        archive: this.table<ArchivedReport[]>(),
        triage: this.table<TriageRecord>(),
        uploadLinks: this.table<UploadLink>(),
        secrets: this.table<SecretRecord>(),
        settings: this.table<SettingRecord>(),
        activity: new Log<ActivityRow>(() => this.context.getStore()?.undo ?? null),
        audit: new Log<AuditRow>(() => this.context.getStore()?.undo ?? null),
    };

    private table<V>(): Table<V> {
        return new Table<V>(() => this.context.getStore()?.undo ?? null);
    }

    async transaction<T>(fn: (tx: Repos) => Promise<T>): Promise<T> {
        // Already inside one: join it (its undo steps cover ours).
        if (this.context.getStore()) return fn(this);
        const tx: Tx = { undo: [], after: [] };
        const run = async () => {
            try {
                return await this.context.run(tx, () => fn(this));
            } catch (err) {
                for (const step of tx.undo.reverse()) step();
                throw err;
            }
        };
        const result = this.queue.then(run, run);
        this.queue = result.catch(() => {});
        const value = await result;
        for (const hook of tx.after) {
            try {
                hook();
            } catch (err) {
                console.error("A hook run after a saved change failed:", err);
            }
        }
        return value;
    }

    afterCommit(fn: () => void): void {
        const tx = this.context.getStore();
        if (tx) tx.after.push(fn);
        else fn();
    }

    /** Run one write as its own transaction, unless it's already part of one. */
    private write(fn: () => void): Promise<void> {
        return this.transaction(async () => fn());
    }

    async ping(): Promise<void> {}

    async close(): Promise<void> {}

    // ---- repositories ------------------------------------------------------------------

    users: Repos["users"] = {
        get: async (id) => this.t.users.get(id),
        byUsername: async (username) => this.t.users.values().find((u) => u.username?.toLowerCase() === username.toLowerCase()) ?? null,
        list: async () => this.t.users.values(),
        count: async () => this.t.users.rows.size,
        put: (user) => this.write(() => this.t.users.set(user.id, user)),
        delete: (id) => this.write(() => this.t.users.delete(id)),
    };

    sessions: Repos["sessions"] = {
        get: async (idHash) => this.t.sessions.get(idHash),
        listForUser: async (userId) => this.t.sessions.values().filter((s) => s.userId === userId),
        put: (session) => this.write(() => this.t.sessions.set(session.idHash, session)),
        delete: (idHash) => this.write(() => this.t.sessions.delete(idHash)),
        sweep: async (idleBefore, createdBefore) => {
            const stale = this.t.sessions.values().filter((s) => s.lastSeenAt < idleBefore || s.createdAt < createdBefore);
            if (stale.length)
                await this.write(() => {
                    for (const s of stale) this.t.sessions.delete(s.idHash);
                });
            return stale.length;
        },
    };

    workspaces: Repos["workspaces"] = {
        get: async (id) => this.t.workspaces.get(id),
        bySlug: async (slug) => this.t.workspaces.values().find((w) => w.slug === slug) ?? null,
        list: async () => this.t.workspaces.values(),
        put: (workspace) => this.write(() => this.t.workspaces.set(workspace.id, workspace)),
        delete: (id) =>
            this.transaction(async () => {
                for (const p of this.t.projects.values()) if (p.workspaceId === id) await this.projects.delete(p.id);
                for (const m of this.t.memberships.values()) if (m.workspaceId === id) this.t.memberships.delete(key(id, m.userId));
                for (const t of this.t.tokens.values()) if (t.workspaceId === id) this.t.tokens.delete(t.id);
                for (const s of this.t.settings.values())
                    if (s.workspaceId === id) this.t.settings.delete(key(id, s.projectId ?? "", s.key));
                for (const s of this.t.secrets.values())
                    if (s.workspaceId === id) this.t.secrets.delete(key(id, s.projectId ?? "", s.name));
                this.t.activity.remove((r) => r.workspaceId === id);
                this.t.workspaces.delete(id);
            }),
    };

    memberships: Repos["memberships"] = {
        get: async (workspaceId, userId) => this.t.memberships.get(key(workspaceId, userId)),
        forUser: async (userId) => this.t.memberships.values().filter((m) => m.userId === userId),
        forWorkspace: async (workspaceId) => this.t.memberships.values().filter((m) => m.workspaceId === workspaceId),
        put: (m) => this.write(() => this.t.memberships.set(key(m.workspaceId, m.userId), m)),
        delete: (workspaceId, userId) => this.write(() => this.t.memberships.delete(key(workspaceId, userId))),
    };

    tokens: Repos["tokens"] = {
        get: async (id) => this.t.tokens.get(id),
        byHash: async (hash) => this.t.tokens.values().find((t) => t.hash === hash) ?? null,
        forWorkspace: async (workspaceId) => this.t.tokens.values().filter((t) => t.workspaceId === workspaceId),
        put: (token) => this.write(() => this.t.tokens.set(token.id, token)),
        delete: (id) => this.write(() => this.t.tokens.delete(id)),
    };

    projects: Repos["projects"] = {
        get: async (id) => this.t.projects.get(id),
        bySlug: async (workspaceId, slug) => this.t.projects.values().find((p) => p.workspaceId === workspaceId && p.slug === slug) ?? null,
        byWebhookId: async (webhookId) => this.t.projects.values().find((p) => p.webhookId === webhookId) ?? null,
        forWorkspace: async (workspaceId) => this.t.projects.values().filter((p) => p.workspaceId === workspaceId),
        put: (project) => this.write(() => this.t.projects.set(project.id, project)),
        delete: (id) =>
            this.write(() => {
                this.t.projects.delete(id);
                const prefix = `${id}\0`;
                for (const table of [this.t.reports, this.t.archive, this.t.triage] as Table<unknown>[]) {
                    for (const k of [...table.rows.keys()]) if (k.startsWith(prefix)) table.delete(k);
                }
                for (const s of this.t.secrets.values())
                    if (s.projectId === id) this.t.secrets.delete(key(s.workspaceId ?? "", id, s.name));
                for (const s of this.t.settings.values()) if (s.projectId === id) this.t.settings.delete(key(s.workspaceId, id, s.key));
                for (const l of this.t.uploadLinks.values()) if (l.projectId === id) this.t.uploadLinks.delete(l.hash);
            }),
    };

    reports: Repos["reports"] = {
        get: async (projectId, branch) => this.t.reports.get(key(projectId, branch)),
        branches: async (projectId) => this.t.reports.values().filter((r) => r.projectId === projectId),
        put: async (report) => {
            const stored: StoredReport = { ...report, version: ++this.version };
            await this.write(() => this.t.reports.set(key(report.projectId, report.branch), stored));
            return this.t.reports.get(key(report.projectId, report.branch)) as StoredReport;
        },
        delete: (projectId, branch) => this.write(() => this.t.reports.delete(key(projectId, branch))),
        archive: (entry, keep) =>
            this.write(() => {
                const k = key(entry.projectId, entry.branch);
                this.t.archive.set(k, [...(this.t.archive.get(k) ?? []), entry].slice(-keep));
            }),
        archived: async (projectId, branch) => [...(this.t.archive.get(key(projectId, branch)) ?? [])].reverse(),
        renameArchive: (projectId, from, to) =>
            this.write(() => {
                const moving = this.t.archive.get(key(projectId, from));
                if (!moving) return;
                const existing = this.t.archive.get(key(projectId, to)) ?? [];
                const merged = [...existing, ...moving.map((a) => ({ ...a, branch: to }))].sort((a, b) =>
                    a.archivedAt.localeCompare(b.archivedAt),
                );
                this.t.archive.set(key(projectId, to), merged);
                this.t.archive.delete(key(projectId, from));
            }),
    };

    triage: Repos["triage"] = {
        get: async (projectId, branch, kind, itemId) => this.t.triage.get(key(projectId, branch, kind, itemId)),
        forBranch: async (projectId, branch) => {
            const prefix = key(projectId, branch, "");
            const out: TriageRecord[] = [];
            for (const [k, v] of this.t.triage.rows) if (k.startsWith(prefix)) out.push(v);
            return out;
        },
        put: (r) => this.write(() => this.t.triage.set(key(r.projectId, r.branch, r.kind, r.itemId), r)),
        deleteBranch: (projectId, branch) =>
            this.write(() => {
                const prefix = key(projectId, branch, "");
                for (const k of [...this.t.triage.rows.keys()]) if (k.startsWith(prefix)) this.t.triage.delete(k);
            }),
        renameBranch: (projectId, from, to) =>
            this.write(() => {
                const prefix = key(projectId, from, "");
                for (const [k, r] of [...this.t.triage.rows]) {
                    if (!k.startsWith(prefix)) continue;
                    this.t.triage.delete(k);
                    this.t.triage.set(key(projectId, to, r.kind, r.itemId), { ...r, branch: to });
                }
            }),
    };

    activity: Repos["activity"] = {
        add: (row) => this.write(() => this.t.activity.add(row)),
        list: async (f, page) =>
            this.t.activity.list(
                (r) =>
                    r.workspaceId === f.workspaceId &&
                    (!f.projectId || r.projectId === f.projectId) &&
                    (!f.branch || r.branch === f.branch),
                page,
            ),
    };

    audit: Repos["audit"] = {
        add: (row) => this.write(() => this.t.audit.add(row)),
        list: async (f, page) => this.t.audit.list((r) => r.workspaceId === f.workspaceId, page),
    };

    uploadLinks: Repos["uploadLinks"] = {
        put: (link) => this.write(() => this.t.uploadLinks.set(link.hash, link)),
        get: async (hash) => this.t.uploadLinks.get(hash),
        take: async (hash) => {
            const taken: { link: UploadLink | null } = { link: null };
            await this.write(() => {
                taken.link = this.t.uploadLinks.get(hash);
                this.t.uploadLinks.delete(hash);
            });
            return taken.link;
        },
        count: async () => this.t.uploadLinks.rows.size,
        sweep: async (now) => {
            const expired = this.t.uploadLinks.values().filter((l) => l.expiresAt <= now);
            if (expired.length)
                await this.write(() => {
                    for (const l of expired) this.t.uploadLinks.delete(l.hash);
                });
        },
    };

    secrets: Repos["secrets"] = {
        get: async (workspaceId, projectId, name) => this.t.secrets.get(key(workspaceId ?? "", projectId ?? "", name)),
        list: async (workspaceId, projectId) =>
            this.t.secrets.values().filter((s) => s.workspaceId === workspaceId && s.projectId === projectId),
        put: (s) => this.write(() => this.t.secrets.set(key(s.workspaceId ?? "", s.projectId ?? "", s.name), s)),
        delete: (workspaceId, projectId, name) => this.write(() => this.t.secrets.delete(key(workspaceId ?? "", projectId ?? "", name))),
    };

    settings: Repos["settings"] = {
        get: async (workspaceId, projectId, k) => this.t.settings.get(key(workspaceId, projectId ?? "", k)),
        put: (s) => this.write(() => this.t.settings.set(key(s.workspaceId, s.projectId ?? "", s.key), s)),
    };
}
