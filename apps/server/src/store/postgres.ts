// A Store on Postgres (db/migrations holds the schema).
//
// Services read a record, decide, and write it back, and count on nothing changing in between: the memory
// store gets that by running transactions one at a time. Here every transaction is SERIALIZABLE, so
// Postgres refuses to commit one that overlapped another in a way no one-at-a-time order would allow, and
// it's run again from the start, up to a few times. Callbacks must therefore be safe to re-run: anything
// that should happen only once the change is saved goes through `afterCommit`.
//
// The current transaction is carried in AsyncLocalStorage. A transaction started inside another joins it,
// and any repository call made while one is running uses it, even if made through the store rather than
// `tx`. A write outside any transaction runs as a transaction of its own.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import postgres from "postgres";
import type { Relay } from "../services/events.ts";
import type {
    ActivityRow,
    ApiToken,
    ArchivedReport,
    AuditRow,
    GithubDelivery,
    GithubInstallation,
    Invite,
    Job,
    Membership,
    ModelGrant,
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

type Sql = postgres.Sql;
type Query = postgres.ISql;
type Row = postgres.Row;

export interface PostgresOptions {
    /** Keep the tables in this schema (created by the migrations if missing) rather than `public`. */
    schema?: string;
    /** Connections in the pool. */
    max?: number;
    /** Close connections idle this many seconds (0: keep them). */
    idleTimeout?: number;
    /** How many times to try a transaction that keeps losing to concurrent ones. */
    maxAttempts?: number;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function connect(url: string, { schema, max = 10, idleTimeout = 0 }: PostgresOptions = {}): Sql {
    if (schema !== undefined && !SCHEMA_NAME.test(schema))
        throw new Error(`"${schema}" isn't a usable schema name: use lower-case letters, digits and underscores.`);
    return postgres(url, {
        max,
        idle_timeout: idleTimeout || null,
        onnotice: () => {},
        transform: { undefined: null },
        connection: { application_name: "triagent", ...(schema ? { search_path: schema } : {}) },
    } as postgres.Options<Record<string, postgres.PostgresType>>);
}

/**
 * Failures that mean "this transaction overlapped another; try again": serialization failure and deadlock,
 * plus unique violations, which is how Postgres reports two transactions inserting the same new key after
 * each checked it was free.
 */
const RETRYABLE = new Set(["40001", "40P01", "23505"]);
const retryable = (err: unknown) => err instanceof postgres.PostgresError && RETRYABLE.has(err.code);

interface Tx {
    sql: Query;
    after: (() => void)[];
    /** A retryable failure seen by any query, in case the callback caught it and threw something else. */
    failure: unknown;
    done: boolean;
}

const json = (sql: Query, value: unknown) => sql.json(value as postgres.JSONValue);
const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);
/** `column = value`, or `column is null`. */
const same = (sql: Query, column: string, value: string | null) =>
    value === null ? sql`${sql(column)} is null` : sql`${sql(column)} = ${value}`;

function runHooks(hooks: (() => void)[]): void {
    for (const hook of hooks) {
        try {
            hook();
        } catch (err) {
            console.error("A hook run after a saved change failed:", err);
        }
    }
}

// ---- rows to records ------------------------------------------------------------------------

const toUser = (r: Row): User => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    email: r.email,
    passwordHash: r.password_hash,
    mustChangePassword: r.must_change_password,
    isInstanceAdmin: r.is_instance_admin,
    issuer: r.issuer,
    subject: r.subject,
    notify: r.notify,
    tutorial: r.tutorial,
    createdAt: iso(r.created_at),
    lastLoginAt: isoOrNull(r.last_login_at),
});

const toSession = (r: Row): Session => ({
    idHash: r.id_hash,
    userId: r.user_id,
    csrf: r.csrf,
    credential: r.credential,
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
    authAt: Number(r.auth_at),
    ...(r.id_token ? { idToken: r.id_token } : {}),
});

const toInvite = (r: Row): Invite => ({
    id: r.id,
    email: r.email,
    workspaceId: r.workspace_id,
    role: r.role,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    acceptedAt: isoOrNull(r.accepted_at),
    acceptedBy: r.accepted_by,
});

const toWorkspace = (r: Row): Workspace => ({ id: r.id, slug: r.slug, name: r.name, kind: r.kind, createdAt: iso(r.created_at) });

const toMembership = (r: Row): Membership => ({
    workspaceId: r.workspace_id,
    userId: r.user_id,
    role: r.role,
    createdAt: iso(r.created_at),
});

const toToken = (r: Row): ApiToken => ({
    id: r.id,
    workspaceId: r.workspace_id,
    ownerUserId: r.owner_user_id,
    name: r.name,
    scope: r.scope,
    hash: r.hash,
    prefix: r.prefix,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    expiresAt: isoOrNull(r.expires_at),
    lastUsedAt: isoOrNull(r.last_used_at),
});

const toProject = (r: Row): Project => ({
    id: r.id,
    workspaceId: r.workspace_id,
    slug: r.slug,
    name: r.name,
    repoUrl: r.repo_url,
    defaultBranch: r.default_branch,
    webhookId: r.webhook_id,
    createdAt: iso(r.created_at),
});

const toReport = (r: Row): StoredReport => ({
    projectId: r.project_id,
    branch: r.branch,
    report: r.report,
    upload: r.upload,
    version: Number(r.version),
});

const toArchived = (r: Row): ArchivedReport => ({
    projectId: r.project_id,
    branch: r.branch,
    report: r.report,
    upload: r.upload,
    archivedAt: iso(r.archived_at),
    reason: r.reason,
    ...(r.triage ? { triage: r.triage } : {}),
});

const toTriage = (r: Row): TriageRecord => ({
    projectId: r.project_id,
    branch: r.branch,
    kind: r.kind,
    itemId: r.item_id,
    status: r.status,
    assignee: r.assignee,
    severity: r.severity,
    category: r.category,
    duplicateOf: r.duplicate_of,
    needsDiscussion: r.needs_discussion,
    notes: r.notes,
    rev: r.rev,
    updatedAt: isoOrNull(r.updated_at),
    updatedBy: r.updated_by,
});

const toReviewRecord = (r: Row): ReviewRecord => ({
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    branch: r.branch,
    at: iso(r.at),
    source: r.source,
    kind: r.kind,
    status: r.status,
    model: r.model,
    provider: r.provider,
    keySource: r.key_source,
    tokens: r.tokens,
    details: r.details,
});

const toActivity = (r: Row): ActivityRow => ({
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    branch: r.branch,
    at: iso(r.at),
    actor: r.actor,
    actorUserId: r.actor_user_id,
    via: r.via,
    kind: r.kind,
    itemId: r.item_id,
    changes: r.changes,
});

const toAudit = (r: Row): AuditRow => ({
    id: r.id,
    workspaceId: r.workspace_id,
    at: iso(r.at),
    actor: r.actor,
    actorUserId: r.actor_user_id,
    via: r.via,
    kind: r.kind,
    target: r.target,
    changes: r.changes,
    ip: r.ip,
});

const toLink = (r: Row): UploadLink => ({ hash: r.hash, projectId: r.project_id, params: r.params, expiresAt: Number(r.expires_at) });

const toSecret = (r: Row): SecretRecord => ({
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    name: r.name,
    sealed: r.sealed,
    hint: r.hint,
    setBy: r.set_by,
    setAt: iso(r.set_at),
});

const toJob = (r: Row): Job => ({
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    kind: r.kind,
    dedupeKey: r.dedupe_key,
    title: r.title,
    branch: r.branch,
    gitRef: r.git_ref,
    baseRef: r.base_ref,
    headSha: r.head_sha,
    baseSha: r.base_sha,
    pr: r.pr,
    // The models a run was asked to use are kept with who asked (see `put`).
    requestedBy: (({ models: _m, ...by }) => by)(r.requested_by),
    requestedModels: r.requested_by.models ?? null,
    source: r.source,
    status: r.status,
    queuedAt: iso(r.queued_at),
    startedAt: isoOrNull(r.started_at),
    finishedAt: isoOrNull(r.finished_at),
    runnerId: r.runner_id,
    leaseExpiresAt: isoOrNull(r.lease_expires_at),
    cancelRequested: r.cancel_requested,
    progress: r.progress,
    result: r.result,
    error: r.error,
    model: r.model,
    credentials: r.credentials,
    repository: r.repository ?? null,
    logLines: r.log_lines,
    logDropped: r.log_dropped,
});

const toInstallation = (r: Row): GithubInstallation => ({
    id: Number(r.id),
    workspaceId: r.workspace_id,
    accountLogin: r.account_login,
    accountType: r.account_type,
    repositorySelection: r.repository_selection,
    suspended: r.suspended,
    linkedBy: r.linked_by,
    linkedAt: iso(r.linked_at),
});

const toDelivery = (r: Row): GithubDelivery => ({
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    at: iso(r.at),
    event: r.event,
    deliveryId: r.delivery_id,
    what: r.what,
    outcome: r.outcome,
    detail: r.detail,
});

const toRunner = (r: Row): RunnerRecord => ({
    id: r.id,
    name: r.name,
    version: r.version,
    slots: r.slots,
    lastSeenAt: iso(r.last_seen_at),
});

const toGrant = (r: Row): ModelGrant => ({
    workspaceId: r.workspace_id,
    monthlyTokens: Number(r.monthly_tokens),
    grantedBy: r.granted_by,
    grantedAt: iso(r.granted_at),
});

const toSetting = (r: Row): SettingRecord => ({ workspaceId: r.workspace_id, projectId: r.project_id, key: r.key, value: r.value });

const first = <T>(rows: readonly Row[], map: (r: Row) => T): T | null => (rows[0] ? map(rows[0]) : null);

export class PostgresStore implements Store {
    readonly sql: Sql;
    readonly schema: string | undefined;
    private readonly maxAttempts: number;
    private readonly context = new AsyncLocalStorage<Tx>();
    private readonly url: string;
    /** The connection holding instance-wide advisory locks (see holdLock), and the names this process took. */
    private lockSql: Sql | null = null;
    private readonly locks = new Set<string>();

    constructor(url: string, options: PostgresOptions = {}) {
        this.url = url;
        this.sql = connect(url, options);
        this.schema = options.schema;
        this.maxAttempts = options.maxAttempts ?? 10;
    }

    private current(): Tx | null {
        const tx = this.context.getStore();
        return tx && !tx.done ? tx : null;
    }

    async transaction<T>(fn: (tx: Repos) => Promise<T>): Promise<T> {
        if (this.current()) return fn(this);
        for (let attempt = 1; ; attempt++) {
            const tx: Tx = { sql: this.sql, after: [], failure: null, done: false };
            try {
                const value = await this.sql.begin("isolation level serializable", (sql) => {
                    tx.sql = sql;
                    return this.context.run(tx, () => fn(this));
                });
                tx.done = true;
                runHooks(tx.after);
                return value as T;
            } catch (err) {
                tx.done = true;
                if (!(retryable(err) || tx.failure) || attempt >= this.maxAttempts) throw err;
                // Back off by a random, growing amount, so transactions that collided don't collide again.
                await new Promise((r) => setTimeout(r, Math.random() * Math.min(250, 4 * 2 ** attempt)));
            }
        }
    }

    afterCommit(fn: () => void): void {
        const tx = this.current();
        if (tx) tx.after.push(fn);
        else runHooks([fn]);
    }

    /** Run a query in the current transaction, if there is one. */
    private async run<T>(fn: (sql: Query) => Promise<T>): Promise<T> {
        const tx = this.current();
        if (!tx) return fn(this.sql);
        try {
            return await fn(tx.sql);
        } catch (err) {
            if (retryable(err)) tx.failure ??= err;
            throw err;
        }
    }

    /** Run a write in the current transaction, or as a transaction of its own. */
    private write<T>(fn: (sql: Query) => Promise<T>): Promise<T> {
        return this.current() ? this.run(fn) : this.transaction(() => this.run(fn));
    }

    private rows(fn: (sql: Query) => Promise<readonly Row[]>): Promise<readonly Row[]> {
        return this.run(fn);
    }

    /** Insert `row`, or update every other column of the row with the same `key`. */
    private upsert(table: string, row: Record<string, unknown>, key: string[]): Promise<void> {
        const columns = Object.keys(row).filter((c) => !key.includes(c));
        return this.write(async (sql) => {
            await sql`
                insert into ${sql(table)} ${sql(row as Record<string, postgres.ParameterOrJSON<never>>)}
                on conflict (${sql(key)}) do update set ${sql(row as Record<string, postgres.ParameterOrJSON<never>>, columns)}`;
        });
    }

    /**
     * Live updates for the other server processes using this database and schema, by LISTEN/NOTIFY.
     * Messages go out once a change is saved (live updates are sent after commit), outside any transaction.
     */
    relay(): Relay {
        // Channel names are identifiers (at most 63 bytes), so a schema is folded into a short hash.
        const channel = this.schema
            ? `triagent_events_${createHash("sha256").update(this.schema).digest("hex").slice(0, 16)}`
            : "triagent_events";
        return {
            send: (message) => {
                this.sql
                    .notify(channel, message)
                    .catch((err: unknown) => console.error("Couldn't send a live update to other processes:", err));
            },
            listen: async (receive) => {
                await this.sql.listen(channel, receive);
            },
        };
    }

    async holdLock(name: string): Promise<boolean> {
        const key = `triagent:${this.schema ?? "public"}:${name}`;
        // One connection of its own holds every lock. If it drops, the pool behind it reconnects as a new
        // session, which doesn't hold them, so ask Postgres rather than trusting what this process took.
        this.lockSql ??= postgres(this.url, {
            max: 1,
            max_lifetime: null,
            onnotice: () => {},
            connection: { application_name: "triagent" },
        });
        const sql = this.lockSql;
        try {
            if (this.locks.has(name)) {
                const [row] = await sql`
                    select exists (
                        select 1 from pg_locks
                        where locktype = 'advisory' and pid = pg_backend_pid() and granted and objsubid = 1
                            and ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)
                    ) as ok`;
                if (row?.ok) return true;
                this.locks.delete(name);
            }
            const [row] = await sql`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as ok`;
            if (!row?.ok) return false;
            this.locks.add(name);
            return true;
        } catch {
            // the database is unreachable: someone else may have it
            return false;
        }
    }

    async ping(): Promise<void> {
        await this.sql`select 1`;
    }

    async close(): Promise<void> {
        this.locks.clear();
        await Promise.all([this.sql.end({ timeout: 5 }), this.lockSql?.end({ timeout: 5 })]);
    }

    // ---- repositories ------------------------------------------------------------------

    users: Repos["users"] = {
        get: async (id) => first(await this.rows((sql) => sql`select * from users where id = ${id}`), toUser),
        byUsername: async (username) =>
            first(await this.rows((sql) => sql`select * from users where lower(username) = lower(${username})`), toUser),
        byIdentity: async (issuer, subject) =>
            first(await this.rows((sql) => sql`select * from users where issuer = ${issuer} and subject = ${subject}`), toUser),
        list: async () => (await this.rows((sql) => sql`select * from users order by created_at, id`)).map(toUser),
        count: async () => Number((await this.rows((sql) => sql`select count(*) as n from users`))[0]?.n ?? 0),
        put: (u) =>
            this.upsert(
                "users",
                {
                    id: u.id,
                    username: u.username,
                    display_name: u.displayName,
                    email: u.email,
                    password_hash: u.passwordHash,
                    must_change_password: u.mustChangePassword,
                    is_instance_admin: u.isInstanceAdmin,
                    issuer: u.issuer,
                    subject: u.subject,
                    notify: json(this.sql, u.notify),
                    tutorial: json(this.sql, u.tutorial),
                    created_at: u.createdAt,
                    last_login_at: u.lastLoginAt,
                },
                ["id"],
            ),
        delete: (id) =>
            this.write(async (sql) => {
                await sql`delete from users where id = ${id}`;
            }),
    };

    sessions: Repos["sessions"] = {
        get: async (idHash) => first(await this.rows((sql) => sql`select * from sessions where id_hash = ${idHash}`), toSession),
        listForUser: async (userId) =>
            (await this.rows((sql) => sql`select * from sessions where user_id = ${userId} order by created_at, id_hash`)).map(toSession),
        // A plain upsert: the service re-reads a session before saving it, so a deleted one stays deleted.
        put: (s) =>
            this.upsert(
                "sessions",
                {
                    id_hash: s.idHash,
                    user_id: s.userId,
                    csrf: s.csrf,
                    credential: s.credential,
                    created_at: s.createdAt,
                    last_seen_at: s.lastSeenAt,
                    auth_at: s.authAt,
                    id_token: s.idToken ?? null,
                },
                ["id_hash"],
            ),
        delete: (idHash) =>
            this.write(async (sql) => {
                await sql`delete from sessions where id_hash = ${idHash}`;
            }),
        sweep: (idleBefore, createdBefore) =>
            this.write(
                async (sql) => (await sql`delete from sessions where last_seen_at < ${idleBefore} or created_at < ${createdBefore}`).count,
            ),
    };

    workspaces: Repos["workspaces"] = {
        get: async (id) => first(await this.rows((sql) => sql`select * from workspaces where id = ${id}`), toWorkspace),
        bySlug: async (slug) => first(await this.rows((sql) => sql`select * from workspaces where slug = ${slug}`), toWorkspace),
        list: async () => (await this.rows((sql) => sql`select * from workspaces order by created_at, id`)).map(toWorkspace),
        put: (w) => this.upsert("workspaces", { id: w.id, slug: w.slug, name: w.name, kind: w.kind, created_at: w.createdAt }, ["id"]),
        // Its projects, memberships, tokens, settings, secrets and activity go with it (foreign keys).
        delete: (id) =>
            this.write(async (sql) => {
                await sql`delete from workspaces where id = ${id}`;
            }),
    };

    memberships: Repos["memberships"] = {
        get: async (workspaceId, userId) =>
            first(
                await this.rows((sql) => sql`select * from memberships where workspace_id = ${workspaceId} and user_id = ${userId}`),
                toMembership,
            ),
        forUser: async (userId) =>
            (await this.rows((sql) => sql`select * from memberships where user_id = ${userId} order by created_at, workspace_id`)).map(
                toMembership,
            ),
        forWorkspace: async (workspaceId) =>
            (await this.rows((sql) => sql`select * from memberships where workspace_id = ${workspaceId} order by created_at, user_id`)).map(
                toMembership,
            ),
        put: (m) =>
            this.upsert("memberships", { workspace_id: m.workspaceId, user_id: m.userId, role: m.role, created_at: m.createdAt }, [
                "workspace_id",
                "user_id",
            ]),
        delete: (workspaceId, userId) =>
            this.write(async (sql) => {
                await sql`delete from memberships where workspace_id = ${workspaceId} and user_id = ${userId}`;
            }),
    };

    tokens: Repos["tokens"] = {
        get: async (id) => first(await this.rows((sql) => sql`select * from api_tokens where id = ${id}`), toToken),
        byHash: async (hash) => first(await this.rows((sql) => sql`select * from api_tokens where hash = ${hash}`), toToken),
        forWorkspace: async (workspaceId) =>
            (await this.rows((sql) => sql`select * from api_tokens where workspace_id = ${workspaceId} order by created_at, id`)).map(
                toToken,
            ),
        put: (t) =>
            this.upsert(
                "api_tokens",
                {
                    id: t.id,
                    workspace_id: t.workspaceId,
                    owner_user_id: t.ownerUserId,
                    name: t.name,
                    scope: t.scope,
                    hash: t.hash,
                    prefix: t.prefix,
                    created_at: t.createdAt,
                    created_by: t.createdBy,
                    expires_at: t.expiresAt,
                    last_used_at: t.lastUsedAt,
                },
                ["id"],
            ),
        delete: (id) =>
            this.write(async (sql) => {
                await sql`delete from api_tokens where id = ${id}`;
            }),
    };

    projects: Repos["projects"] = {
        get: async (id) => first(await this.rows((sql) => sql`select * from projects where id = ${id}`), toProject),
        bySlug: async (workspaceId, slug) =>
            first(await this.rows((sql) => sql`select * from projects where workspace_id = ${workspaceId} and slug = ${slug}`), toProject),
        byWebhookId: async (webhookId) =>
            first(await this.rows((sql) => sql`select * from projects where webhook_id = ${webhookId}`), toProject),
        forWorkspace: async (workspaceId) =>
            (await this.rows((sql) => sql`select * from projects where workspace_id = ${workspaceId} order by created_at, id`)).map(
                toProject,
            ),
        put: (p) =>
            this.upsert(
                "projects",
                {
                    id: p.id,
                    workspace_id: p.workspaceId,
                    slug: p.slug,
                    name: p.name,
                    repo_url: p.repoUrl,
                    default_branch: p.defaultBranch,
                    webhook_id: p.webhookId,
                    created_at: p.createdAt,
                },
                ["id"],
            ),
        // Reports, archive, triage, upload links, settings and secrets go with it (foreign keys).
        delete: (id) =>
            this.write(async (sql) => {
                await sql`delete from projects where id = ${id}`;
            }),
    };

    reports: Repos["reports"] = {
        get: async (projectId, branch) =>
            first(await this.rows((sql) => sql`select * from reports where project_id = ${projectId} and branch = ${branch}`), toReport),
        branches: async (projectId) =>
            (await this.rows((sql) => sql`select * from reports where project_id = ${projectId} order by branch`)).map(toReport),
        put: (r) =>
            this.write(async (sql) => {
                const [row] = await sql`
                    insert into reports (project_id, branch, report, upload)
                    values (${r.projectId}, ${r.branch}, ${json(sql, r.report)}, ${json(sql, r.upload)})
                    on conflict (project_id, branch) do update
                        set report = excluded.report, upload = excluded.upload, version = nextval('report_versions')
                    returning version`;
                return { projectId: r.projectId, branch: r.branch, report: r.report, upload: r.upload, version: Number(row?.version) };
            }),
        delete: (projectId, branch) =>
            this.write(async (sql) => {
                await sql`delete from reports where project_id = ${projectId} and branch = ${branch}`;
            }),
        archive: (entry, keep) =>
            this.write(async (sql) => {
                await sql`
                    insert into report_archive (project_id, branch, report, upload, archived_at, reason, triage)
                    values (${entry.projectId}, ${entry.branch}, ${json(sql, entry.report)}, ${json(sql, entry.upload)},
                            ${entry.archivedAt}, ${entry.reason}, ${entry.triage ? json(sql, entry.triage) : null})`;
                if (keep > 0)
                    await sql`
                        delete from report_archive
                        where project_id = ${entry.projectId} and branch = ${entry.branch} and seq not in (
                            select seq from report_archive where project_id = ${entry.projectId} and branch = ${entry.branch}
                            order by archived_at desc, seq desc limit ${keep})`;
            }),
        archived: async (projectId, branch) =>
            (
                await this.rows(
                    (sql) =>
                        sql`select * from report_archive where project_id = ${projectId} and branch = ${branch} order by archived_at desc, seq desc`,
                )
            ).map(toArchived),
        renameArchive: (projectId, from, to) =>
            this.write(async (sql) => {
                await sql`update report_archive set branch = ${to} where project_id = ${projectId} and branch = ${from}`;
            }),
    };

    triage: Repos["triage"] = {
        get: async (projectId, branch, kind, itemId) =>
            first(
                await this.rows(
                    (sql) =>
                        sql`select * from triage where project_id = ${projectId} and branch = ${branch} and kind = ${kind} and item_id = ${itemId}`,
                ),
                toTriage,
            ),
        forBranch: async (projectId, branch) =>
            (
                await this.rows(
                    (sql) => sql`select * from triage where project_id = ${projectId} and branch = ${branch} order by kind, item_id`,
                )
            ).map(toTriage),
        put: (r) =>
            this.upsert(
                "triage",
                {
                    project_id: r.projectId,
                    branch: r.branch,
                    kind: r.kind,
                    item_id: r.itemId,
                    status: r.status,
                    assignee: r.assignee,
                    severity: r.severity,
                    category: r.category,
                    duplicate_of: r.duplicateOf,
                    needs_discussion: r.needsDiscussion,
                    notes: json(this.sql, r.notes),
                    rev: r.rev,
                    updated_at: r.updatedAt,
                    updated_by: r.updatedBy,
                },
                ["project_id", "branch", "kind", "item_id"],
            ),
        deleteBranch: (projectId, branch) =>
            this.write(async (sql) => {
                await sql`delete from triage where project_id = ${projectId} and branch = ${branch}`;
            }),
        // Records moving in replace any already there for the same item.
        renameBranch: (projectId, from, to) =>
            this.write(async (sql) => {
                await sql`
                    delete from triage t where t.project_id = ${projectId} and t.branch = ${to} and exists (
                        select 1 from triage f
                        where f.project_id = ${projectId} and f.branch = ${from} and f.kind = t.kind and f.item_id = t.item_id)`;
                await sql`update triage set branch = ${to} where project_id = ${projectId} and branch = ${from}`;
            }),
    };

    activity: Repos["activity"] = {
        add: (row) =>
            this.write(async (sql) => {
                await sql`
                    insert into activity (id, workspace_id, project_id, branch, at, actor, actor_user_id, via, kind, item_id, changes)
                    values (${row.id}, ${row.workspaceId}, ${row.projectId}, ${row.branch}, ${row.at}, ${row.actor}, ${row.actorUserId},
                            ${row.via}, ${row.kind}, ${row.itemId}, ${json(sql, row.changes)})`;
            }),
        removeProject: (workspaceId, projectId) =>
            this.write(async (sql) => {
                await sql`delete from activity where workspace_id = ${workspaceId} and project_id = ${projectId}`;
            }),
        list: async (f, page) =>
            (
                await this.rows(
                    (sql) => sql`
                        select * from activity
                        where workspace_id = ${f.workspaceId}
                        ${f.projectId ? sql`and project_id = ${f.projectId}` : sql``}
                        ${f.branch ? sql`and branch = ${f.branch}` : sql``}
                        ${page.before ? sql`and seq < (select seq from activity where id = ${page.before})` : sql``}
                        order by seq desc
                        limit ${page.limit}`,
                )
            ).map(toActivity),
    };

    audit: Repos["audit"] = {
        add: (row) =>
            this.write(async (sql) => {
                await sql`
                    insert into audit (id, workspace_id, at, actor, actor_user_id, via, kind, target, changes, ip)
                    values (${row.id}, ${row.workspaceId}, ${row.at}, ${row.actor}, ${row.actorUserId}, ${row.via}, ${row.kind},
                            ${row.target}, ${json(sql, row.changes)}, ${row.ip})`;
            }),
        list: async (f, page) =>
            (
                await this.rows(
                    (sql) => sql`
                        select * from audit
                        where ${same(sql, "workspace_id", f.workspaceId)}
                        ${page.before ? sql`and seq < (select seq from audit where id = ${page.before})` : sql``}
                        order by seq desc
                        limit ${page.limit}`,
                )
            ).map(toAudit),
    };

    uploadLinks: Repos["uploadLinks"] = {
        put: (l) =>
            this.upsert(
                "upload_links",
                { hash: l.hash, project_id: l.projectId, params: json(this.sql, l.params), expires_at: l.expiresAt },
                ["hash"],
            ),
        get: async (hash) => first(await this.rows((sql) => sql`select * from upload_links where hash = ${hash}`), toLink),
        // One statement: of two callers taking the same link, only one gets a row back.
        take: (hash) => this.write(async (sql) => first(await sql`delete from upload_links where hash = ${hash} returning *`, toLink)),
        count: async () => Number((await this.rows((sql) => sql`select count(*) as n from upload_links`))[0]?.n ?? 0),
        sweep: (now) =>
            this.write(async (sql) => {
                await sql`delete from upload_links where expires_at <= ${now}`;
            }),
    };

    secrets: Repos["secrets"] = {
        get: async (workspaceId, projectId, name) =>
            first(
                await this.rows(
                    (sql) =>
                        sql`select * from secrets where ${same(sql, "workspace_id", workspaceId)} and ${same(sql, "project_id", projectId)} and name = ${name}`,
                ),
                toSecret,
            ),
        list: async (workspaceId, projectId) =>
            (
                await this.rows(
                    (sql) =>
                        sql`select * from secrets where ${same(sql, "workspace_id", workspaceId)} and ${same(sql, "project_id", projectId)} order by name`,
                )
            ).map(toSecret),
        put: (s) =>
            this.upsert(
                "secrets",
                {
                    workspace_id: s.workspaceId,
                    project_id: s.projectId,
                    name: s.name,
                    sealed: s.sealed,
                    hint: s.hint,
                    set_by: s.setBy,
                    set_at: s.setAt,
                },
                ["workspace_id", "project_id", "name"],
            ),
        delete: (workspaceId, projectId, name) =>
            this.write(async (sql) => {
                await sql`delete from secrets where ${same(sql, "workspace_id", workspaceId)} and ${same(sql, "project_id", projectId)} and name = ${name}`;
            }),
    };

    reviewHistory: Repos["reviewHistory"] = {
        add: (r) =>
            this.write(async (sql) => {
                await sql`
                    insert into review_history (id, workspace_id, project_id, branch, at, source, kind, status, model, provider,
                                                key_source, tokens, tokens_total, details)
                    values (${r.id}, ${r.workspaceId}, ${r.projectId}, ${r.branch}, ${r.at}, ${r.source}, ${r.kind}, ${r.status},
                            ${r.model}, ${r.provider}, ${r.keySource}, ${r.tokens ? json(sql, r.tokens) : null},
                            ${r.tokens?.total ?? 0}, ${json(sql, r.details)})`;
            }),
        list: async (f, limit) =>
            (
                await this.rows(
                    (sql) => sql`
                        select * from review_history
                        where workspace_id = ${f.workspaceId}
                        ${f.projectId ? sql`and project_id = ${f.projectId}` : sql``}
                        ${f.branch ? sql`and branch = ${f.branch}` : sql``}
                        ${f.since ? sql`and at >= ${f.since}` : sql``}
                        order by at desc, seq desc
                        limit ${limit}`,
                )
            ).map(toReviewRecord),
        tokensSince: async (workspaceId, since, keySource) => {
            const rows = await this.rows(
                (sql) => sql`
                    select coalesce(sum(tokens_total), 0)::bigint as total from review_history
                    where workspace_id = ${workspaceId} and at >= ${since}
                    ${keySource === undefined ? sql`` : sql`and ${same(sql, "key_source", keySource)}`}`,
            );
            return Number(rows[0]?.total ?? 0);
        },
        removeProject: (workspaceId, projectId) =>
            this.write(async (sql) => {
                await sql`delete from review_history where workspace_id = ${workspaceId} and project_id = ${projectId}`;
            }),
        tokensByWorkspace: async (since, keySource) => {
            const rows = await this.rows(
                (sql) => sql`
                    select workspace_id, sum(tokens_total)::bigint as total from review_history
                    where at >= ${since} and tokens_total > 0
                    ${keySource === undefined ? sql`` : sql`and ${same(sql, "key_source", keySource)}`}
                    group by workspace_id`,
            );
            return Object.fromEntries(rows.map((r) => [r.workspace_id as string, Number(r.total)]));
        },
    };

    settings: Repos["settings"] = {
        get: async (workspaceId, projectId, key) =>
            first(
                await this.rows(
                    (sql) =>
                        sql`select * from settings where workspace_id = ${workspaceId} and ${same(sql, "project_id", projectId)} and key = ${key}`,
                ),
                toSetting,
            ),
        put: (s) =>
            this.upsert("settings", { workspace_id: s.workspaceId, project_id: s.projectId, key: s.key, value: json(this.sql, s.value) }, [
                "workspace_id",
                "project_id",
                "key",
            ]),
    };

    jobs: Repos["jobs"] = {
        get: async (id) => first(await this.rows((sql) => sql`select * from jobs where id = ${id}`), toJob),
        put: (j) =>
            this.upsert(
                "jobs",
                {
                    id: j.id,
                    workspace_id: j.workspaceId,
                    project_id: j.projectId,
                    kind: j.kind,
                    dedupe_key: j.dedupeKey,
                    title: j.title,
                    branch: j.branch,
                    git_ref: j.gitRef,
                    base_ref: j.baseRef,
                    head_sha: j.headSha,
                    base_sha: j.baseSha,
                    pr: j.pr ? json(this.sql, j.pr) : null,
                    // The models asked for go with who asked: there's no column of their own.
                    requested_by: json(this.sql, { ...j.requestedBy, ...(j.requestedModels ? { models: j.requestedModels } : {}) }),
                    source: j.source,
                    status: j.status,
                    queued_at: j.queuedAt,
                    started_at: j.startedAt,
                    finished_at: j.finishedAt,
                    runner_id: j.runnerId,
                    lease_expires_at: j.leaseExpiresAt,
                    cancel_requested: j.cancelRequested ? json(this.sql, j.cancelRequested) : null,
                    progress: json(this.sql, j.progress),
                    result: j.result ? json(this.sql, j.result) : null,
                    error: j.error,
                    model: j.model ? json(this.sql, j.model) : null,
                    credentials: j.credentials,
                    repository: j.repository ? json(this.sql, j.repository) : null,
                },
                ["id"],
            ),
        list: async (f, limit) =>
            (
                await this.rows(
                    (sql) => sql`
                        select * from jobs
                        where true
                        ${f.workspaceId ? sql`and workspace_id = ${f.workspaceId}` : sql``}
                        ${f.projectId ? sql`and project_id = ${f.projectId}` : sql``}
                        ${f.statuses ? (f.statuses.length ? sql`and status in ${sql(f.statuses as string[])}` : sql`and false`) : sql``}
                        order by queued_at desc, seq desc
                        limit ${limit}`,
                )
            ).map(toJob),
        active: async () =>
            (await this.rows((sql) => sql`select * from jobs where status in ('queued', 'running') order by queued_at, seq`)).map(toJob),
        lastStarted: async () =>
            new Map(
                (
                    await this.rows(
                        (sql) =>
                            sql`select workspace_id, max(started_at) as at from jobs where started_at is not null group by workspace_id`,
                    )
                ).map((r) => [r.workspace_id as string, iso(r.at)]),
            ),
        appendLog: (jobId, lines, capBytes) =>
            this.write(async (sql) => {
                if (!lines.length) return;
                const [job] = await sql`select log_lines, log_bytes from jobs where id = ${jobId}`;
                if (!job) return;
                const start = Number(job.log_lines);
                const rows = lines.map((l, i) => ({ job_id: jobId, seq: start + i + 1, at: l.at, line: l.line }));
                await sql`insert into job_logs ${sql(rows)}`;
                const bytes = Number(job.log_bytes) + lines.reduce((n, l) => n + Buffer.byteLength(l.line), 0);
                let dropped = 0;
                let kept = bytes;
                if (bytes > capBytes) {
                    // Keep the newest lines that fit; drop the rest from the front.
                    const gone = await sql`
                        delete from job_logs l using (
                            select seq, octet_length(line) as size from (
                                select seq, line, sum(octet_length(line)) over (order by seq desc) as tail
                                from job_logs where job_id = ${jobId}
                            ) t where tail > ${capBytes}
                        ) d
                        where l.job_id = ${jobId} and l.seq = d.seq
                        returning d.size`;
                    dropped = gone.length;
                    kept -= gone.reduce((n, r) => n + Number(r.size), 0);
                }
                await sql`
                    update jobs set log_lines = ${start + lines.length}, log_bytes = ${kept}, log_dropped = log_dropped + ${dropped}
                    where id = ${jobId}`;
            }),
        log: async (jobId, after, limit) =>
            (
                await this.rows(
                    (sql) => sql`select seq, at, line from job_logs where job_id = ${jobId} and seq > ${after} order by seq limit ${limit}`,
                )
            ).map((r) => ({ seq: r.seq, at: iso(r.at), line: r.line })),
    };

    githubInstallations: Repos["githubInstallations"] = {
        get: async (id) => first(await this.rows((sql) => sql`select * from github_installations where id = ${id}`), toInstallation),
        forWorkspace: async (workspaceId) =>
            (
                await this.rows((sql) => sql`select * from github_installations where workspace_id = ${workspaceId} order by linked_at, id`)
            ).map(toInstallation),
        put: (i) =>
            this.upsert(
                "github_installations",
                {
                    id: i.id,
                    workspace_id: i.workspaceId,
                    account_login: i.accountLogin,
                    account_type: i.accountType,
                    repository_selection: i.repositorySelection,
                    suspended: i.suspended,
                    linked_by: i.linkedBy,
                    linked_at: i.linkedAt,
                },
                ["id"],
            ),
        delete: (id) =>
            this.write(async (sql) => {
                await sql`delete from github_installations where id = ${id}`;
            }),
        deleteAll: () =>
            this.write(async (sql) => {
                await sql`delete from github_installations`;
            }),
    };

    githubState: Repos["githubState"] = {
        get: async (projectId) =>
            (await this.rows((sql) => sql`select state from github_state where project_id = ${projectId}`))[0]?.state ?? null,
        put: (projectId, state) => this.upsert("github_state", { project_id: projectId, state: json(this.sql, state) }, ["project_id"]),
    };

    githubDeliveries: Repos["githubDeliveries"] = {
        add: (d, keep) =>
            this.write(async (sql) => {
                await sql`
                    insert into github_deliveries (workspace_id, project_id, at, event, delivery_id, what, outcome, detail)
                    values (${d.workspaceId}, ${d.projectId}, ${d.at}, ${d.event}, ${d.deliveryId}, ${d.what}, ${d.outcome}, ${d.detail})`;
                await sql`
                    delete from github_deliveries where ${same(sql, "project_id", d.projectId)} and seq not in (
                        select seq from github_deliveries where ${same(sql, "project_id", d.projectId)} order by seq desc limit ${keep})`;
            }),
        list: async (projectId, limit) =>
            (
                await this.rows(
                    (sql) =>
                        sql`select * from github_deliveries where ${same(sql, "project_id", projectId)} order by seq desc limit ${limit}`,
                )
            ).map(toDelivery),
    };

    runners: Repos["runners"] = {
        seen: (r) =>
            this.upsert("runners", { id: r.id, name: r.name, version: r.version, slots: r.slots, last_seen_at: r.lastSeenAt }, ["id"]),
        list: async () => (await this.rows((sql) => sql`select * from runners order by last_seen_at desc`)).map(toRunner),
    };
    instanceSettings: Repos["instanceSettings"] = {
        get: async (key) => (await this.rows((sql) => sql`select value from instance_settings where key = ${key}`))[0]?.value ?? null,
        put: (key, value) => this.upsert("instance_settings", { key, value: json(this.sql, value) }, ["key"]),
    };

    modelGrants: Repos["modelGrants"] = {
        get: async (workspaceId) =>
            first(await this.rows((sql) => sql`select * from model_grants where workspace_id = ${workspaceId}`), toGrant),
        list: async () => (await this.rows((sql) => sql`select * from model_grants order by granted_at, workspace_id`)).map(toGrant),
        put: (g) =>
            this.upsert(
                "model_grants",
                { workspace_id: g.workspaceId, monthly_tokens: g.monthlyTokens, granted_by: g.grantedBy, granted_at: g.grantedAt },
                ["workspace_id"],
            ),
        delete: (workspaceId) =>
            this.write(async (sql) => {
                await sql`delete from model_grants where workspace_id = ${workspaceId}`;
            }),
    };

    invites: Repos["invites"] = {
        get: async (id) => first(await this.rows((sql) => sql`select * from invites where id = ${id}`), toInvite),
        list: async (workspaceId) =>
            (
                await this.rows(
                    (sql) => sql`select * from invites where ${same(sql, "workspace_id", workspaceId)} order by created_at desc, id desc`,
                )
            ).map(toInvite),
        pendingFor: async (email) =>
            (
                await this.rows(
                    (sql) =>
                        sql`select * from invites where email = ${email.toLowerCase()} and accepted_at is null order by created_at, id`,
                )
            ).map(toInvite),
        put: (i) =>
            this.upsert(
                "invites",
                {
                    id: i.id,
                    email: i.email,
                    workspace_id: i.workspaceId,
                    role: i.role,
                    created_by: i.createdBy,
                    created_at: i.createdAt,
                    expires_at: i.expiresAt,
                    accepted_at: i.acceptedAt,
                    accepted_by: i.acceptedBy,
                },
                ["id"],
            ),
        delete: (id) =>
            this.write(async (sql) => {
                await sql`delete from invites where id = ${id}`;
            }),
    };
}
