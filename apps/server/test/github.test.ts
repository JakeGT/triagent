// GitHub, with a fake GitHub: webhooks for a project's token and for the GitHub App (signatures checked,
// events routed to the right workspace's projects), automatic reviews and their baseline, creating the
// app and linking installations (refused unless GitHub confirms the person can see the installation),
// branch sync, the nightly scan, and the MCP tools for reviews.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { COMMENT_MARKER } from "../src/services/github/service.ts";
import { ADMIN_PASSWORD, type Session } from "./helpers.ts";
import { eventually, finished, PAT, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe("pull requests with a token: webhooks, checks and the baseline", () => {
    let env: ReviewEnv;
    let hook: string;
    let secret: string;
    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme");
        await env.fake.gitRepo("acme/app", { "src/a.ts": "a\n" });
        const s = await env.t.request("/api/v1/w/acme/p/app/settings/github/webhook-secret", {
            method: "POST",
            session: env.admin,
            body: {},
        });
        secret = s.body.webhookSecret;
        hook = s.body.url.replace("http://triagent.test", env.url);
    });
    after(() => env.close());

    const prs = async () => (await env.t.request("/api/v1/w/acme/p/app/pull-requests", { session: env.admin })).body;
    const automation = (body: object) =>
        env.t.request("/api/v1/w/acme/p/app/settings/automation", { method: "PATCH", session: env.admin, body });

    test("switching automatic reviews on lists open pull requests without reviewing them; new pushes are reviewed", async () => {
        await env.fake.commit("acme/app", "one", { "src/one.ts": "1\n" }, "one", "main");
        await env.fake.openPull("acme/app", { number: 1, headRef: "one", title: "First" });
        await env.fake.commit("acme/app", "two", { "src/two.ts": "2\n" }, "two", "main");
        await env.fake.openPull("acme/app", { number: 2, headRef: "two", title: "Second" });
        await env.fake.openPull("acme/app", { number: 3, headRef: "one", title: "Draft", draft: true });

        // Off: a check lists them, and says why nothing was queued.
        const off = await env.t.request("/api/v1/w/acme/p/app/pull-requests/check", { method: "POST", session: env.admin, body: {} });
        assert.equal(off.status, 200, off.text);
        assert.ok(off.body.lastCheck.decisions.every((d: { action: string }) => d.action === "skipped"));
        assert.match(off.body.items.find((p: { number: number }) => p.number === 1).lastDecision.why, /automatic reviews are off/);

        assert.equal((await automation({ enabled: true, pollMinutes: 1 })).status, 200);
        await env.t.services.automation.tick(later(2));
        let page = await prs();
        const one = page.items.find((p: { number: number }) => p.number === 1);
        assert.equal(one.status, "not reviewed (was already open)");
        assert.match(one.lastDecision.why, /already open when automatic reviews were switched on/);
        assert.equal(page.items.find((p: { number: number }) => p.number === 3).lastDecision.why, "it's a draft");
        assert.equal((await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10)).length, 0);

        // A push to #1 is reviewed; #2, untouched, still isn't.
        await env.fake.commit("acme/app", "one", { "src/one.ts": "1b\n" }, "more");
        await env.t.services.automation.tick(later(4));
        page = await prs();
        assert.equal(page.items.find((p: { number: number }) => p.number === 1).lastDecision.action, "queued");
        assert.equal(page.items.find((p: { number: number }) => p.number === 2).lastDecision.action, "skipped");
        const queued = await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10);
        assert.deepEqual(
            queued.map((j) => [j.pr?.number, j.source]),
            [[1, "automation"]],
        );
        // "Review now" for #2.
        const now = await env.t.request("/api/v1/w/acme/p/app/reviews", {
            method: "POST",
            session: env.admin,
            body: { kind: "pr", number: 2 },
        });
        assert.equal(now.status, 201, now.text);
        assert.equal(now.body.source, "person");
        // Checking again doesn't queue #1 twice.
        await env.t.services.automation.tick(later(6));
        assert.equal((await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10)).length, 2);
        assert.match((await prs()).items.find((p: { number: number }) => p.number === 1).lastDecision.why, /already queued/);
        // A queued PR review set a pending status on its commit.
        await env.t.services.runs.settled();
        assert.ok(
            env.fake
                .repo("acme/app")
                .statuses.some((s) => s.state === "pending" && s.description === "Queued: reviews are waiting (see Triagent)"),
        );
        for (const j of await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10))
            await env.t.request(`/api/v1/w/acme/runs/${j.id}/cancel`, { method: "POST", session: env.admin, body: {} });
    });

    test("the project's webhook: signature checked, pull request events checked at once, deliveries recorded", async () => {
        const body = { action: "opened", number: 4, pull_request: { number: 4 }, repository: { full_name: "acme/app" } };
        assert.equal((await env.fake.deliver(hook, "pull_request", body, "wrong")).status, 401);
        assert.equal((await env.fake.deliver(hook, "pull_request", body, null)).status, 401);
        await env.fake.commit("acme/app", "four", { "src/four.ts": "4\n" }, "four", "main");
        await env.fake.openPull("acme/app", { number: 4, headRef: "four" });
        const ok = await env.fake.deliver(hook, "pull_request", body, secret);
        assert.equal(ok.status, 200);
        assert.match(String(ok.body.note), /Checking pull requests now/);
        await env.t.services.runs.settled();
        const queued = await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10);
        assert.deepEqual(
            queued.map((j) => j.pr?.number),
            [4],
        );
        // Another repository's delivery is ignored.
        const elsewhere = await env.fake.deliver(hook, "pull_request", { ...body, repository: { full_name: "evil/app" } }, secret);
        assert.equal(elsewhere.body.ignored, true);
        const deliveries = (await prs()).deliveries;
        assert.deepEqual(
            deliveries.slice(0, 4).map((d: { outcome: string }) => d.outcome),
            ["ignored", "received", "refused", "refused"],
        );
        assert.match(deliveries[2].detail, /No signature/);
        await env.t.request(`/api/v1/w/acme/runs/${queued[0]?.id}/cancel`, { method: "POST", session: env.admin, body: {} });
    });
});

describe("branches on GitHub, and the nightly scan", () => {
    let env: ReviewEnv;
    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme");
        await env.fake.gitRepo("acme/app", { "src/a.ts": "a\n" });
    });
    after(() => env.close());

    const upload = (branch: string, commit: string) =>
        env.t.request("/api/v1/w/acme/p/app/reports", {
            method: "POST",
            session: env.admin,
            body: {
                branch,
                commit,
                report: { comments: [{ path: "src/a.ts", content: `Something on ${branch} needs fixing.` }] },
                confirm: true,
            },
        });

    test("reports are marked out of date with how far behind, unreviewed branches listed, deleted ones archived", async () => {
        const fake = env.fake;
        const main = fake.repo("acme/app").branches.get("main") as string;
        const feature = await fake.commit("acme/app", "feature", { "src/f.ts": "f\n" }, "f", "main");
        const gone = await fake.commit("acme/app", "gone", { "src/g.ts": "g\n" }, "g", "main");
        await fake.commit("acme/app", "fresh", { "src/n.ts": "n\n" }, "n", "main");
        assert.equal((await upload("main", main)).status, 200);
        assert.equal((await upload("feature", feature)).status, 200);
        assert.equal((await upload("gone", gone)).status, 200);
        await fake.commit("acme/app", "feature", { "src/f2.ts": "x\n" }, "f2");
        await fake.commit("acme/app", "feature", { "src/f3.ts": "x\n" }, "f3");
        await env.t.request("/api/v1/w/acme/p/app/settings/automation", {
            method: "PATCH",
            session: env.admin,
            body: { archiveDeletedBranches: true },
        });
        const project = (await env.t.services.store.projects.bySlug(
            (
                await env.t.services.store.workspaces.bySlug("acme")
            )?.id as string,
            "app",
        )) as never;
        assert.equal(await env.t.services.automation.syncBranches(project), true);

        let list = (await env.t.request("/api/v1/w/acme/p/app/branches", { session: env.admin })).body;
        const by = (n: string) => list.items.find((b: { name: string }) => b.name === n);
        assert.deepEqual(by("main").github, { onGitHub: true, current: true, githubSha: main, behind: null, diverged: false });
        assert.equal(by("feature").github.current, false);
        assert.equal(by("feature").github.behind, 2);
        assert.deepEqual(list.github.notReviewed, ["fresh"]);

        // Deleted on GitHub: archived here (never the default branch, even if that goes too).
        fake.deleteBranch("acme/app", "gone");
        fake.deleteBranch("acme/app", "main");
        await env.t.services.automation.syncBranches(project);
        list = (await env.t.request("/api/v1/w/acme/p/app/branches", { session: env.admin })).body;
        assert.equal(by("gone"), undefined);
        assert.equal(by("main").github.onGitHub, false);
        const history = (await env.t.request("/api/v1/w/acme/p/app/reports?branch=gone", { session: env.admin })).body;
        assert.equal(history.archived[0].reason, "deleted");
        fake.repo("acme/app").branches.set("main", main);
    });

    test("the nightly full scan is queued once, at its hour", async () => {
        const hour = later(0).getUTCHours();
        await env.t.request("/api/v1/w/acme/p/app/settings/automation", {
            method: "PATCH",
            session: env.admin,
            body: { enabled: true, nightlyHourUtc: hour },
        });
        await env.t.services.automation.tick(later(0));
        await env.t.services.automation.tick(later(1));
        const jobs = (await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10)).filter((j) => j.kind === "full");
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.title, "Full scan of main (nightly)");
        assert.equal(jobs[0]?.source, "automation");
    });
});

describe("the GitHub App", () => {
    let env: ReviewEnv;
    let mallory: Session;
    before(async () => {
        env = await reviewEnv();
        // Two organisations; acme's admin is "admin", evil's is mallory.
        await patProject(env, "acme", { token: PAT(1) });
        await env.t.request("/api/v1/instance/users", {
            method: "POST",
            session: env.admin,
            body: { username: "mallory", password: "hunter2-hunter2-one" },
        });
        const first = await env.t.signIn("mallory", "hunter2-hunter2-one");
        await env.t.request("/api/v1/me/password", {
            method: "POST",
            session: first,
            body: { current: "hunter2-hunter2-one", password: "hunter2-hunter2-two" },
        });
        mallory = await env.t.signIn("mallory", "hunter2-hunter2-two");
        await env.t.request("/api/v1/workspaces", { method: "POST", session: mallory, body: { slug: "evil" } });
        await env.t.request("/api/v1/w/evil/projects", { method: "POST", session: mallory, body: { slug: "app" } });
        await env.t.request("/api/v1/w/evil/settings/review-model/keys/openrouter", {
            method: "PUT",
            session: mallory,
            body: { key: `sk-or-${randomBytes(12).toString("hex")}` },
        });
        await env.fake.gitRepo("acme/app", { "src/a.ts": "a\n" });
        await env.fake.gitRepo("evil/app", { "src/e.ts": "e\n" });
    });
    after(() => env.close());

    test("an instance admin creates it with GitHub's manifest flow; its secrets are kept, never shown", async () => {
        const start = await env.t.request("/api/v1/instance/github-app/manifest", {
            method: "POST",
            session: env.admin,
            body: { name: "Triagent test", public: true, org: "acme", ws: "acme" },
        });
        assert.equal(start.status, 200, start.text);
        const form = await env.t.app.request(`http://triagent.test${start.body.formUrl}`, { headers: { cookie: env.admin.cookie } });
        assert.equal(form.status, 200);
        assert.match(form.headers.get("content-security-policy") ?? "", new RegExp(`form-action ${env.fake.url}`));
        const html = await form.text();
        const action = /action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&") as string;
        assert.ok(action.startsWith(`${env.fake.url}/organizations/acme/settings/apps/new?state=`));
        const manifest = JSON.parse(
            (/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
        );
        assert.equal(manifest.hook_attributes.url, "http://triagent.test/api/v1/github/app/webhook");
        assert.equal(manifest.request_oauth_on_install, true);
        assert.deepEqual(manifest.default_permissions, { contents: "read", metadata: "read", pull_requests: "write", statuses: "write" });
        // Someone else can't use the admin's form.
        assert.equal((await env.t.request(start.body.formUrl, { session: mallory })).status, 403);

        const state = new URL(action).searchParams.get("state") as string;
        const code = env.fake.manifestCode(manifest);
        const created = await env.t.app.request(
            `http://triagent.test/api/v1/instance/github-app/created?code=${code}&state=${encodeURIComponent(state)}`,
            {
                headers: { cookie: env.admin.cookie },
            },
        );
        assert.equal(created.status, 302);
        assert.equal(created.headers.get("location"), "/w/acme/settings/github-app?created=1");
        const status = (await env.t.request("/api/v1/instance/github-app", { session: env.admin })).body;
        assert.equal(status.configured, true);
        assert.equal(status.app.slug, env.fake.app?.slug);
        const text = JSON.stringify(status);
        for (const s of [env.fake.app?.clientSecret, env.fake.app?.webhookSecret, "PRIVATE KEY"]) assert.ok(!text.includes(s as string));
        assert.equal((await env.t.request("/api/v1/instance/github-app", { session: mallory })).status, 403);
    });

    async function link(session: Session, ws: string, installation: number, login: string, opts: { state?: string } = {}) {
        const started = await env.t.request(`/api/v1/w/${ws}/github/installations`, { method: "POST", session, body: { project: "app" } });
        assert.equal(started.status, 200, started.text);
        const url = new URL(started.body.url);
        assert.equal(url.pathname, `/apps/${env.fake.app?.slug}/installations/new`);
        const state = opts.state ?? (url.searchParams.get("state") as string);
        const code = env.fake.oauthCode(login);
        const res = await env.t.app.request(
            `http://triagent.test/api/v1/github/app/installed?code=${code}&installation_id=${installation}&setup_action=install&state=${encodeURIComponent(state)}`,
            { headers: { cookie: session.cookie } },
        );
        return { location: res.headers.get("location") ?? "", state: url.searchParams.get("state") as string };
    }

    test("linking an installation needs GitHub to confirm the person can see it", async () => {
        const acme = env.fake.install("acme", ["acme/app"], ["alice"]);
        const evil = env.fake.install("evil", ["evil/app"], ["mal"]);
        // Mallory claims acme's installation id: GitHub says her account can't see it.
        let r = await link(mallory, "evil", acme.id, "mal");
        assert.match(r.location, /\?github=not-yours$/);
        assert.equal(await env.t.services.store.githubInstallations.get(acme.id), null);
        // A bare installation id, without a state Triagent signed, links nothing.
        const bare = await env.t.app.request(
            `http://triagent.test/api/v1/github/app/installed?installation_id=${acme.id}&setup_action=install`,
            {
                headers: { cookie: mallory.cookie },
            },
        );
        assert.equal(bare.headers.get("location"), "/");
        // Someone else's state doesn't work either.
        const admins = await link(env.admin, "acme", acme.id, "nobody");
        r = await link(mallory, "evil", acme.id, "alice", { state: admins.state });
        assert.match(r.location, /\?github=not-you$/);
        assert.equal(await env.t.services.store.githubInstallations.get(acme.id), null);

        // The real owners link their own.
        r = await link(env.admin, "acme", acme.id, "alice");
        assert.equal(r.location, "/w/acme/p/app/settings/github?github=linked");
        assert.equal((await env.t.services.store.githubInstallations.get(acme.id))?.accountLogin, "acme");
        r = await link(mallory, "evil", evil.id, "mal");
        assert.match(r.location, /github=linked$/);
        // An installation already linked to a workspace can't be taken by another.
        env.fake.installations.get(acme.id)?.users.add("mal");
        r = await link(mallory, "evil", acme.id, "mal");
        assert.match(r.location, /github=taken$/);
        assert.equal(
            (await env.t.services.store.githubInstallations.get(acme.id))?.workspaceId,
            (await env.t.services.store.workspaces.bySlug("acme"))?.id,
        );
        // Only people who manage secrets start an installation.
        const token = await env.t.request("/api/v1/w/acme/settings/tokens", {
            method: "POST",
            session: env.admin,
            body: { name: "m", scope: "manage" },
        });
        assert.equal(
            (
                await env.t.request("/api/v1/w/acme/github/installations", {
                    method: "POST",
                    token: token.body.token,
                    body: { project: "app" },
                })
            ).status,
            403,
        );

        // Each project picks a repository from its own workspace's installations.
        const acmeRepo = env.fake.repo("acme/app");
        const list = (await env.t.request("/api/v1/w/acme/github/installations", { session: env.admin })).body;
        assert.deepEqual(
            list.items[0].repositories.map((x: { fullName: string }) => x.fullName),
            ["acme/app"],
        );
        const pick = await env.t.request("/api/v1/w/acme/p/app/settings/github/repository", {
            method: "PUT",
            session: env.admin,
            body: { installationId: acme.id, repositoryId: acmeRepo.id },
        });
        assert.equal(pick.status, 200, pick.text);
        const wrong = await env.t.request("/api/v1/w/evil/p/app/settings/github/repository", {
            method: "PUT",
            session: mallory,
            body: { installationId: acme.id, repositoryId: acmeRepo.id },
        });
        assert.equal(wrong.status, 404);
        assert.equal(
            (
                await env.t.request("/api/v1/w/evil/p/app/settings/github/repository", {
                    method: "PUT",
                    session: mallory,
                    body: { installationId: evil.id, repositoryId: env.fake.repo("evil/app").id },
                })
            ).status,
            200,
        );
        const settings = (await env.t.request("/api/v1/w/acme/p/app/settings/github", { session: env.admin })).body;
        assert.equal(settings.mode, "app");
        assert.equal(settings.repository.fullName, "acme/app");
        const tested = await env.t.request("/api/v1/w/acme/p/app/settings/github/test", { method: "POST", session: env.admin, body: {} });
        assert.equal(tested.body.mode, "app");
    });

    test("the app's webhook: verified, then routed by installation and repository to the right workspace's project", async () => {
        const secret = env.fake.app?.webhookSecret as string;
        const hook = `${env.url}/api/v1/github/app/webhook`;
        const acme = [...env.fake.installations.values()].find((i) => i.account.login === "acme") as { id: number };
        const evilInst = [...env.fake.installations.values()].find((i) => i.account.login === "evil") as { id: number };
        for (const ws of ["acme", "evil"])
            await env.t.request(`/api/v1/w/${ws}/p/app/settings/automation`, {
                method: "PATCH",
                session: ws === "acme" ? env.admin : mallory,
                body: { enabled: true },
            });
        // A first check sets the baseline (nothing open yet).
        for (const ws of ["acme", "evil"]) {
            const w = await env.t.services.store.workspaces.bySlug(ws);
            await env.t.services.automation.checkPulls((await env.t.services.store.projects.bySlug(w?.id as string, "app")) as never);
        }
        await env.fake.commit("acme/app", "feat", { "src/f.ts": "f\n" }, "f", "main");
        await env.fake.openPull("acme/app", { number: 1, headRef: "feat" });
        await env.fake.commit("evil/app", "feat", { "src/f.ts": "f\n" }, "f", "main");
        await env.fake.openPull("evil/app", { number: 1, headRef: "feat" });

        const payload = (inst: number, repo: string) => ({
            action: "opened",
            number: 1,
            pull_request: { number: 1 },
            installation: { id: inst },
            repository: { id: env.fake.repo(repo).id, full_name: repo },
        });
        assert.equal((await env.fake.deliver(hook, "pull_request", payload(acme.id, "acme/app"), "nope")).status, 401);
        const ok = await env.fake.deliver(hook, "pull_request", payload(acme.id, "acme/app"), secret);
        assert.equal(ok.status, 200);
        await env.t.services.runs.settled();
        const queued = await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10);
        const acmeWs = (await env.t.services.store.workspaces.bySlug("acme"))?.id;
        assert.deepEqual(
            queued.map((j) => j.workspaceId),
            [acmeWs],
        );
        // A repository id that belongs to another installation goes nowhere.
        const crossed = await env.fake.deliver(hook, "pull_request", payload(acme.id, "evil/app"), secret);
        assert.match(String(crossed.body.note), /No project in the workspace uses that repository/);
        const unknown = await env.fake.deliver(hook, "pull_request", payload(999_999, "evil/app"), secret);
        assert.equal(unknown.body.ignored, true);

        // Installation events keep the table current; a suspended installation can't be used.
        await env.fake.deliver(hook, "installation", { action: "suspend", installation: { id: evilInst.id } }, secret);
        assert.equal((await env.t.services.store.githubInstallations.get(evilInst.id))?.suspended, true);
        const start = await env.t.request("/api/v1/w/evil/p/app/reviews", { method: "POST", session: mallory, body: { kind: "full" } });
        assert.equal(start.status, 400);
        assert.match(start.body.error, /suspended/);
        await env.fake.deliver(hook, "installation", { action: "deleted", installation: { id: evilInst.id } }, secret);
        assert.equal(await env.t.services.store.githubInstallations.get(evilInst.id), null);
        const deliveries = (await env.t.request("/api/v1/instance/github-app", { session: env.admin })).body.deliveries;
        assert.ok(deliveries.some((d: { outcome: string }) => d.outcome === "refused"));
    });

    test("a review through the app: a token narrowed to the repository, read-only for the runner", async () => {
        await env.t.request("/api/v1/w/acme/settings/review-model/keys/openrouter", {
            method: "PUT",
            session: env.admin,
            body: { key: `sk-or-${randomBytes(12).toString("hex")}` },
        });
        await env.t.request("/api/v1/w/acme/settings/review-model", { method: "PATCH", session: env.admin, body: { model: "fake/model" } });
        // The project's old token is cleared: everything goes through the app.
        await env.t.request("/api/v1/w/acme/p/app/settings/github/token", { method: "DELETE", session: env.admin });
        for (const j of await env.t.services.store.jobs.list({ statuses: ["queued"] }, 10))
            await env.t.request(`/api/v1/w/acme/runs/${j.id}/cancel`, { method: "POST", session: env.admin, body: {} });
        // A comment someone else wrote, carrying Triagent's marker, isn't Triagent's to edit.
        const planted = { id: 1, body: `Looks fine to me ${COMMENT_MARKER}`, user: "mallory" };
        env.fake.repo("acme/app").comments.set(1, [planted]);
        env.runner();
        const logged = env.fake.log.length;
        const started = await env.t.request("/api/v1/w/acme/p/app/reviews", {
            method: "POST",
            session: env.admin,
            body: { kind: "pr", number: 1 },
        });
        assert.equal(started.status, 201, started.text);
        const run = await finished(env, "acme", started.body.id);
        assert.equal(run.status, "done", run.error);
        const repoId = env.fake.repo("acme/app").id;
        const mints = env.fake.log.slice(logged).filter((l) => /\/access_tokens$/.test(l.path));
        assert.ok(mints.length >= 1);
        for (const m of mints) assert.deepEqual((m.body as { repository_ids: number[] }).repository_ids, [repoId]);
        assert.ok(
            mints.some(
                (m) =>
                    JSON.stringify((m.body as { permissions: object }).permissions) ===
                    JSON.stringify({ contents: "read", metadata: "read" }),
            ),
        );
        assert.ok(env.fake.repo("acme/app").statuses.every((s) => s.by === "installation"));
        const comments = env.fake.repo("acme/app").comments.get(1) ?? [];
        assert.equal(comments.length, 2);
        assert.deepEqual(comments[0], { id: 1, body: `Looks fine to me ${COMMENT_MARKER}`, user: "mallory" });
        assert.equal(comments[1]?.user, `${env.fake.app?.slug}[bot]`);
        assert.match(comments[1]?.body ?? "", /Open Code Review/);
        assert.ok(env.fake.gitLog.some((g) => g.token.startsWith("ghs_")));
    });

    test("removing the app unlinks its installations", async () => {
        assert.equal((await env.t.request("/api/v1/instance/github-app", { method: "DELETE", session: env.admin })).status, 200);
        assert.equal((await env.t.request("/api/v1/instance/github-app", { session: env.admin })).body.configured, false);
        assert.equal(
            (
                await env.t.services.store.githubInstallations.forWorkspace(
                    (
                        await env.t.services.store.workspaces.bySlug("acme")
                    )?.id as string,
                )
            ).length,
            0,
        );
    });
});

describe("MCP tools for reviews", () => {
    let env: ReviewEnv;
    let manage: string;
    let read: string;
    before(async () => {
        env = await reviewEnv();
        await patProject(env, "acme");
        await env.fake.gitRepo("acme/app", { "src/a.ts": "a\n" });
        await env.fake.commit("acme/app", "feat", { "src/f.ts": "f\n" }, "f", "main");
        await env.fake.openPull("acme/app", { number: 3, headRef: "feat", title: "A feature" });
        manage = (
            await env.t.request("/api/v1/w/acme/settings/tokens", {
                method: "POST",
                session: env.admin,
                body: { name: "agent", scope: "manage" },
            })
        ).body.token;
        read = (
            await env.t.request("/api/v1/w/acme/settings/tokens", {
                method: "POST",
                session: env.admin,
                body: { name: "reader", scope: "read" },
            })
        ).body.token;
    });
    after(() => env.close());

    const call = async (token: string, name: string, args: object) => {
        const r = await env.t.request("/mcp", {
            method: "POST",
            token,
            body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        });
        return r.body.result;
    };

    test("an agent starts a review, waits for it, and reads the outcome; a read token can't start one", async () => {
        const tools = (
            await env.t.request("/mcp", { method: "POST", token: read, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })
        ).body.result.tools.map((t: { name: string }) => t.name);
        for (const t of ["list_runs", "get_run", "wait_for_run", "list_pull_requests"]) assert.ok(tools.includes(t), t);
        for (const t of ["start_review", "cancel_run", "check_pull_requests"]) assert.ok(!tools.includes(t), t);
        assert.equal((await call(read, "start_review", { project: "app", kind: "pr", number: 3 })).isError, true);

        const started = await call(manage, "start_review", { project: "app", kind: "pr", number: 3 });
        assert.equal(started.isError, false, started.content[0].text);
        const id = started.structuredContent.id;
        assert.match(started.content[0].text, /Queued run .*PR #3: A feature/);
        const waitingAlready = await call(read, "wait_for_run", { id, seconds: 1 });
        assert.match(waitingAlready.content[0].text, /still queued/);
        assert.match((await call(read, "list_runs", {})).content[0].text, /Queued \(1\)/);
        env.runner();
        const done = await call(read, "wait_for_run", { id, seconds: 60 });
        assert.match(done.content[0].text, /done\. 1 finding\(s\) on branch feat/);
        assert.match((await call(read, "get_run", { id })).content[0].text, /\[triagent\] Fetching pull request #3/);
        const checked = await call(manage, "check_pull_requests", { project: "app" });
        assert.match(checked.content[0].text, /1 open pull request/);
        assert.match((await call(read, "list_pull_requests", { project: "app" })).content[0].text, /#3 A feature \(feat/);

        await env.t.request("/api/v1/w/acme/settings/review-model", {
            method: "PATCH",
            session: env.admin,
            body: { model: "fake/sleep-20" },
        });
        const slow = await call(manage, "start_review", { project: "app", kind: "full" });
        await eventually(
            async () => (await env.t.services.store.jobs.get(slow.structuredContent.id))?.status === "running",
            "the scan to start",
        );
        const cancelled = await call(manage, "cancel_run", { id: slow.structuredContent.id });
        assert.match(cancelled.content[0].text, /Asked .* to stop/);
        const end = await call(read, "wait_for_run", { id: slow.structuredContent.id, seconds: 30 });
        assert.match(end.content[0].text, /cancelled/);
    });

    test("people need operate to start or cancel reviews", async () => {
        await env.t.request("/api/v1/instance/users", {
            method: "POST",
            session: env.admin,
            body: { username: "vic", password: "viewer-password-one" },
        });
        let vic = await env.t.signIn("vic", "viewer-password-one");
        await env.t.request("/api/v1/me/password", {
            method: "POST",
            session: vic,
            body: { current: "viewer-password-one", password: "viewer-password-two" },
        });
        vic = await env.t.signIn("vic", "viewer-password-two");
        await env.t.request("/api/v1/w/acme/settings/members", {
            method: "POST",
            session: env.admin,
            body: { username: "vic", role: "editor" },
        });
        assert.equal(
            (await env.t.request("/api/v1/w/acme/p/app/reviews", { method: "POST", session: vic, body: { kind: "full" } })).status,
            403,
        );
        assert.equal((await env.t.request("/api/v1/w/acme/runs", { session: vic })).status, 200);
        assert.equal(
            (await env.t.request("/api/v1/w/acme/p/app/pull-requests/check", { method: "POST", session: vic, body: {} })).status,
            403,
        );
        void ADMIN_PASSWORD;
    });
});
