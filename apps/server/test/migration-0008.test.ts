// Migration 0008's two data fixes, on rows as earlier versions left them: review history and activity of
// tutorial examples that were removed, and automation settings still holding the old default time limits.

import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate, readMigrations } from "../src/db/migrate.ts";
import { connect } from "../src/store/postgres.ts";
import { TEST_DATABASE_URL } from "./helpers.ts";

const EXAMPLE_PEOPLE = ["Sam Lee (example)", "Priya Shah (example)", "CI uploads (example)", "Open Code Review (example)"];

test("migration 0008 forgets removed examples and old default time limits, and nothing else", {
    skip: TEST_DATABASE_URL ? false : "needs Postgres",
}, async () => {
    const schema = `test_migration8_${Date.now().toString(36)}`;
    const sql = connect(TEST_DATABASE_URL as string, { schema, max: 1 });
    try {
        await migrate(sql, { schema, migrations: readMigrations().filter((m) => m.version < "0008") });
        await sql`insert into workspaces (id, slug, name, kind, created_at) values
                  ('w1', 'sam', 'Sam', 'personal', now()), ('w2', 'acme', 'Acme', 'org', now())`;
        const project = (id: string, ws: string, slug: string, name: string) =>
            sql`insert into projects (id, workspace_id, slug, name, default_branch, webhook_id, created_at)
                values (${id}, ${ws}, ${slug}, ${name}, 'main', ${`hook-${id}`}, now())`;
        await project("live-example", "w1", "example-acme-shop-3", "Example: Acme Shop");
        await project("real", "w1", "app", "App");
        await project("org-app", "w2", "app", "App");

        let n = 0;
        const activity = (ws: string, projectId: string | null, actor: string, kind: string, itemId: string, changes: object) =>
            sql`insert into activity (id, workspace_id, project_id, branch, at, actor, actor_user_id, via, kind, item_id, changes)
                values (${`a${++n}`}, ${ws}, ${projectId}, ${kind === "project" ? null : "main"}, now(), ${actor},
                        ${actor.endsWith("(example)") ? null : "u1"}, 'web', ${kind}, ${itemId}, ${sql.json(changes as never)})`;
        const history = (ws: string, projectId: string | null) =>
            sql`insert into review_history (id, workspace_id, project_id, branch, at, source, kind, status, model, details)
                values (${`r${++n}`}, ${ws}, ${projectId}, 'main', now(), 'run', 'pr', 'done', 'anthropic/claude-sonnet-4.5', '{}')`;
        /** A project as the tutorial makes its example: created by the person, then worked on by made-up people. */
        const example = async (ws: string, id: string, slug: string, name = "Example: Acme Shop") => {
            await activity(ws, id, "Sam", "project", slug, { created: { name } });
            for (const who of EXAMPLE_PEOPLE) await activity(ws, id, who, "issue", "ocr-1", { status: { from: "open", to: "resolved" } });
            // The person tried something out in it themselves.
            await activity(ws, id, "Sam", "issue", "ocr-2", { status: { from: "open", to: "resolved" } });
            await history(ws, id);
            await history(ws, id);
        };
        // Removed examples: the first, and one made while its id was taken.
        await example("w1", "gone-1", "example-acme-shop");
        await example("w1", "gone-2", "example-acme-shop-2");
        // An example that still exists.
        await example("w1", "live-example", "example-acme-shop-3");
        // Removed projects that aren't examples: an ordinary one; one given the example's name and id by a person;
        // one with the made-up people's names in it but another name; and an example's twin in an organisation.
        await activity("w1", "gone-real", "Sam", "project", "old-app", { created: { name: "Old app" } });
        await activity("w1", "gone-real", "Sam", "issue", "ocr-1", { status: { from: "open", to: "resolved" } });
        await history("w1", "gone-real");
        await activity("w1", "gone-lookalike", "Sam", "project", "example-acme-shop", { created: { name: "Example: Acme Shop" } });
        await activity("w1", "gone-lookalike", "Sam", "issue", "ocr-1", { note: "mine" });
        await history("w1", "gone-lookalike");
        await example("w1", "gone-renamed", "example-acme-shop", "Acme Shop");
        await example("w1", "gone-other-id", "acme-shop-example");
        await example("w2", "gone-org", "example-acme-shop");
        // Existing projects, and the workspace's own rows (deleting a project is one).
        await activity("w1", "real", "Sam", "issue", "ocr-1", { status: { from: "open", to: "resolved" } });
        await history("w1", "real");
        await activity("w1", null, "Sam", "project", "example-acme-shop", { deleted: true });
        await history("w1", null);

        const setting = (ws: string, projectId: string | null, key: string, value: object) =>
            sql`insert into settings (workspace_id, project_id, key, value) values (${ws}, ${projectId}, ${key}, ${sql.json(value as never)})`;
        const automation = (review: number, full: number) => ({
            enabled: true,
            pollMinutes: 2,
            maxTokensBudget: null,
            reviewTimeoutMinutes: review,
            fullScanTimeoutMinutes: full,
            models: [],
        });
        await setting("w1", "real", "automation", automation(45, 120));
        await setting("w1", "live-example", "automation", automation(45, 60));
        await setting("w2", "org-app", "automation", automation(30, 120));
        await setting("w1", "real", "other", automation(45, 120));
        await setting("w2", null, "automation", automation(45, 120));

        const counts = async () => {
            const rows = await sql<{ t: string; project_id: string | null; n: number }[]>`
                select 'activity' as t, project_id, count(*)::int as n from activity group by project_id
                union all select 'history', project_id, count(*)::int from review_history group by project_id`;
            return Object.fromEntries(rows.map((r) => [`${r.t}:${r.project_id}`, r.n]).sort());
        };
        const before = await counts();
        assert.equal(before["activity:gone-1"], 6);
        assert.equal(before["history:gone-1"], 2);

        assert.deepEqual(await migrate(sql, { schema }), ["0008_example_analytics_and_time_limits.sql"]);

        const expected = { ...before };
        for (const id of ["gone-1", "gone-2"]) {
            delete expected[`activity:${id}`];
            delete expected[`history:${id}`];
        }
        assert.deepEqual(await counts(), expected);

        const stored = async (ws: string, projectId: string | null, key: string) =>
            (
                await sql`select value from settings where workspace_id = ${ws} and project_id is not distinct from ${projectId} and key = ${key}`
            )[0]?.value;
        assert.deepEqual(await stored("w1", "real", "automation"), {
            ...automation(45, 120),
            reviewTimeoutMinutes: null,
            fullScanTimeoutMinutes: null,
        });
        assert.deepEqual(await stored("w1", "live-example", "automation"), automation(45, 60));
        assert.deepEqual(await stored("w2", "org-app", "automation"), automation(30, 120));
        assert.deepEqual(await stored("w1", "real", "other"), automation(45, 120));
        assert.deepEqual(await stored("w2", null, "automation"), automation(45, 120));
    } finally {
        await sql`drop schema if exists ${sql(schema)} cascade`;
        await sql.end();
    }
});
