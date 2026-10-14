// An in-memory Store, for tests and local development. Nothing survives a restart.
//
// Transactions run one at a time. Each write inside one records how to undo it, and if the transaction
// throws, the undo steps run in reverse, so a failed request leaves nothing half-done. A write made
// outside a transaction runs as a transaction of its own, so it can't slip between another's steps.
// Hooks registered with afterCommit run once the outermost transaction has succeeded.
// Stored values are frozen copies, so a caller can't change what others read.

import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "@triagent/shared/log";
import type {
    ActivityRow,
    Analysis,
    ApiToken,
    ArchivedReport,
    AuditRow,
    FindingOrigin,
    FindingSource,
    GithubDelivery,
    GithubInstallation,
    Invite,
    Job,
    LogLine,
    Membership,
    ModelGrant,
    OriginScan,
    Page,
    Pattern,
    PatternFinding,
    Project,
    Repos,
    ReviewRecord,
    RunnerRecord,
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

function runHooks(hooks: (() => void)[]): void {
    for (const hook of hooks) {
        try {
            hook();
        } catch (err) {
            log.error("A hook run after a saved change failed", { err });
        }
    }
}
const key = (...parts: string[]) => parts.join("\0");
const linkKey = (f: Pick<PatternFinding, "projectId" | "branch" | "findingId">) => key(f.projectId, f.branch, f.findingId);
/** An installation's link to one workspace: one installation can be linked to several. */
const installationKey = (id: number, workspaceId: string) => `${id}:${workspaceId}`;
const sourceKey = (s: Pick<FindingSource, "projectId" | "branch" | "findingId" | "model" | "provider">) =>
    key(s.projectId, s.branch, s.findingId, s.model, s.provider);

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

    /** Store `value` as given, without copying it: only for values nothing will change (frozen, or shared copy-on-write). */
    setShared(k: string, value: V): void {
        this.remember(k);
        this.rows.set(k, value);
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
        jobs: this.table<Job>(),
        jobLogs: this.table<{ lines: readonly LogLine[]; bytes: number }>(),
        githubInstallations: this.table<GithubInstallation>(),
        githubState: this.table<{ state: unknown }>(),
        githubDeliveries: this.table<GithubDelivery[]>(),
        runners: this.table<RunnerRecord>(),
        findingSources: this.table<FindingSource>(),
        analyses: this.table<Analysis>(),
        patterns: this.table<Pattern>(),
        origins: this.table<FindingOrigin>(),
        originScans: this.table<OriginScan>(),
        patternFindings: this.table<PatternFinding>(),
        instanceSettings: this.table<{ value: unknown }>(),
        modelGrants: this.table<ModelGrant>(),
        invites: this.table<Invite>(),
        activity: new Log<ActivityRow>(() => this.context.getStore()?.undo ?? null),
        audit: new Log<AuditRow>(() => this.context.getStore()?.undo ?? null),
        reviewHistory: new Log<ReviewRecord>(() => this.context.getStore()?.undo ?? null),
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
        runHooks(tx.after);
        return value;
    }

    afterCommit(fn: () => void): void {
        const tx = this.context.getStore();
        if (tx) tx.after.push(fn);
        else runHooks([fn]);
    }

    /** Run one write as its own transaction, unless it's already part of one. */
    private write(fn: () => void): Promise<void> {
        return this.transaction(async () => fn());
    }

    async holdLock(_name: string): Promise<boolean> {
        return true;
    }

    async ping(): Promise<void> {}

    async close(): Promise<void> {}

    // ---- repositories ------------------------------------------------------------------

    users: Repos["users"] = {
        get: async (id) => this.t.users.get(id),
        byUsername: async (username) => this.t.users.values().find((u) => u.username?.toLowerCase() === username.toLowerCase()) ?? null,
        byIdentity: async (issuer, subject) => this.t.users.values().find((u) => u.issuer === issuer && u.subject === subject) ?? null,
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
        sweep: (idleBefore, createdBefore) =>
            this.transaction(async () => {
                const stale = this.t.sessions.values().filter((s) => s.lastSeenAt < idleBefore || s.createdAt < createdBefore);
                for (const s of stale) this.t.sessions.delete(s.idHash);
                return stale.length;
            }),
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
                for (const i of this.t.invites.values()) if (i.workspaceId === id) this.t.invites.delete(i.id);
                this.t.activity.remove((r) => r.workspaceId === id);
                this.t.reviewHistory.remove((r) => r.workspaceId === id);
                for (const s of this.t.findingSources.values()) if (s.workspaceId === id) this.t.findingSources.delete(sourceKey(s));
                for (const a of this.t.analyses.values()) if (a.workspaceId === id) this.t.analyses.delete(a.id);
                for (const p of this.t.patterns.values()) if (p.workspaceId === id) await this.patterns.delete(p.id);
                await this.origins.clear(id);
                for (const i of this.t.githubInstallations.values())
                    if (i.workspaceId === id) this.t.githubInstallations.delete(installationKey(i.id, i.workspaceId));
                this.t.modelGrants.delete(id);
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
                for (const j of this.t.jobs.values())
                    if (j.projectId === id) {
                        this.t.jobs.delete(j.id);
                        this.t.jobLogs.delete(j.id);
                    }
                for (const a of this.t.analyses.values()) if (a.projectId === id) this.t.analyses.delete(a.id);
                for (const p of this.t.patterns.values()) if (p.projectId === id) this.t.patterns.delete(p.id);
                for (const o of this.t.origins.values()) if (o.projectId === id) this.t.origins.delete(linkKey(o));
                for (const o of this.t.originScans.values()) if (o.projectId === id) this.t.originScans.delete(key(o.projectId, o.branch));
                for (const f of this.t.patternFindings.values()) if (f.projectId === id) this.t.patternFindings.delete(linkKey(f));
                this.t.githubState.delete(id);
                this.t.githubDeliveries.delete(id);
            }),
    };

    reports: Repos["reports"] = {
        get: async (projectId, branch) => this.t.reports.get(key(projectId, branch)),
        branches: async (projectId) => this.t.reports.values().filter((r) => r.projectId === projectId),
        put: async (report) => {
            const k = key(report.projectId, report.branch);
            let stored!: StoredReport;
            await this.write(() => {
                this.t.reports.set(k, { ...report, version: ++this.version });
                stored = this.t.reports.get(k) as StoredReport;
            });
            return stored;
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
                if (!moving || from === to) return;
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
        removeProject: (workspaceId, projectId) =>
            this.write(() => this.t.activity.remove((r) => r.workspaceId === workspaceId && r.projectId === projectId)),
        list: async (f, page) =>
            this.t.activity.list(
                (r) =>
                    r.workspaceId === f.workspaceId &&
                    (!f.projectId || r.projectId === f.projectId) &&
                    (!f.branch || r.branch === f.branch),
                page,
            ),
    };

    reviewHistory: Repos["reviewHistory"] = {
        add: (record) => this.write(() => this.t.reviewHistory.add(record)),
        removeProject: (workspaceId, projectId) =>
            this.write(() => this.t.reviewHistory.remove((r) => r.workspaceId === workspaceId && r.projectId === projectId)),
        list: async (f, limit) =>
            this.t.reviewHistory.rows
                .filter(
                    (r) =>
                        r.workspaceId === f.workspaceId &&
                        (!f.projectId || r.projectId === f.projectId) &&
                        (!f.branch || r.branch === f.branch) &&
                        (!f.since || r.at >= f.since),
                )
                .map((r, i) => [r, i] as const)
                .sort(([a, i], [b, j]) => b.at.localeCompare(a.at) || j - i)
                .slice(0, limit)
                .map(([r]) => r),
        tokensSince: async (workspaceId, since, keySource) =>
            this.t.reviewHistory.rows
                .filter((r) => r.workspaceId === workspaceId && r.at >= since && (keySource === undefined || r.keySource === keySource))
                .reduce((n, r) => n + (r.tokens?.total ?? 0), 0),
        tokensByWorkspace: async (since, keySource) => {
            const out: Record<string, number> = {};
            for (const r of this.t.reviewHistory.rows) {
                if (r.at < since || (keySource !== undefined && r.keySource !== keySource) || !r.tokens?.total) continue;
                out[r.workspaceId] = (out[r.workspaceId] ?? 0) + r.tokens.total;
            }
            return out;
        },
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
        sweep: (now) =>
            this.write(() => {
                for (const l of this.t.uploadLinks.values()) if (l.expiresAt <= now) this.t.uploadLinks.delete(l.hash);
            }),
    };

    secrets: Repos["secrets"] = {
        get: async (workspaceId, projectId, name) => this.t.secrets.get(key(workspaceId ?? "", projectId ?? "", name)),
        list: async (workspaceId, projectId) =>
            this.t.secrets.values().filter((s) => s.workspaceId === workspaceId && s.projectId === projectId),
        put: (s) => this.write(() => this.t.secrets.set(key(s.workspaceId ?? "", s.projectId ?? "", s.name), s)),
        delete: (workspaceId, projectId, name) => this.write(() => this.t.secrets.delete(key(workspaceId ?? "", projectId ?? "", name))),
    };

    analyses: Repos["analyses"] = {
        get: async (id) => this.t.analyses.get(id),
        put: (a) => this.write(() => this.t.analyses.set(a.id, a)),
        list: async (f, limit) =>
            this.t.analyses
                .values()
                .filter(
                    (a) =>
                        a.workspaceId === f.workspaceId &&
                        (!f.kind || a.kind === f.kind) &&
                        (!f.projectId || a.projectId === f.projectId) &&
                        (f.subject === undefined || a.subject === f.subject) &&
                        (!f.since || a.createdAt >= f.since),
                )
                .sort((x, y) => y.createdAt.localeCompare(x.createdAt) || y.id.localeCompare(x.id))
                .slice(0, limit),
    };

    patterns: Repos["patterns"] = {
        get: async (id) => this.t.patterns.get(id),
        put: (p) => this.write(() => this.t.patterns.set(p.id, p)),
        delete: (id) =>
            this.write(() => {
                this.t.patterns.delete(id);
                for (const f of this.t.patternFindings.values()) if (f.patternId === id) this.t.patternFindings.delete(linkKey(f));
            }),
        forProject: async (projectId) =>
            this.t.patterns
                .values()
                .filter((p) => p.projectId === projectId)
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
        findings: async (projectId, branch) =>
            this.t.patternFindings.values().filter((f) => f.projectId === projectId && (branch === undefined || f.branch === branch)),
        link: (rows) =>
            this.write(() => {
                for (const r of rows) this.t.patternFindings.set(linkKey(r), r);
            }),
        unlink: (projectId, branch, findingIds) =>
            this.write(() => {
                for (const findingId of findingIds) this.t.patternFindings.delete(linkKey({ projectId, branch, findingId }));
            }),
        move: (from, to) =>
            this.write(() => {
                for (const f of this.t.patternFindings.values())
                    if (f.patternId === from) this.t.patternFindings.set(linkKey(f), { ...f, patternId: to });
            }),
        renameBranch: (projectId, from, to) =>
            this.write(() => {
                // What's left under the new name from a branch since deleted gives way to this branch's.
                for (const f of this.t.patternFindings.values()) {
                    if (f.projectId !== projectId || f.branch !== from) continue;
                    this.t.patternFindings.delete(linkKey(f));
                    this.t.patternFindings.set(linkKey({ ...f, branch: to }), { ...f, branch: to });
                }
            }),
    };

    origins: Repos["origins"] = {
        forBranch: async (projectId, branch) => this.t.origins.values().filter((o) => o.projectId === projectId && o.branch === branch),
        get: async (projectId, branch, findingId) => this.t.origins.get(linkKey({ projectId, branch, findingId })),
        replace: (projectId, branch, rows) =>
            this.write(() => {
                for (const o of this.t.origins.values())
                    if (o.projectId === projectId && o.branch === branch) this.t.origins.delete(linkKey(o));
                for (const r of rows) this.t.origins.set(linkKey(r), r);
            }),
        scan: async (projectId, branch) => this.t.originScans.get(key(projectId, branch)),
        putScan: (scan) => this.write(() => this.t.originScans.set(key(scan.projectId, scan.branch), scan)),
        renameBranch: (projectId, from, to) =>
            this.write(() => {
                // What's there under the new name gives way to this branch's.
                for (const o of this.t.origins.values())
                    if (o.projectId === projectId && o.branch === to) this.t.origins.delete(linkKey(o));
                for (const o of this.t.origins.values()) {
                    if (o.projectId !== projectId || o.branch !== from) continue;
                    this.t.origins.delete(linkKey(o));
                    this.t.origins.set(linkKey({ ...o, branch: to }), { ...o, branch: to });
                }
                const scan = this.t.originScans.get(key(projectId, from));
                this.t.originScans.delete(key(projectId, to));
                if (scan) {
                    this.t.originScans.delete(key(projectId, from));
                    this.t.originScans.set(key(projectId, to), { ...scan, branch: to });
                }
            }),
        clear: (workspaceId) =>
            this.write(() => {
                for (const o of this.t.origins.values()) if (o.workspaceId === workspaceId) this.t.origins.delete(linkKey(o));
                for (const o of this.t.originScans.values())
                    if (o.workspaceId === workspaceId) this.t.originScans.delete(key(o.projectId, o.branch));
            }),
    };

    findingSources: Repos["findingSources"] = {
        add: (rows) =>
            this.write(() => {
                for (const r of rows) {
                    // Already there: its first sighting stays, and its outcome is brought up to what triage says now.
                    const have = this.t.findingSources.get(sourceKey(r));
                    if (!have) this.t.findingSources.set(sourceKey(r), r);
                    else if (have.outcome !== r.outcome)
                        this.t.findingSources.set(sourceKey(r), { ...have, outcome: r.outcome, decidedAt: r.decidedAt });
                }
            }),
        setOutcome: (projectId, branch, findingId, outcome, at) =>
            this.write(() => {
                for (const s of this.t.findingSources.values())
                    if (s.projectId === projectId && s.branch === branch && s.findingId === findingId && s.outcome !== outcome)
                        this.t.findingSources.set(sourceKey(s), { ...s, outcome, decidedAt: outcome ? at : null });
            }),
        list: async (f, limit) =>
            this.t.findingSources
                .values()
                .filter(
                    (s) =>
                        s.workspaceId === f.workspaceId &&
                        (!f.projectId || s.projectId === f.projectId) &&
                        (!f.branch || s.branch === f.branch),
                )
                .sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt))
                .slice(0, limit),
        renameBranch: (projectId, from, to) =>
            this.write(() => {
                for (const s of this.t.findingSources.values()) {
                    if (s.projectId !== projectId || s.branch !== from) continue;
                    this.t.findingSources.delete(sourceKey(s));
                    const moved = { ...s, branch: to };
                    // One the new name already has keeps its first sighting, and takes this branch's outcome.
                    const have = this.t.findingSources.get(sourceKey(moved));
                    this.t.findingSources.set(sourceKey(moved), have ? { ...have, outcome: s.outcome, decidedAt: s.decidedAt } : moved);
                }
            }),
        removeProject: (workspaceId, projectId) =>
            this.write(() => {
                for (const s of this.t.findingSources.values())
                    if (s.workspaceId === workspaceId && s.projectId === projectId) this.t.findingSources.delete(sourceKey(s));
            }),
    };

    settings: Repos["settings"] = {
        get: async (workspaceId, projectId, k) => this.t.settings.get(key(workspaceId, projectId ?? "", k)),
        put: (s) => this.write(() => this.t.settings.set(key(s.workspaceId, s.projectId ?? "", s.key), s)),
    };

    jobs: Repos["jobs"] = {
        get: async (id) => this.t.jobs.get(id),
        put: (job) =>
            this.write(() => {
                const before = this.t.jobs.get(job.id);
                this.t.jobs.set(job.id, { ...job, logLines: before?.logLines ?? 0, logDropped: before?.logDropped ?? 0 });
            }),
        list: async (f, limit) =>
            this.t.jobs
                .values()
                .filter(
                    (j) =>
                        (!f.workspaceId || j.workspaceId === f.workspaceId) &&
                        (!f.projectId || j.projectId === f.projectId) &&
                        (!f.statuses || f.statuses.includes(j.status)),
                )
                .reverse()
                .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
                .slice(0, limit),
        active: async () =>
            this.t.jobs
                .values()
                .filter((j) => j.status === "queued" || j.status === "running")
                .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)),
        lastStarted: async () => {
            const out = new Map<string, string>();
            for (const j of this.t.jobs.values())
                if (j.startedAt && (out.get(j.workspaceId) ?? "") < j.startedAt) out.set(j.workspaceId, j.startedAt);
            return out;
        },
        appendLog: (jobId, lines, capBytes) =>
            this.write(() => {
                const job = this.t.jobs.get(jobId);
                if (!job || !lines.length) return;
                const log = this.t.jobLogs.get(jobId) ?? { lines: [], bytes: 0 };
                let seq = job.logLines;
                const added = lines.map((l) => Object.freeze({ seq: ++seq, at: l.at, line: l.line }));
                let kept = [...log.lines, ...added];
                let bytes = log.bytes + added.reduce((n, l) => n + Buffer.byteLength(l.line), 0);
                let drop = 0;
                while (bytes > capBytes && drop < kept.length) bytes -= Buffer.byteLength((kept[drop++] as LogLine).line);
                if (drop) kept = kept.slice(drop);
                this.t.jobLogs.setShared(jobId, Object.freeze({ lines: Object.freeze(kept), bytes }));
                this.t.jobs.set(jobId, { ...job, logLines: seq, logDropped: job.logDropped + drop });
            }),
        log: async (jobId, after, limit) => (this.t.jobLogs.get(jobId)?.lines ?? []).filter((l) => l.seq > after).slice(0, limit),
    };

    githubInstallations: Repos["githubInstallations"] = {
        get: async (id, workspaceId) => this.t.githubInstallations.get(installationKey(id, workspaceId)),
        forInstallation: async (id) =>
            this.t.githubInstallations
                .values()
                .filter((i) => i.id === id)
                .sort((a, b) => a.linkedAt.localeCompare(b.linkedAt) || a.workspaceId.localeCompare(b.workspaceId)),
        forWorkspace: async (workspaceId) => this.t.githubInstallations.values().filter((i) => i.workspaceId === workspaceId),
        put: (i) => this.write(() => this.t.githubInstallations.set(installationKey(i.id, i.workspaceId), i)),
        delete: (id, workspaceId) =>
            this.write(() => {
                for (const i of this.t.githubInstallations.values())
                    if (i.id === id && (workspaceId === undefined || i.workspaceId === workspaceId))
                        this.t.githubInstallations.delete(installationKey(i.id, i.workspaceId));
            }),
        deleteAll: () =>
            this.write(() => {
                for (const k of [...this.t.githubInstallations.rows.keys()]) this.t.githubInstallations.delete(k);
            }),
    };

    githubState: Repos["githubState"] = {
        get: async (projectId) => this.t.githubState.get(projectId)?.state ?? null,
        put: (projectId, state) => this.write(() => this.t.githubState.set(projectId, { state })),
    };

    githubDeliveries: Repos["githubDeliveries"] = {
        add: (d, keep) =>
            this.write(() => {
                const k = d.projectId ?? "";
                this.t.githubDeliveries.set(k, [d, ...(this.t.githubDeliveries.get(k) ?? [])].slice(0, keep));
            }),
        list: async (projectId, limit) => (this.t.githubDeliveries.get(projectId ?? "") ?? []).slice(0, limit),
    };

    runners: Repos["runners"] = {
        seen: (r) => this.write(() => this.t.runners.set(r.id, r)),
        list: async () => this.t.runners.values().sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    };

    instanceSettings: Repos["instanceSettings"] = {
        get: async (k) => this.t.instanceSettings.get(k)?.value ?? null,
        put: (k, value) => this.write(() => this.t.instanceSettings.set(k, { value })),
    };

    modelGrants: Repos["modelGrants"] = {
        get: async (workspaceId) => this.t.modelGrants.get(workspaceId),
        list: async () => this.t.modelGrants.values().sort((a, b) => a.grantedAt.localeCompare(b.grantedAt)),
        put: (g) => this.write(() => this.t.modelGrants.set(g.workspaceId, g)),
        delete: (workspaceId) => this.write(() => this.t.modelGrants.delete(workspaceId)),
    };

    invites: Repos["invites"] = {
        get: async (id) => this.t.invites.get(id),
        list: async (workspaceId) =>
            this.t.invites
                .values()
                .filter((i) => i.workspaceId === workspaceId)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
        pendingFor: async (email) => this.t.invites.values().filter((i) => i.email === email.toLowerCase() && !i.acceptedAt),
        put: (invite) => this.write(() => this.t.invites.set(invite.id, invite)),
        delete: (id) => this.write(() => this.t.invites.delete(id)),
    };
}
