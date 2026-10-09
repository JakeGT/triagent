// Apply the SQL files in apps/server/db/migrations, in name order, each once. The server runs this at
// start-up; `node apps/server/src/db/migrate.ts` runs it alone (with DATABASE_URL or DATABASE_URL_FILE set).
//
// Each migration runs in its own transaction holding an advisory lock, so two processes starting together
// apply it once between them, and a failed migration leaves nothing half-applied. A migration that has
// changed since it was applied is refused: add a new one instead.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ISql, Sql } from "postgres";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface Migration {
    version: string;
    name: string;
    sql: string;
    checksum: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): Migration[] {
    const out: Migration[] = [];
    for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith(".sql")) continue;
        const match = FILE.exec(name);
        if (!match) throw new Error(`Migration file names look like 0001_name.sql, got "${name}".`);
        const sql = readFileSync(path.join(dir, name), "utf8");
        // Hashed with LF line endings, so a checkout that converts them (Windows) doesn't look like an edit.
        const checksum = createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
        out.push({ version: match[1] as string, name, sql, checksum });
    }
    const versions = out.map((m) => m.version);
    if (new Set(versions).size !== versions.length) throw new Error("Two migrations share a number.");
    return out;
}

/** Apply pending migrations to the connection's schema (the first on its search_path). Returns the names applied. */
export async function migrate(sql: Sql, { schema, migrations = readMigrations() }: { schema?: string; migrations?: Migration[] } = {}) {
    // The lock is per schema, so separate schemas in one database (tests, say) don't wait for each other.
    const lock = async (tx: ISql) => {
        await (schema
            ? tx`select pg_advisory_xact_lock(hashtextextended(${`triagent-migrations:${schema}`}, 0))`
            : tx`select pg_advisory_xact_lock(hashtextextended('triagent-migrations:' || current_schema(), 0))`);
    };
    await sql.begin(async (tx) => {
        await lock(tx);
        // Checked first: creating it (even "if not exists") needs a privilege an existing schema's owner may lack.
        if (schema && !(await tx`select 1 from pg_namespace where nspname = ${schema}`).length) await tx`create schema ${tx(schema)}`;
        await tx`
            create table if not exists schema_migrations (
                version    text primary key,
                name       text not null,
                checksum   text not null,
                applied_at timestamptz not null default now()
            )`;
    });
    const applied: string[] = [];
    for (const m of migrations) {
        await sql.begin(async (tx) => {
            await lock(tx);
            const [done] = await tx<{ checksum: string }[]>`select checksum from schema_migrations where version = ${m.version}`;
            if (done) {
                if (done.checksum !== m.checksum)
                    throw new Error(`Migration ${m.name} has changed since it was applied. Put the change in a new migration.`);
                return;
            }
            await tx.unsafe(m.sql).simple();
            await tx`insert into schema_migrations (version, name, checksum) values (${m.version}, ${m.name}, ${m.checksum})`;
            applied.push(m.name);
        });
    }
    return applied;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { ConfigError, secretFromEnv } = await import("../config.ts");
    const { connect } = await import("../store/postgres.ts");
    try {
        const url = secretFromEnv(process.env, "DATABASE_URL");
        if (!url) throw new ConfigError("Set DATABASE_URL (or DATABASE_URL_FILE) to the database to migrate.");
        const schema = process.env.DATABASE_SCHEMA || undefined;
        const sql = connect(url, { schema, max: 1 });
        try {
            const applied = await migrate(sql, { schema });
            console.log(applied.length ? `Applied ${applied.join(", ")}.` : "The database is up to date.");
        } finally {
            await sql.end();
        }
    } catch (err) {
        console.error(`Migration failed: ${(err as Error).message}`);
        process.exitCode = 1;
    }
}
