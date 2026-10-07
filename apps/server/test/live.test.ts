// Live updates with more than one server process: each process relays its notices (and "close these
// streams") through Postgres LISTEN/NOTIFY to the others.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LiveEvent } from "../src/services/events.ts";
import { ADMIN_PASSWORD, postgresStore, sameDatabase, TEST_DATABASE_URL, testApp } from "./helpers.ts";

async function eventually(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!check()) {
        if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}.`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

describe("live updates across server processes", {
    skip: TEST_DATABASE_URL ? false : "set TRIAGENT_TEST_DATABASE_URL to run against Postgres",
}, () => {
    test("a change saved by one process reaches subscribers of another, once; and so does closing their streams", async () => {
        const storeA = await postgresStore();
        const storeB = sameDatabase(storeA);
        const a = await testApp(storeA);
        const b = await testApp(storeB);
        await a.services.events.connect(storeA.relay());
        await b.services.events.connect(storeB.relay());

        // Both processes share the database, so a session started on one works on the other.
        const admin = await a.signIn("admin", ADMIN_PASSWORD);
        assert.equal((await b.request("/api/v1/workspaces", { method: "POST", session: admin, body: { slug: "org" } })).status, 201);
        const workspaceId = (await storeA.workspaces.bySlug("org"))?.id as string;

        const seen: Record<"a" | "b", LiveEvent[]> = { a: [], b: [] };
        const closed: Record<"a" | "b", boolean> = { a: false, b: false };
        for (const [name, app] of [
            ["a", a],
            ["b", b],
        ] as const) {
            app.services.events.subscribe({
                workspaceId,
                userKey: "user:observer",
                permissions: new Set(["read"]),
                send: (e) => seen[name].push(e),
                close: () => {
                    closed[name] = true;
                },
            });
        }

        assert.equal((await b.request("/api/v1/w/org/projects", { method: "POST", session: admin, body: { slug: "app" } })).status, 201);
        assert.equal(seen.b.length, 1, "the process that made the change announces it straight away");
        await eventually(() => seen.a.length === 1, "the other process to hear of it");
        const { seq: _a, ...fromA } = seen.a[0] as LiveEvent;
        const { seq: _b, ...fromB } = seen.b[0] as LiveEvent;
        assert.deepEqual(fromA, fromB);
        // Its own message, coming back through Postgres, isn't delivered a second time.
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(seen.b.length, 1);

        a.services.events.disconnect("user:observer", workspaceId);
        assert.equal(closed.a, true);
        await eventually(() => closed.b, "the other process to close its stream");
    });
});
