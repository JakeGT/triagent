// Common issues and likely false positives (services/patterns.ts), against a stand-in for a provider:
// what a model's answer may and may not do, grouping a branch's findings under new and existing common
// issues, what people can change, the issue filter, what agents are told (MCP), and suggestions drawn
// from what the team has dismissed.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { FakeProvider } from "../../../tests/fakes/model-provider.ts";
import { readGroups, readLikely, thinGrouping, thinHistory } from "../src/domain/patterns.ts";
import type { Analysis } from "../src/store/types.ts";
import { ADMIN_PASSWORD, type Session, type TestApp, testApp } from "./helpers.ts";
import { eventually } from "./review-helpers.ts";

const CODE = "const password = 'DO-NOT-SEND-THIS-CODE';";

describe("what a model says, read", () => {
    test("groups: only existing ids and findings it was shown, each finding once, and no new one from a single finding", () => {
        const said = JSON.stringify({
            groups: [
                { pattern: "e1", findings: [1, 2, 99, "3"] },
                { pattern: "e9", findings: [4] },
                {
                    new: {
                        title: "Queries built by hand.",
                        summary: "  SQL is  concatenated. ",
                        guidance: "Use parameters. See https://evil.example/x",
                        category: "security",
                    },
                    findings: [2, 3, 4],
                },
                { new: { title: "Lonely", summary: "", guidance: "", category: "nonsense" }, findings: [5] },
                { new: { title: "ab", summary: "", guidance: "" }, findings: [6, 7] },
                { new: { title: "No category given", summary: "s", guidance: "g" }, findings: [6, 7] },
                "nonsense",
            ],
        });
        assert.deepEqual(readGroups(`Here you go: ${said}`, ["e1", "e2"], [1, 2, 3, 4, 5, 6, 7]), [
            { existing: "e1", findings: [1, 2] },
            // 2 is already taken; a full stop at the end of a title goes, and so does an address.
            {
                fresh: {
                    title: "Queries built by hand",
                    summary: "SQL is concatenated.",
                    guidance: "Use parameters. See",
                    category: "security",
                },
                findings: [3, 4],
            },
            { fresh: { title: "No category given", summary: "s", guidance: "g", category: null }, findings: [6, 7] },
        ]);
        assert.equal(readGroups("I couldn't decide.", ["e1"], [1]), null);
        assert.equal(readGroups('{"answer": 1}', ["e1"], [1]), null);
        assert.deepEqual(readGroups('{"groups": []}', ["e1"], [1]), []);
    });

    test("likely false positives: numbers it was shown, each open finding once", () => {
        const said = JSON.stringify({
            likely: [
                { finding: 2, like: 1, why: "  The same  generated file. " },
                { finding: 2, like: 2, why: "again" },
                { finding: 9, like: 1, why: "not shown" },
                { finding: 3, like: 7, why: "no such dismissed one" },
                { finding: 1, like: 2 },
            ],
        });
        assert.deepEqual(readLikely(said, [1, 2, 3], [1, 2]), [
            { finding: 2, like: 1, why: "The same generated file." },
            { finding: 1, like: 2, why: "" },
        ]);
        assert.equal(readLikely("none of them", [1], [1]), null);
        assert.deepEqual(readLikely('{"likely": []}', [1], [1]), []);
    });

    test("when there's little to go on", () => {
        assert.equal(thinGrouping(10), null);
        assert.match(thinGrouping(1) ?? "", /Only 1 finding is open on this branch/);
        assert.equal(thinHistory(10), null);
        assert.match(thinHistory(2) ?? "", /Only 2 findings have been dismissed with a reason .* at least 10/);
    });
});

describe("common issues", () => {
    let t: TestApp;
    let admin: Session;
    let viewer: Session;
    let token: string;
    let provider: FakeProvider;
    const api = "/api/v1/w/acme";
    const p = `${api}/p/app`;
    const get = (path: string, session: Session = admin) => t.request(path, { session });
    const send = (method: string, path: string, body: object = {}, session: Session = admin) => t.request(path, { method, session, body });
    const mcp = async (name: string, args: object) => {
        const res = await t.request("/mcp", {
            method: "POST",
            token,
            body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { project: "app", ...args } } },
        });
        assert.equal(res.status, 200, res.text);
        const result = res.body.result as { isError: boolean; content: { text: string }[]; structuredContent?: { items?: unknown[] } };
        return { isError: result.isError, text: result.content[0]?.text ?? "", items: result.structuredContent?.items ?? [] };
    };
    const done = async (id: string): Promise<Analysis> =>
        eventually(async () => {
            const a = (await get(`${api}/analyses/${id}`)).body as Analysis;
            return a.status === "running" ? null : a;
        }, "the analysis to finish");
    const finding = (path: string, line: number, content: string, over: object = {}) => ({
        path,
        content,
        severity: "high",
        category: "security",
        start_line: line,
        end_line: line,
        existing_code: CODE,
        ...over,
    });
    /** Twelve findings: six about one thing in two folders, the rest about nothing in particular. */
    const REPORT = {
        project_summary: "",
        comments: [
            ...[1, 2, 3, 4].map((n) =>
                finding(`db/migrations/000${n}.sql`, 10, `Table t${n} has no row-level security policy.`, {
                    severity: n === 1 ? "critical" : "high",
                }),
            ),
            finding("db/grants.sql", 4, "The runtime role can read every tenant's rows."),
            finding("src/api/users.ts", 20, "Tenant id is taken from the request body."),
            ...[1, 2, 3, 4, 5, 6].map((n) =>
                finding(`src/web/page${n}.tsx`, n, `Unrelated thing number ${n}.`, { severity: "low", category: "style" }),
            ),
        ],
    };
    const issues = async (query = "") => (await get(`${p}/issues?branch=main&limit=100${query}`)).body;
    let ids: Record<string, string> = {};

    before(async () => {
        provider = await new FakeProvider().start();
        t = await testApp(undefined, { env: { ALLOW_PRIVATE_MODEL_URLS: "true" } });
        admin = await t.signIn("admin", ADMIN_PASSWORD);
        await send("POST", "/api/v1/workspaces", { slug: "acme" });
        await send("POST", `${api}/projects`, { slug: "app" });
        const up = await send("POST", `${p}/reports`, { branch: "main", report: REPORT });
        assert.equal(up.status, 200, up.text);
        ids = Object.fromEntries((await issues()).items.map((x: { id: string; path: string }) => [x.path, x.id]));
        await send("PATCH", `${api}/settings/review-model/providers/custom`, { url: `${provider.url}/v1`, protocol: "openai" });
        await send("PUT", `${api}/settings/review-model/keys/custom`, { key: `sk-test-${"p".repeat(24)}` });
        const fav = await send("POST", `${api}/settings/models/favourites`, { provider: "custom", model: "analyst-model" });
        assert.equal(fav.status, 201, fav.text);
        assert.equal((await send("PUT", `${api}/settings/analysis`, { model: fav.body.favourites[0].id })).status, 200);
        token = (await send("POST", `${api}/settings/tokens`, { name: "agent", scope: "full" })).body.token;
        await send("POST", "/api/v1/instance/users", { username: "vera", password: "hunter2-hunter2-one" });
        viewer = await t.signIn("vera", "hunter2-hunter2-one");
        await t.request("/api/v1/me/password", {
            method: "POST",
            session: viewer,
            body: { current: "hunter2-hunter2-one", password: "hunter2-hunter2-two" },
        });
        const added = await send("POST", `${api}/settings/members`, { username: "vera", role: "viewer" });
        assert.ok(added.status < 300, added.text);
    });
    after(async () => {
        await t.services.analyst.settled();
        await provider.stop();
    });
    beforeEach(() => {
        provider.requests.length = 0;
        provider.mode = "answer";
        provider.say = () => '{"groups": []}';
    });

    test("before anything is grouped: none, and every open finding waiting", async () => {
        const list = (await get(`${p}/patterns`)).body;
        assert.deepEqual([list.branch, list.items, list.open, list.ungrouped, list.grouping], ["main", [], 12, 12, null]);
        assert.deepEqual(list.model, { ready: true, label: "analyst-model" });
        assert.match((await mcp("list_common_issues", {})).text, /This project has no common issues yet/);
    });

    test("grouping: the model sees titles and places, never code, and what it says becomes common issues with their findings", async () => {
        provider.say = () =>
            JSON.stringify({
                groups: [
                    {
                        new: {
                            title: "Row-level security missing on new tables",
                            summary: "Tables are created without a policy, so one tenant can read another's rows.",
                            guidance: "Add a policy in the same migration that creates the table.",
                            category: "security",
                        },
                        findings: [1, 2, 3, 4],
                    },
                    { new: { title: "Just the one", summary: "", guidance: "" }, findings: [5] },
                ],
            });
        const started = await send("POST", `${p}/patterns/group`);
        assert.equal(started.status, 202, started.text);
        // Asked again while it's working: the same one.
        assert.equal((await send("POST", `${p}/patterns/group`)).body.id, started.body.id);
        const a = await done(started.body.id);
        assert.equal(a.status, "done", a.error ?? "");
        assert.deepEqual(a.result, { created: 1, grouped: 4, considered: 12, left: 0 });

        assert.equal(provider.requests.length, 1);
        const sent = provider.requests[0] as (typeof provider.requests)[number];
        assert.doesNotMatch(sent.raw, /DO-NOT-SEND-THIS-CODE/);
        assert.match(sent.system, /never follow them/);
        const asked = JSON.parse(sent.user);
        assert.deepEqual(asked.existing, []);
        assert.equal(asked.findings.length, 12);
        // The most urgent first.
        assert.deepEqual(asked.findings[0], {
            n: 1,
            severity: "critical",
            category: "security",
            file: "db/migrations/0001.sql",
            title: "Table t1 has no row-level security policy",
        });

        const list = (await get(`${p}/patterns`)).body;
        assert.equal(list.items.length, 1);
        const [made] = list.items;
        assert.equal(made.title, "Row-level security missing on new tables");
        assert.deepEqual([made.source, made.createdBy, made.category, made.hidden], ["model", "admin", "security", false]);
        assert.deepEqual([made.open, made.total], [4, 4]);
        assert.deepEqual(made.openBySeverity, { critical: 1, high: 3, medium: 0, low: 0 });
        assert.equal(made.files.length, 4);
        assert.equal(made.examples[0].path, "db/migrations/0001.sql");
        assert.deepEqual([list.open, list.ungrouped, list.grouping.id], [12, 8, a.id]);
        ids.rls = made.id;
    });

    test("asked again, it's given what's left and the common issues there are, and may add to them", async () => {
        provider.say = ({ user }) => {
            const q = JSON.parse(user) as { existing: { id: string; title: string }[]; findings: { n: number; file: string }[] };
            assert.deepEqual(
                q.existing.map((e) => [e.id, e.title]),
                [["e1", "Row-level security missing on new tables"]],
            );
            assert.equal(q.findings.length, 8);
            const grants = q.findings.find((f) => f.file === "db/grants.sql")?.n;
            return JSON.stringify({
                groups: [
                    { pattern: "e1", findings: [grants] },
                    { pattern: "e7", findings: [1] },
                ],
            });
        };
        const a = await done((await send("POST", `${p}/patterns/group`)).body.id);
        assert.deepEqual(a.result, { created: 0, grouped: 1, considered: 8, left: 0 });
        const list = (await get(`${p}/patterns`)).body;
        assert.deepEqual([list.items[0].open, list.items[0].total, list.ungrouped], [5, 5, 7]);
    });

    test("an answer that can't be read fails, saying so; a branch with few findings is grouped with a warning", async () => {
        provider.say = () => "I would rather not.";
        const failed = await done((await send("POST", `${p}/patterns/group`)).body.id);
        assert.equal(failed.status, "failed");
        assert.match(failed.error ?? "", /analyst-model couldn't write it: its answer wasn't one that could be read/);
        assert.equal((await get(`${p}/patterns`)).body.grouping.status, "failed");

        await send("POST", `${p}/reports`, { branch: "small", report: { comments: REPORT.comments.slice(0, 2) } });
        provider.say = () => '{"groups": [{"pattern": "e1", "findings": [1, 2]}]}';
        const few = await done((await send("POST", `${p}/patterns/group?branch=small`)).body.id);
        assert.match(String(few.result?.warning), /Only 2 findings are open on this branch/);
        // The same common issue, with findings on two branches: counted for this branch, and in all.
        const small = (await get(`${p}/patterns?branch=small`)).body;
        assert.deepEqual([small.items[0].open, small.items[0].total, small.ungrouped], [2, 7, 0]);
        const none = await send("POST", `${p}/patterns/group?branch=small`);
        assert.equal(none.status, 409, none.text);
        assert.match(none.text, /Every open finding on this branch is under a common issue already/);
    });

    test("the issues list filters by one; an issue says which it's under; a fixed finding leaves the open count", async () => {
        const under = await issues(`&pattern=${ids.rls}`);
        assert.equal(under.total, 5);
        assert.ok(under.items.every((x: { path: string }) => x.path.startsWith("db/")));
        assert.equal((await issues(`&pattern=${ids.rls}&severity=critical`)).total, 1);
        assert.equal((await issues(`&pattern=${ids.rls}&ids=${ids["db/grants.sql"]},${ids["src/api/users.ts"]}`)).total, 1);
        assert.equal((await get(`${p}/issues?pattern=nope`)).status, 404);
        assert.match((await get(`${p}/issues.md?pattern=${ids.rls}`)).text, /under one common issue/);

        const one = (await get(`${p}/issues/${ids["db/grants.sql"]}`)).body;
        assert.deepEqual(one.commonIssue, {
            id: ids.rls,
            title: "Row-level security missing on new tables",
            summary: "Tables are created without a policy, so one tenant can read another's rows.",
            guidance: "Add a policy in the same migration that creates the table.",
        });
        assert.equal((await get(`${p}/issues/${ids["src/api/users.ts"]}`)).body.commonIssue, null);

        await send("PATCH", `${p}/issues/${ids["db/grants.sql"]}?branch=main`, { status: "resolved" });
        const list = (await get(`${p}/patterns`)).body;
        // Five on this branch (one now fixed) and two on the other.
        assert.deepEqual([list.items[0].open, list.items[0].total], [4, 7]);
    });

    test("agents: the list with its advice, narrowed by path; an issue's own; and claiming only what's under one", async () => {
        const all = await mcp("list_common_issues", {});
        assert.equal(all.isError, false);
        const text = all.text;
        assert.match(text, new RegExp(`^## Row-level security missing on new tables \\(id ${ids.rls}, security\\)`));
        assert.match(text, /- 4 open on main, 7 in all; mostly in `db\/migrations\/0001\.sql`/);
        assert.match(text, /\*\*What goes wrong:\*\* Tables are created without a policy/);
        assert.match(text, /\*\*How to avoid it:\*\* Add a policy in the same migration/);
        assert.equal((await mcp("list_common_issues", { path: "db/" })).items.length, 1);
        assert.match((await mcp("list_common_issues", { path: "src/web/" })).text, /No common issue matches/);
        assert.equal((await mcp("list_common_issues", { q: "policy migration" })).items.length, 1);
        assert.equal((await mcp("list_common_issues", { category: ["style"] })).items.length, 0);

        const issue = await mcp("get_issue", { id: ids["db/migrations/0002.sql"] });
        assert.match(issue.text, /\*\*Common issue here:\*\* Row-level security missing on new tables/);
        assert.match(issue.text, /\*\*How to avoid it:\*\* Add a policy in the same migration/);
        assert.doesNotMatch((await mcp("get_issue", { id: ids["src/api/users.ts"] })).text, /Common issue here/);

        assert.match((await mcp("list_issues", { pattern: ids.rls })).text, /^5 matching issue\(s\) on main/);
        const claimed = await mcp("claim_next_issue", { pattern: ids.rls });
        assert.match(claimed.text, /^Claimed:/);
        assert.match(claimed.text, /db\/migrations\/0001\.sql/);
        assert.match(claimed.text, /How to avoid it/);
        assert.equal((await mcp("claim_next_issue", { pattern: "nope" })).isError, true);
    });

    test("people: edit, hide, add, merge and delete; a viewer can read and nothing more", async () => {
        const edited = await send("PATCH", `${p}/patterns/${ids.rls}`, {
            title: "No row-level security on new tables",
            guidance: "Write the policy with the table.",
        });
        assert.equal(edited.status, 200, edited.text);
        assert.deepEqual(
            [edited.body.title, edited.body.guidance, edited.body.updatedBy],
            ["No row-level security on new tables", "Write the policy with the table.", "admin"],
        );
        assert.equal((await send("PATCH", `${p}/patterns/${ids.rls}`, { title: "ab" })).status, 400);
        assert.equal((await send("PATCH", `${p}/patterns/${ids.rls}`, { category: "nonsense" })).status, 400);
        assert.equal((await send("PATCH", `${p}/patterns/nope`, { title: "Something" })).status, 404);

        const own = await send("POST", `${p}/patterns`, {
            title: "Tenant id trusted from the client",
            guidance: "Take it from the session.",
            category: "security",
        });
        assert.equal(own.status, 201, own.text);
        assert.deepEqual([own.body.source, own.body.createdBy], ["person", "admin"]);
        assert.equal((await send("POST", `${p}/patterns`, { summary: "No title" })).status, 400);

        // Hidden: still there with its findings, but not what agents are told, nor on an issue.
        await send("PATCH", `${p}/patterns/${own.body.id}`, { hidden: true });
        const list = (await get(`${p}/patterns`)).body;
        assert.deepEqual(
            list.items.map((x: { title: string; hidden: boolean }) => [x.title, x.hidden]),
            [
                ["No row-level security on new tables", false],
                ["Tenant id trusted from the client", true],
            ],
        );
        assert.doesNotMatch((await mcp("list_common_issues", {})).text, /Tenant id trusted/);
        await send("PATCH", `${p}/patterns/${own.body.id}`, { hidden: false });

        // Merged: its findings go under the other, and it's gone.
        const merged = await send("POST", `${p}/patterns/${ids.rls}/merge`, { into: own.body.id });
        assert.equal(merged.status, 200, merged.text);
        const after_ = (await get(`${p}/patterns`)).body;
        assert.deepEqual(
            after_.items.map((x: { title: string; total: number }) => [x.title, x.total]),
            [["Tenant id trusted from the client", 7]],
        );
        assert.equal((await send("POST", `${p}/patterns/${own.body.id}/merge`, { into: own.body.id })).status, 400);
        assert.equal((await send("POST", `${p}/patterns/${own.body.id}/merge`, { into: "nope" })).status, 404);
        assert.equal((await issues(`&pattern=${own.body.id}`)).total, 5);

        assert.equal((await get(`${p}/patterns`, viewer)).status, 200);
        for (const [method, path, body] of [
            ["POST", `${p}/patterns`, { title: "A viewer's own" }],
            ["PATCH", `${p}/patterns/${own.body.id}`, { hidden: true }],
            ["DELETE", `${p}/patterns/${own.body.id}`, {}],
            ["POST", `${p}/patterns/group`, {}],
            ["POST", `${p}/false-positives`, {}],
        ] as const)
            assert.equal((await send(method, path, body, viewer)).status, 403, `${method} ${path}`);

        // What was done is in the activity log.
        const log = (await get(`${p}/activity?limit=50`)).body.items as { kind: string; changes: Record<string, unknown> }[];
        const kinds = log.filter((r) => r.kind === "pattern").map((r) => Object.keys(r.changes).sort().join(","));
        assert.ok(kinds.includes("created"), kinds.join(" | "));
        assert.ok(kinds.includes("merged,title"), kinds.join(" | "));
        ids.own = own.body.id;
    });

    test("a branch's findings stay under their common issues when the branch is renamed", async () => {
        const moved = await send("POST", `${p}/branches/move`, { from: "small", to: "little" });
        assert.equal(moved.status, 200, moved.text);
        const little = (await get(`${p}/patterns?branch=little`)).body;
        assert.deepEqual([little.items[0].open, little.ungrouped], [2, 0]);
    });

    test("likely false positives: nothing to learn from until something is dismissed with a reason; then suggestions, never changes", async () => {
        const none = await send("POST", `${p}/false-positives`);
        assert.equal(none.status, 409, none.text);
        assert.match(none.text, /Nothing has been dismissed with a reason in this project yet/);
        const empty = (await get(`${p}/false-positives`)).body;
        assert.deepEqual([empty.analysis, empty.items, empty.dismissed, empty.enough], [null, [], 0, 10]);

        // Dismissed without a note isn't a reason; as a duplicate isn't a judgement of the finding.
        await send("PATCH", `${p}/issues/${ids["src/web/page1.tsx"]}?branch=main`, { status: "wont_fix" });
        await send("PATCH", `${p}/issues/${ids["src/web/page2.tsx"]}?branch=main`, {
            duplicateOf: ids["src/web/page3.tsx"],
            note: "Same as page3.",
        });
        assert.equal((await send("POST", `${p}/false-positives`)).status, 409);
        await send("PATCH", `${p}/issues/${ids["src/web/page3.tsx"]}?branch=main`, {
            status: "wont_fix",
            note: "Generated file: we don't style-check these.",
        });

        provider.say = ({ user }) => {
            const q = JSON.parse(user) as { dismissed: { n: number; reason: string }[]; open: { n: number; file: string }[] };
            assert.deepEqual(
                q.dismissed.map((d) => d.reason),
                ["Generated file: we don't style-check these."],
            );
            const pick = q.open.find((o) => o.file === "src/web/page4.tsx")?.n;
            return JSON.stringify({
                likely: [
                    { finding: pick, like: 1, why: "Another generated page." },
                    { finding: 999, like: 1, why: "x" },
                ],
            });
        };
        const a = await done((await send("POST", `${p}/false-positives`)).body.id);
        assert.equal(a.status, "done", a.error ?? "");
        assert.match(String(a.result?.warning), /Only 1 finding has been dismissed with a reason in this project/);
        assert.doesNotMatch(provider.requests.map((r) => r.raw).join(""), /DO-NOT-SEND-THIS-CODE/);
        const sent = JSON.parse((provider.requests[0] as (typeof provider.requests)[number]).user);
        // What only one model found, and the least serious, come first: the style findings before the security ones.
        assert.match(sent.open[0].file, /^src\/web\//);

        const got = (await get(`${p}/false-positives`)).body;
        assert.equal(got.dismissed, 1);
        assert.equal(got.items.length, 1);
        assert.deepEqual(
            [got.items[0].id, got.items[0].path, got.items[0].why, got.items[0].like.title, got.items[0].like.reason],
            [
                ids["src/web/page4.tsx"],
                "src/web/page4.tsx",
                "Another generated page.",
                "Unrelated thing number 3",
                "Generated file: we don't style-check these.",
            ],
        );
        // Nothing was closed by it; and once someone deals with it, it's no longer suggested.
        assert.equal((await get(`${p}/issues/${ids["src/web/page4.tsx"]}`)).body.status, "open");
        await send("PATCH", `${p}/issues/${ids["src/web/page4.tsx"]}?branch=main`, { status: "wont_fix", note: "Generated too." });
        assert.deepEqual((await get(`${p}/false-positives`)).body.items, []);
    });

    test("deleting one puts its findings under none again; deleting the project takes them all", async () => {
        const gone = await send("DELETE", `${p}/patterns/${ids.own}`);
        assert.equal(gone.status, 200, gone.text);
        const list = (await get(`${p}/patterns`)).body;
        assert.deepEqual(list.items, []);
        assert.equal((await get(`${p}/issues/${ids["db/migrations/0002.sql"]}`)).body.commonIssue, null);
        const project = await t.services.store.projects.bySlug((await t.services.store.workspaces.bySlug("acme"))?.id as string, "app");
        await send("POST", `${p}/patterns`, { title: "One to go with the project" });
        const removed = await send("DELETE", p, { confirm: "app" });
        assert.ok(removed.status < 300, removed.text);
        assert.deepEqual(await t.services.store.patterns.forProject(project?.id as string), []);
        assert.deepEqual(await t.services.store.patterns.findings(project?.id as string), []);
    });
});
