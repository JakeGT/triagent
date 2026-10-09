// The first-run tutorial: each person's place in it, and their example project, made once and only in
// their own personal workspace, from made-up data that never reaches GitHub, a runner or a model.

import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate, readMigrations } from "../src/db/migrate.ts";
import type { Services } from "../src/services/index.ts";
import { EXAMPLE_BRANCH, EXAMPLE_ISSUE_PATH, EXAMPLE_NAME, EXAMPLE_SLUG } from "../src/services/tutorial-example.ts";
import { connect } from "../src/store/postgres.ts";
import { ADMIN_PASSWORD, report, type Session, TEST_DATABASE_URL, type TestApp, testApp } from "./helpers.ts";

const PASSWORD = "a-long-tutorial-password";

/** A local account that has chosen its own password, signed in. */
async function person(t: TestApp, admin: Session, username: string): Promise<Session> {
    const created = await t.request("/api/v1/instance/users", { method: "POST", session: admin, body: { username } });
    assert.equal(created.status, 201);
    const s = await t.signIn(username, created.body.password);
    assert.equal(
        (
            await t.request("/api/v1/me/password", {
                method: "POST",
                session: s,
                body: { current: created.body.password, password: PASSWORD },
            })
        ).status,
        200,
    );
    return t.signIn(username, PASSWORD);
}

/** GitHub, automatic reviews, starting or running a review, and the network all fail the test if they're used. */
function forbidOutside(services: Services): string[] {
    const calls: string[] = [];
    const forbid = (name: string, target: object, keys: string[]) => {
        for (const key of keys)
            (target as Record<string, unknown>)[key] = () => {
                calls.push(`${name}.${key}`);
                throw new Error(`${name}.${key} was called`);
            };
    };
    const methods = (target: object) =>
        Object.getOwnPropertyNames(Object.getPrototypeOf(target)).filter(
            (k) => k !== "constructor" && typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), k)?.value === "function",
        );
    forbid("github", services.github, methods(services.github));
    forbid("automation", services.automation, methods(services.automation));
    forbid("runs", services.runs, ["start", "enqueue", "cancel", "claim", "heartbeat", "events", "finish", "background"]);
    const fetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
        calls.push(`fetch ${String(input)}`);
        throw new Error("the network was used");
    }) as typeof fetch;
    test.after(() => {
        globalThis.fetch = fetch;
    });
    return calls;
}

test("new accounts start the tutorial pending, or done when the instance turns it off", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    assert.deepEqual((await t.request("/api/v1/me", { session: admin })).body.tutorial, {
        status: "pending",
        step: 0,
        example: null,
        setup: "pending",
    });
    const sam = await person(t, admin, "sam");
    assert.deepEqual((await t.request("/api/v1/me/tutorial", { session: sam })).body, {
        status: "pending",
        step: 0,
        example: null,
        setup: "pending",
    });

    const off = await testApp(undefined, { env: { TUTORIAL_AUTO_START: "false" } });
    const offAdmin = await off.signIn("admin", ADMIN_PASSWORD);
    assert.equal((await off.request("/api/v1/me/tutorial", { session: offAdmin })).body.status, "completed");
    assert.equal((await off.request("/api/v1/me/tutorial", { session: offAdmin })).body.setup, "done");
});

test("account setup is offered until it's done", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const patch = (body: unknown) => t.request("/api/v1/me/tutorial", { method: "PATCH", session: admin, body });
    assert.equal((await patch({ setup: "done" })).body.setup, "done");
    assert.equal((await t.request("/api/v1/me", { session: admin })).body.tutorial.setup, "done");
    assert.equal((await patch({ setup: "pending" })).body.setup, "pending");
    assert.equal((await patch({ setup: "dismissed" })).status, 400);
    // Accounts made before account setup existed have no record of it: they're offered it.
    const user = await t.services.store.users.byUsername("admin");
    if (user) await t.services.store.users.put({ ...user, tutorial: { status: "completed", step: 0, exampleProject: null } });
    assert.equal((await t.request("/api/v1/me", { session: admin })).body.tutorial.setup, "pending");
});

test("the tutorial moves through its states and remembers its step", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const patch = (body: unknown) => t.request("/api/v1/me/tutorial", { method: "PATCH", session: admin, body });

    assert.deepEqual((await patch({ status: "in_progress", step: 0 })).body, {
        status: "in_progress",
        step: 0,
        example: null,
        setup: "pending",
    });
    assert.equal((await patch({ step: 4 })).body.step, 4);
    // Closing the browser mid-tour: the next visit finds the same step.
    const again = await t.signIn("admin", ADMIN_PASSWORD);
    assert.deepEqual((await t.request("/api/v1/me", { session: again })).body.tutorial, {
        status: "in_progress",
        step: 4,
        example: null,
        setup: "pending",
    });
    assert.equal((await patch({ status: "dismissed" })).body.status, "dismissed");
    // Shown again from Settings, then finished.
    assert.deepEqual((await patch({ status: "in_progress", step: 0 })).body, {
        status: "in_progress",
        step: 0,
        example: null,
        setup: "pending",
    });
    assert.equal((await patch({ status: "completed", step: 13 })).body.status, "completed");

    for (const bad of [{}, { status: "done" }, { step: -1 }, { step: 51 }, { step: 1.5 }])
        assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));
});

test("the tutorial is the person's own, in the browser only", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const token = (
        await t.request("/api/v1/w/admin/settings/tokens", { method: "POST", session: admin, body: { name: "t", scope: "manage" } })
    ).body.token;
    for (const [method, path] of [
        ["GET", "/api/v1/me/tutorial"],
        ["PATCH", "/api/v1/me/tutorial"],
        ["POST", "/api/v1/me/tutorial/example"],
        ["DELETE", "/api/v1/me/tutorial/example"],
    ] as const) {
        const res = await t.request(path, { method, token, body: method === "GET" ? undefined : { status: "completed" } });
        assert.ok([401, 403].includes(res.status), `${method} ${path} with a token answered ${res.status}`);
        assert.equal(
            (await t.request(path, { method, body: method === "GET" ? undefined : {} })).status,
            401,
            `${method} ${path} signed out`,
        );
    }
    for (const r of t.routes.filter((x) => x.path.startsWith("/api/v1/me/tutorial"))) {
        assert.equal(r.scope, "user");
        assert.equal(r.browserOnly, true);
    }
});

test("the example project is made once, in the personal workspace, from made-up data that reaches nothing outside", async () => {
    const t = await testApp();
    const calls = forbidOutside(t.services);
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    // An organisation the person belongs to: the example never goes there.
    assert.equal((await t.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "acme" } })).status, 201);

    const created = await t.request("/api/v1/me/tutorial/example", { method: "POST", session: admin });
    assert.equal(created.status, 201, created.text);
    const example = created.body.example;
    assert.equal(example.workspace, "admin");
    assert.equal(example.project, EXAMPLE_SLUG);
    assert.equal(example.name, EXAMPLE_NAME);
    assert.match(example.issue, /^ocr-/);
    // Asking again returns the same project.
    const second = await t.request("/api/v1/me/tutorial/example", { method: "POST", session: admin });
    assert.deepEqual(second.body.example, example);
    const personal = (await t.request("/api/v1/w/admin/projects", { session: admin })).body.items;
    assert.deepEqual(
        personal.map((p: { slug: string }) => p.slug),
        [EXAMPLE_SLUG],
    );
    assert.deepEqual((await t.request("/api/v1/w/acme/projects", { session: admin })).body.items, []);

    const base = `/api/v1/w/admin/p/${EXAMPLE_SLUG}`;
    const issues = (await t.request(`${base}/issues?branch=main&limit=100`, { session: admin })).body;
    assert.equal(issues.total, 15);
    assert.ok(issues.counts.severity.critical >= 2 && issues.counts.severity.low >= 3);
    const byStatus = (s: string) => issues.items.filter((x: { status: string }) => x.status === s).length;
    assert.equal(byStatus("resolved"), 1);
    // One won't fix, and the duplicate (filed as won't fix).
    assert.equal(byStatus("wont_fix"), 2);
    assert.equal(byStatus("in_progress"), 1);
    const shown = (await t.request(`${base}/issues/${example.issue}?branch=main`, { session: admin })).body;
    assert.equal(shown.path, EXAMPLE_ISSUE_PATH);
    assert.equal(shown.severity, "high");
    assert.equal(shown.reviewerSeverity, "low");
    assert.ok(shown.existingCode && shown.suggestionCode);
    assert.equal(shown.notes.length, 1);
    assert.equal(issues.items.filter((x: { duplicateOf: string | null }) => x.duplicateOf).length, 1);
    assert.equal(issues.items.filter((x: { needsDiscussion: boolean }) => x.needsDiscussion).length, 1);
    assert.ok((await t.request(`${base}/tasks?branch=main`, { session: admin })).body.items.length >= 5);
    const compare = (await t.request(`${base}/compare?base=main&head=${encodeURIComponent(EXAMPLE_BRANCH)}`, { session: admin })).body;
    assert.ok(compare.added.total >= 2 && compare.gone.total >= 10);

    // Review history: a pull request run, an upload and a partial run.
    const history = await t.services.history.list({ workspaceId: (await t.services.store.workspaces.bySlug("admin"))?.id as string });
    assert.deepEqual(history.map((h) => `${h.source} ${h.kind} ${h.status}`).sort(), [
        "run full partial",
        "run pr done",
        "upload upload done",
    ]);
    // Two finished runs, marked as examples; nothing queued or running.
    const runs = (await t.request("/api/v1/w/admin/runs", { session: admin })).body;
    assert.equal(runs.running.length + runs.queued.length, 0);
    assert.deepEqual(runs.recent.map((r: { status: string }) => r.status).sort(), ["done", "partial"]);
    for (const r of runs.recent) {
        assert.match(r.title, /^Example: /);
        assert.equal(r.result.example, true);
    }
    assert.deepEqual(calls, []);
});

test("the example lands in each person's own personal workspace, beside their projects, and only it is removed", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const sam = await person(t, admin, "sam");
    // Sam already has a project with the example's id: theirs is kept, and the example takes another.
    assert.equal((await t.request("/api/v1/w/sam/projects", { method: "POST", session: sam, body: { slug: EXAMPLE_SLUG } })).status, 201);
    await t.request(`/api/v1/w/sam/p/${EXAMPLE_SLUG}/reports`, { method: "POST", session: sam, body: { report: report("src/mine.ts") } });

    const made = (await t.request("/api/v1/me/tutorial/example", { method: "POST", session: sam })).body.example;
    assert.equal(made.workspace, "sam");
    assert.equal(made.project, `${EXAMPLE_SLUG}-2`);
    const mine = (await t.request("/api/v1/me/tutorial/example", { method: "POST", session: admin })).body.example;
    assert.equal(mine.workspace, "admin");
    // Nobody's example appears anywhere else.
    assert.equal((await t.request(`/api/v1/w/sam/p/${EXAMPLE_SLUG}-2`, { session: admin })).status, 404);

    const removed = await t.request("/api/v1/me/tutorial/example", { method: "DELETE", session: sam });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.example, null);
    const left = (await t.request("/api/v1/w/sam/projects", { session: sam })).body.items.map((p: { slug: string }) => p.slug);
    assert.deepEqual(left, [EXAMPLE_SLUG]);
    const samWs = (await t.services.store.workspaces.bySlug("sam"))?.id as string;
    assert.equal((await t.services.history.list({ workspaceId: samWs })).filter((h) => h.source === "run").length, 0);
    assert.equal((await t.services.history.list({ workspaceId: samWs })).length, 1, "Sam's own upload is still counted");
    // The admin's example is untouched, and removing again does nothing.
    assert.equal((await t.request(`/api/v1/w/admin/p/${EXAMPLE_SLUG}`, { session: admin })).status, 200);
    assert.equal((await t.request("/api/v1/me/tutorial/example", { method: "DELETE", session: sam })).status, 200);

    // Shown again: a new example.
    const again = (await t.request("/api/v1/me/tutorial/example", { method: "POST", session: sam })).body.example;
    assert.equal(again.workspace, "sam");
    assert.notEqual(again.project, EXAMPLE_SLUG);
});

test("an example deleted as a project is forgotten: a real project later given its id is never removed as the example", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const made = (await t.request("/api/v1/me/tutorial/example", { method: "POST", session: admin })).body.example;
    const base = `/api/v1/w/admin/p/${made.project}`;
    assert.equal((await t.request(base, { method: "DELETE", session: admin, body: { confirm: made.project } })).status, 200);
    assert.equal(
        (await t.request("/api/v1/w/admin/projects", { method: "POST", session: admin, body: { slug: made.project } })).status,
        201,
    );
    assert.equal((await t.request("/api/v1/me/tutorial", { session: admin })).body.example, null);
    assert.equal((await t.request("/api/v1/me/tutorial/example", { method: "DELETE", session: admin })).status, 200);
    assert.equal((await t.request(base, { session: admin })).status, 200, "the real project is still there");
});

test("removing the example, either way, leaves the analytics as they were before it was made", async () => {
    // A clock that stands still, so two readings of the analytics cover the same range.
    const at = new Date();
    const t = await testApp(undefined, { now: () => at });
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    // A project of their own, with a review and some triage: none of it changes.
    assert.equal((await t.request("/api/v1/w/admin/projects", { method: "POST", session: admin, body: { slug: "mine" } })).status, 201);
    await t.request("/api/v1/w/admin/p/mine/reports", {
        method: "POST",
        session: admin,
        body: { report: report("src/mine.ts", "src/b.ts") },
    });
    const issue = (await t.request("/api/v1/w/admin/p/mine/issues?branch=main", { session: admin })).body.items[0];
    await t.request(`/api/v1/w/admin/p/mine/issues/${issue.id}?branch=main`, {
        method: "PATCH",
        session: admin,
        body: { status: "resolved" },
    });

    const workspaceId = (await t.services.store.workspaces.bySlug("admin"))?.id as string;
    const analytics = async () => {
        const all = await Promise.all(
            ["7", "30", "0"].map(async (days) => {
                const res = await t.request(`/api/v1/w/admin/analytics?days=${days}`, { session: admin });
                assert.equal(res.status, 200, res.text);
                return res.body;
            }),
        );
        return JSON.stringify(all);
    };
    const stored = async () => ({
        history: (await t.services.store.reviewHistory.list({ workspaceId }, 1000)).map((r) => r.id).sort(),
        // Deleting a project is itself recorded, by the person who did it: nothing of the example's is.
        activity: (await t.services.store.activity.list({ workspaceId }, { limit: 1000 }))
            .filter((r) => !(r.kind === "project" && r.projectId === null && "deleted" in r.changes))
            .map((r) => r.id)
            .sort(),
    });
    const before = { analytics: await analytics(), stored: await stored() };

    const remove = {
        "from the tutorial": () => t.request("/api/v1/me/tutorial/example", { method: "DELETE", session: admin }),
        "as a project": (slug: string) =>
            t.request(`/api/v1/w/admin/p/${slug}`, { method: "DELETE", session: admin, body: { confirm: slug } }),
    };
    for (const [how, run] of Object.entries(remove)) {
        const made = (await t.request("/api/v1/me/tutorial/example", { method: "POST", session: admin })).body.example;
        const withExample = await analytics();
        assert.notEqual(withExample, before.analytics, "the example shows in the analytics while it exists");
        assert.match(withExample, /\(example\)/);
        assert.equal((await run(made.project)).status, 200, how);
        assert.equal(await analytics(), before.analytics, `removed ${how}`);
        assert.deepEqual(await stored(), before.stored, `removed ${how}`);
        const everyone = await t.services.store.activity.list({ workspaceId }, { limit: 1000 });
        assert.ok(!everyone.some((r) => r.actor.includes("(example)")), `removed ${how}: no made-up people are left in the activity log`);
    }
});

test("two requests at once make one example", async () => {
    const t = await testApp();
    const admin = await t.signIn("admin", ADMIN_PASSWORD);
    const [a, b] = await Promise.all([
        t.request("/api/v1/me/tutorial/example", { method: "POST", session: admin }),
        t.request("/api/v1/me/tutorial/example", { method: "POST", session: admin }),
    ]);
    assert.equal(a.status, 201, a.text);
    assert.equal(b.status, 201, b.text);
    assert.deepEqual(a.body.example, b.body.example);
    assert.equal((await t.request("/api/v1/w/admin/projects", { session: admin })).body.items.length, 1);
});

test("accounts made before the tutorial existed start it once", { skip: TEST_DATABASE_URL ? false : "needs Postgres" }, async () => {
    const schema = `test_tutorial_${Date.now().toString(36)}`;
    const sql = connect(TEST_DATABASE_URL as string, { schema, max: 1 });
    try {
        await migrate(sql, { schema, migrations: readMigrations().filter((m) => m.version < "0007") });
        await sql`insert into users (id, username, display_name, must_change_password, is_instance_admin, notify, created_at)
                  values ('u1', 'old', 'Old', false, false, '{"scope": "mine", "problemsOnly": false}', now())`;
        await migrate(sql, { schema });
        const [row] = await sql`select tutorial from users where id = 'u1'`;
        assert.deepEqual(row?.tutorial, { status: "pending", step: 0, exampleProject: null });
    } finally {
        await sql`drop schema if exists ${sql(schema)} cascade`;
        await sql.end();
    }
});
