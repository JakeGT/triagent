// Where findings came from (services/origins.ts), against a fake GitHub that answers blame from real git
// history: off until an admin turns it on; each finding traced to the newest commit that changed its
// lines; the code's age, pull requests and a suggested assignee; the authors leaderboard only at its own
// level; and what happens when GitHub can't blame a file, or the workspace turns it off again.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { blameQuery, originOf, readBlame, summarise } from "../src/domain/origins.ts";
import type { FindingOrigin, Job } from "../src/store/types.ts";
import type { Session } from "./helpers.ts";
import { eventually, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

describe("reading blame", () => {
    const commit = (oid: string, at: string, name = "Ann") => ({
        oid: oid.repeat(40),
        authoredDate: at,
        messageHeadline: "Change",
        author: { name, email: `${name}@Example.Test`, user: name === "Ann" ? { login: "ann" } : null },
        associatedPullRequests: { nodes: name === "Ann" ? [{ number: 4, title: "A change" }] : [] },
    });

    test("one request asks for each file by its own name; what comes back is read strictly", () => {
        const q = blameQuery(2);
        assert.match(q, /\$p0: String!, \$p1: String!/);
        assert.match(q, /f1: blame\(path: \$p1\)/);
        const data = {
            repository: {
                object: {
                    f0: {
                        ranges: [
                            { startingLine: 1, endingLine: 4, commit: commit("a", "2026-01-01T00:00:00Z") },
                            { startingLine: 5, endingLine: 9, commit: commit("b", "2026-06-01T00:00:00Z", "Bo") },
                            { startingLine: "x", endingLine: 9, commit: commit("c", "2026-06-01T00:00:00Z") },
                            { startingLine: 10, endingLine: 10, commit: { ...commit("d", "2026-06-01T00:00:00Z"), oid: "nope" } },
                        ],
                    },
                    f1: null,
                },
            },
        };
        const [first, second] = readBlame(data, 2);
        assert.equal(second, null);
        assert.equal(first?.length, 2);
        assert.deepEqual(first?.[0]?.commit, {
            oid: "a".repeat(40),
            authoredAt: "2026-01-01T00:00:00.000Z",
            headline: "Change",
            name: "Ann",
            email: "ann@example.test",
            login: "ann",
            pr: { number: 4, title: "A change" },
        });
        assert.deepEqual([first?.[1]?.commit.login, first?.[1]?.commit.pr], [null, null]);
        assert.deepEqual(readBlame(null, 1), [null]);

        // The newest commit to change any of a finding's lines is the one behind it.
        const ranges = first ?? [];
        assert.equal(originOf(ranges, 2, 2)?.name, "Ann");
        assert.equal(originOf(ranges, 4, 6)?.name, "Bo");
        assert.equal(originOf(ranges, 7, null)?.name, "Bo");
        assert.equal(originOf(ranges, 40, 41), null);
    });

    test("counted: open findings by the code's age, by pull request and by author; a rate only with lines enough to mean something", () => {
        const origin = (id: string, over: Partial<FindingOrigin>): FindingOrigin => ({
            workspaceId: "w",
            projectId: "p",
            branch: "main",
            findingId: id,
            commit: "a".repeat(40),
            headline: "",
            authoredAt: ago(5),
            authorName: "Ann",
            authorLogin: "ann",
            memberId: null,
            prNumber: null,
            prTitle: null,
            ...over,
        });
        const s = summarise(
            [
                { id: "1", severity: "critical", status: "open", origin: origin("1", { prNumber: 4, prTitle: "A change" }) },
                { id: "2", severity: "low", status: "open", origin: origin("2", { authoredAt: ago(50), prNumber: 4 }) },
                { id: "3", severity: "high", status: "resolved", origin: origin("3", {}) },
                {
                    id: "4",
                    severity: "high",
                    status: "in_progress",
                    origin: origin("4", { authorName: "Bo", authorLogin: null, authoredAt: ago(500) }),
                },
            ],
            { "@ann": 1000, "name:bo": 50, "@cy": 400, "@dee": 10 },
            { "@cy": { name: "Cy", login: "cy", memberId: null }, "@dee": { name: "Dee", login: "dee", memberId: null } },
            Date.now(),
        );
        assert.deepEqual([s.traced, s.open], [4, 3]);
        assert.deepEqual(s.age, { month: 1, quarter: 1, year: 0, older: 1 });
        assert.deepEqual(
            s.pulls.map((p) => [p.number, p.open, p.serious]),
            [[4, 2, 1]],
        );
        assert.deepEqual(
            s.authors.map((a) => [a.key, a.open, a.serious, a.findings, a.lines, a.perThousand]),
            [
                ["@ann", 2, 1, 3, 1000, 2],
                // Too few lines for a rate.
                ["name:bo", 1, 1, 1, 50, null],
                // Wrote plenty of what was looked at, and nothing was found in it.
                ["@cy", 0, 0, 0, 400, 0],
            ],
        );
    });
});

describe("where findings came from", () => {
    let env: ReviewEnv;
    let viewer: Session;
    let token: string;
    let head = "";
    let bobs = "";
    const ws = "traced";
    const api = `/api/v1/w/${ws}`;
    const p = `${api}/p/app`;
    const ALICE = { name: "Alice Adams", email: "alice@example.test" };
    const BOB = { name: "Bob Brown", email: "bob@example.test" };
    const get = (path: string, session: Session = env.admin) => env.t.request(path, { session });
    const send = (method: string, path: string, body: object = {}, session: Session = env.admin) =>
        env.t.request(path, { method, session, body });
    const traced = async (branch = "main") =>
        eventually(async () => {
            const s = (await get(`${p}/origins?branch=${branch}`)).body;
            return s.scan && s.scan.status !== "running" ? s : null;
        }, "the tracing to finish");
    const finding = (file: string, line: number | null, end: number | null, severity = "high") => ({
        path: file,
        content: `Something about ${file}${line ? ` at line ${line}` : ""}.`,
        severity,
        category: "bug",
        ...(line ? { start_line: line, end_line: end ?? line } : {}),
    });
    const lines = (n: number, mark = "") => `${Array.from({ length: n }, (_, i) => `line ${i + 1}${mark}`).join("\n")}\n`;
    const REPORT = () => ({
        project_summary: "",
        comments: [
            finding("src/a.ts", 3, 3, "critical"),
            finding("src/a.ts", 8, 8),
            finding("src/a.ts", 2, 4, "medium"),
            finding("src/b.ts", 2, 2, "low"),
            finding("src/c.ts", 1, 1),
            finding("src/a.ts", null, null, "low"),
            finding("src/gone.ts", 1, 1, "low"),
        ],
    });
    let ids: Record<string, string> = {};
    const upload = async (commit: string | undefined, branch = "main") => {
        const up = await send("POST", `${p}/reports`, { branch, report: REPORT(), confirm: true, ...(commit ? { commit } : {}) });
        assert.equal(up.status, 200, up.text);
        const items = (await get(`${p}/issues?branch=${branch}&limit=50`)).body.items as {
            id: string;
            path: string;
            startLine: number | null;
            endLine: number | null;
        }[];
        ids = Object.fromEntries(
            items.map((x) => [`${x.path}:${x.startLine ?? ""}${x.endLine && x.endLine !== x.startLine ? `-${x.endLine}` : ""}`, x.id]),
        );
    };

    before(async () => {
        env = await reviewEnv();
        await patProject(env, ws, { repo: "traced/app" });
        // Alice wrote it all long ago; Bob changed two lines of a.ts and added c.ts last week; Alice touched b.ts yesterday.
        await env.fake.gitRepo("traced/app", { "README.md": "# app\n" });
        await env.fake.commit("traced/app", "main", { "src/a.ts": lines(10), "src/b.ts": lines(5) }, "Add a and b", undefined, {
            ...ALICE,
            at: ago(400),
        });
        const a = lines(10).split("\n");
        a[2] = "line 3, as Bob has it";
        a[3] = "line 4, as Bob has it";
        bobs = await env.fake.commit(
            "traced/app",
            "main",
            { "src/a.ts": a.join("\n"), "src/c.ts": lines(3) },
            "Rework a, add c",
            undefined,
            {
                ...BOB,
                at: ago(7),
            },
        );
        const b = lines(5).split("\n");
        b[1] = "line 2, as Alice now has it";
        head = await env.fake.commit("traced/app", "main", { "src/b.ts": b.join("\n") }, "Fix b", undefined, { ...ALICE, at: ago(1) });
        env.fake.logins.set(BOB.email, "bob");
        env.fake.commitPulls.set(bobs, { number: 7, title: "Rework a" });
        await upload(head);

        // Bob is a member whose username is his GitHub login; Alice one whose email is on her commits.
        for (const [username] of [["bob"], ["alice"], ["vera"]] as const) {
            await send("POST", "/api/v1/instance/users", { username, password: "hunter2-hunter2-one" });
            await send("POST", `${api}/settings/members`, { username, role: username === "vera" ? "viewer" : "editor" });
        }
        const alice = (await env.t.services.store.users.byUsername("alice")) as NonNullable<
            Awaited<ReturnType<typeof env.t.services.store.users.byUsername>>
        >;
        await env.t.services.store.users.put({ ...alice, email: "Alice@Example.Test" });
        viewer = await env.t.signIn("vera", "hunter2-hunter2-one");
        await env.t.request("/api/v1/me/password", {
            method: "POST",
            session: viewer,
            body: { current: "hunter2-hunter2-one", password: "hunter2-hunter2-two" },
        });
        token = (await send("POST", `${api}/settings/tokens`, { name: "agent", scope: "read" })).body.token;
    });
    after(async () => {
        await env.t.services.origins.settled();
        await env.close();
    });

    test("off until an admin turns it on: nothing is asked of GitHub, and nothing is shown", async () => {
        assert.deepEqual((await get(`${api}/settings/origins`)).body, { level: "off", levels: ["off", "on", "leaderboard"] });
        const s = (await get(`${p}/origins`)).body;
        assert.deepEqual([s.level, s.scan, s.authors, s.age], ["off", null, null, null]);
        const refused = await send("POST", `${p}/origins`);
        assert.equal(refused.status, 409, refused.text);
        assert.match(refused.text, /doesn't trace findings to commits\. An admin can turn it on in Settings → Analysis/);
        assert.equal((await get(`${p}/issues/${ids["src/a.ts:3"]}`)).body.origin, null);
        assert.ok(!env.fake.log.some((l) => l.path.startsWith("/graphql")));

        assert.equal((await send("PUT", `${api}/settings/origins`, { level: "on" }, viewer)).status, 403);
        assert.equal((await send("PUT", `${api}/settings/origins`, { level: "everything" })).status, 400);
        assert.deepEqual((await send("PUT", `${api}/settings/origins`, { level: "on" })).body, { level: "on" });
        const audit = (await get(`${api}/settings/audit`)).body.items as { target: string; changes: unknown }[];
        assert.deepEqual(audit.find((a) => a.target === "origins")?.changes, { level: { from: "off", to: "on" } });
    });

    test("traced: each finding to the newest commit that changed its lines, with the code's age and its pull request; no authors yet", async () => {
        const started = await send("POST", `${p}/origins`);
        assert.equal(started.status, 202, started.text);
        assert.deepEqual([started.body.status, started.body.commit, started.body.lines], ["running", head, undefined]);
        const s = await traced();
        assert.equal(s.scan.status, "done", s.scan.error);
        // Three files could be blamed; the finding about a whole file, and the one in a file that isn't there, couldn't be traced.
        assert.deepEqual([s.scan.files, s.scan.traced, s.scan.skipped, s.stale], [3, 5, 2, false]);
        assert.deepEqual([s.traced, s.open], [5, 5]);
        // Bob's week-old lines have three findings, Alice's from yesterday one, and her year-old ones one.
        assert.deepEqual(s.age, { month: 4, quarter: 0, year: 0, older: 1 });
        assert.deepEqual(
            s.pulls.map((x: { number: number; title: string; open: number; serious: number }) => [x.number, x.title, x.open, x.serious]),
            [[7, "Rework a", 3, 2]],
        );
        assert.equal(s.authors, null);
        // One request for the three files' blame, at the report's commit, and nothing of anyone's email kept.
        const asked = env.fake.log.filter((l) => l.path.startsWith("/graphql"));
        assert.equal(asked.length, 1);
        assert.equal((asked[0] as unknown as { body: { variables: { oid: string } } }).body.variables.oid, head);
        const kept = JSON.stringify(
            await env.t.services.store.origins.forBranch(
                (await env.t.services.store.projects.bySlug((await env.t.services.store.workspaces.bySlug(ws))?.id as string, "app"))
                    ?.id as string,
                "main",
            ),
        );
        assert.doesNotMatch(kept, /example\.test/);
    });

    test("an issue says which commit is behind it, and suggests the member who wrote it", async () => {
        const one = (await get(`${p}/issues/${ids["src/a.ts:3"]}`)).body.origin;
        assert.deepEqual(
            [one.commit, one.headline, one.author, one.login, one.pr, one.suggested],
            [bobs, "Rework a, add c", "Bob Brown", "bob", { number: 7, title: "Rework a" }, "bob"],
        );
        // Lines 2 to 4: Alice's and Bob's. The newest change is Bob's.
        assert.equal((await get(`${p}/issues/${ids["src/a.ts:2-4"]}`)).body.origin.author, "Bob Brown");
        // Alice is matched by the address on her commits, whatever its case.
        const old = (await get(`${p}/issues/${ids["src/a.ts:8"]}`)).body.origin;
        assert.deepEqual([old.author, old.login, old.pr, old.suggested, old.headline], ["Alice Adams", null, null, "alice", "Add a and b"]);
        assert.equal((await get(`${p}/issues/${ids["src/a.ts:"]}`)).body.origin, null);
        // Someone removed from the workspace is no longer suggested.
        const members = (await get(`${api}/settings/members`)).body.items as { user: { id: string; username: string } }[];
        const bob = members.find((m) => m.user.username === "bob") as { user: { id: string } };
        assert.equal((await send("DELETE", `${api}/settings/members/${bob.user.id}`)).status, 200);
        assert.equal((await get(`${p}/issues/${ids["src/a.ts:3"]}`)).body.origin.suggested, null);

        const res = await env.t.request("/mcp", {
            method: "POST",
            token,
            body: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "get_issue", arguments: { project: "app", id: ids["src/a.ts:3"] } },
            },
        });
        assert.match(
            res.body.result.content[0].text,
            new RegExp(`\\*\\*Lines last changed:\\*\\* \\d{4}-\\d\\d-\\d\\d by Bob Brown in ${bobs.slice(0, 7)} \\(pull request #7\\)`),
        );
    });

    test("the leaderboard is its own level: authors by open findings, with lines they wrote, and the issues list by author", async () => {
        // Not at the "on" level: no authors, and the filter finds nothing.
        assert.equal((await get(`${p}/issues?author=@bob`)).body.total, 0);
        assert.deepEqual((await send("PUT", `${api}/settings/origins`, { level: "leaderboard" })).body, { level: "leaderboard" });
        const s = (await get(`${p}/origins`, viewer)).body;
        assert.deepEqual(
            s.authors.map((a: Record<string, unknown>) => [
                a.key,
                a.name,
                a.login,
                a.member,
                a.open,
                a.serious,
                a.findings,
                a.lines,
                a.perThousand,
            ]),
            [
                // a.ts lines 3 and 4, and the three of c.ts.
                ["@bob", "Bob Brown", "bob", null, 3, 2, 3, 5, null],
                ["name:alice adams", "Alice Adams", null, "alice", 2, 1, 2, 13, null],
            ],
        );
        const bobsOnes = (await get(`${p}/issues?author=@bob`)).body;
        assert.equal(bobsOnes.total, 3);
        assert.equal((await get(`${p}/issues?author=name:alice%20adams&severity=low`)).body.total, 1);
        assert.equal((await get(`${p}/issues?author=@nobody`)).body.total, 0);
        // Fixed: no longer open against the author, still counted as found there.
        await send("PATCH", `${p}/issues/${ids["src/c.ts:1"]}?branch=main`, { status: "resolved" });
        const after_ = (await get(`${p}/origins`)).body;
        const bob = after_.authors.find((a: { key: string }) => a.key === "@bob");
        assert.deepEqual([bob.open, bob.findings, after_.open], [2, 3, 4]);
    });

    test("a file GitHub can't blame is left out, and the rest are still traced", async () => {
        env.fake.unblameable.add("src/b.ts");
        env.fake.log.length = 0;
        await send("POST", `${p}/origins`);
        const s = await traced();
        assert.equal(s.scan.status, "done", s.scan.error);
        assert.deepEqual([s.scan.files, s.scan.traced, s.scan.skipped], [2, 4, 3]);
        // The request for them all failed, so each was asked for by itself.
        assert.equal(env.fake.log.filter((l) => l.path.startsWith("/graphql")).length, 5);
        env.fake.unblameable.clear();
    });

    test("what can't be traced says why; a report that has moved on is stale; a renamed branch keeps what was traced", async () => {
        await send("POST", `${p}/reports`, { branch: "uploaded", report: REPORT(), confirm: true });
        const none = await send("POST", `${p}/origins?branch=uploaded`);
        assert.equal(none.status, 409, none.text);
        assert.match(none.text, /doesn't say which commit it's of/);
        assert.equal((await send("POST", `${p}/origins?branch=nope`)).status, 409);

        await send("POST", `${api}/projects`, { slug: "loose" });
        await send("POST", `${api}/p/loose/reports`, { branch: "main", report: REPORT(), commit: head });
        const unconnected = await send("POST", `${api}/p/loose/origins`);
        assert.equal(unconnected.status, 409, unconnected.text);
        assert.match(unconnected.text, /Tracing findings to commits asks GitHub for them/);

        await send("POST", `${p}/origins`);
        await traced();
        const moved = await send("POST", `${p}/branches/move`, { from: "main", to: "trunk", makeDefault: true });
        assert.equal(moved.status, 200, moved.text);
        const trunk = (await get(`${p}/origins?branch=trunk`)).body;
        assert.deepEqual([trunk.scan.status, trunk.traced, trunk.stale], ["done", 5, false]);
        // A new report of another commit: what's traced is of the old one, and says so.
        await send("POST", `${p}/reports`, { branch: "trunk", report: REPORT(), commit: bobs, confirm: true });
        assert.equal((await get(`${p}/origins?branch=trunk`)).body.stale, true);
    });

    test("after a review, a workspace that asked for it has its findings traced without anyone asking; turned off, everything traced goes", async () => {
        const workspace = await env.t.services.store.workspaces.bySlug(ws);
        const project = await env.t.services.store.projects.bySlug(workspace?.id as string, "app");
        const job = {
            id: "j1",
            workspaceId: workspace?.id,
            projectId: project?.id,
            branch: "trunk",
            status: "done",
            result: { reportId: "r" },
        } as unknown as Job;
        env.t.services.origins.reviewFinished(job, project as NonNullable<typeof project>);
        await env.t.services.origins.settled();
        const s = (await get(`${p}/origins?branch=trunk`)).body;
        assert.deepEqual([s.scan.status, s.scan.commit, s.stale], ["done", bobs, false]);
        // A model run again, or a comparison, changed no branch: nothing to trace.
        env.fake.log.length = 0;
        env.t.services.origins.reviewFinished(
            { ...job, rerunOf: { jobId: "x" } } as unknown as Job,
            project as NonNullable<typeof project>,
        );
        await env.t.services.origins.settled();
        assert.equal(env.fake.log.filter((l) => l.path.startsWith("/graphql")).length, 0);

        assert.deepEqual((await send("PUT", `${api}/settings/origins`, { level: "off" })).body, { level: "off" });
        assert.deepEqual(await env.t.services.store.origins.forBranch(project?.id as string, "trunk"), []);
        assert.equal(await env.t.services.store.origins.scan(project?.id as string, "trunk"), null);
        const off = (await get(`${p}/origins?branch=trunk`)).body;
        assert.deepEqual([off.level, off.scan], ["off", null]);
        env.t.services.origins.reviewFinished(job, project as NonNullable<typeof project>);
        await env.t.services.origins.settled();
        assert.equal(await env.t.services.store.origins.scan(project?.id as string, "trunk"), null);
    });
});
