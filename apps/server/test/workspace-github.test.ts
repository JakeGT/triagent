// A workspace's GitHub settings: a token it lends its projects (fine-grained or classic, checked with GitHub
// when saved, never shown again), a project's own connection winning over it, and a workspace on its own
// GitHub Enterprise Server (another fake GitHub here), whose address is checked like model URLs are.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { FakeGitHub } from "../../../tests/fakes/github.ts";
import { PAT, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const CLASSIC = `ghp_${"c".repeat(36)}`;

async function workspaceWithProject(env: ReviewEnv, ws: string, repoUrl: string) {
    const ok = (r: { status: number; text: string }, status = 200) => assert.equal(r.status, status, r.text);
    ok(await env.t.request("/api/v1/workspaces", { method: "POST", session: env.admin, body: { slug: ws } }), 201);
    ok(await env.t.request(`/api/v1/w/${ws}/projects`, { method: "POST", session: env.admin, body: { slug: "app", repoUrl } }), 201);
}

describe("a workspace's token, lent to its projects", () => {
    let env: ReviewEnv;
    let manage: string;
    before(async () => {
        env = await reviewEnv();
        await workspaceWithProject(env, "acme", "https://github.com/acme/app");
        env.fake.repo("acme/app");
        manage = (
            await env.t.request("/api/v1/w/acme/settings/tokens", {
                method: "POST",
                session: env.admin,
                body: { name: "m", scope: "manage" },
            })
        ).body.token;
    });
    after(() => env.close());

    const settings = (body?: object) =>
        env.t.request("/api/v1/w/acme/settings/github", body ? { method: "PUT", session: env.admin, body } : { session: env.admin });
    const setToken = (token: string) =>
        env.t.request("/api/v1/w/acme/settings/github/token", { method: "PUT", session: env.admin, body: { token } });
    const check = () => env.t.request("/api/v1/w/acme/p/app/settings/github/test", { method: "POST", session: env.admin, body: {} });

    test("starts on the app, with no token, and nothing lent", async () => {
        const view = await settings();
        assert.equal(view.status, 200, view.text);
        assert.equal(view.body.method, "app");
        assert.equal(view.body.server, null);
        assert.equal(view.body.token.set, false);
        assert.equal((await check()).body.code, "github_not_connected");
    });

    test("tokens are checked: their form, that they aren't an app's short-lived token, and with GitHub", async () => {
        assert.match((await setToken("hunter2")).text, /doesn't look like a GitHub token/);
        assert.match((await setToken(`ghs_${"x".repeat(36)}`)).text, /expires within hours/);
        // Well formed, but GitHub doesn't know it.
        const unknown = await setToken(PAT(7));
        assert.equal(unknown.status, 400);
        assert.match(unknown.text, /turned the token down/);
        assert.equal((await settings()).body.token.set, false);
        // Setting it takes the secrets permission: a manage token configures, but can't.
        env.fake.pat(CLASSIC, "ws-bot", ["acme/app"]);
        const byToken = await env.t.request("/api/v1/w/acme/settings/github/token", {
            method: "PUT",
            token: manage,
            body: { token: CLASSIC },
        });
        assert.equal(byToken.status, 403);
    });

    test("a classic token, once the workspace is set to lend one, connects projects that have none of their own", async () => {
        const set = await setToken(CLASSIC);
        assert.equal(set.status, 200, set.text);
        assert.equal(set.body.kind, "classic");
        assert.equal(set.body.owner, "ws-bot");
        assert.ok(!set.text.includes(CLASSIC));
        // Kept, but not lent while the workspace uses the app.
        assert.equal((await check()).body.code, "github_not_connected");

        const lend = await env.t.request("/api/v1/w/acme/settings/github", {
            method: "PUT",
            token: manage,
            body: { method: "token", server: null },
        });
        assert.equal(lend.status, 200, lend.text);
        assert.equal(lend.body.method, "token");
        const ok = await check();
        assert.equal(ok.status, 200, ok.text);
        assert.equal(ok.body.account, "ws-bot");
        const project = await env.t.request("/api/v1/w/acme/p/app/settings/github", { session: env.admin });
        assert.equal(project.body.mode, "token");
        assert.equal(project.body.tokenFrom, "workspace");
        assert.deepEqual(project.body.workspace.token, { owner: "ws-bot", kind: "classic" });
        assert.ok(!project.text.includes(CLASSIC));
    });

    test("a project's own token wins over the workspace's", async () => {
        const own = PAT(3);
        env.fake.pat(own, "project-bot", ["acme/app"]);
        const set = await env.t.request("/api/v1/w/acme/p/app/settings/github/token", {
            method: "PUT",
            session: env.admin,
            body: { token: own },
        });
        assert.equal(set.status, 200, set.text);
        assert.equal((await check()).body.account, "project-bot");
        assert.equal((await env.t.request("/api/v1/w/acme/p/app/settings/github", { session: env.admin })).body.tokenFrom, "project");
        // Gone, the workspace's is used again.
        await env.t.request("/api/v1/w/acme/p/app/settings/github/token", { method: "DELETE", session: env.admin });
        assert.equal((await check()).body.account, "ws-bot");
    });

    test("a fine-grained token replaces it; clearing it disconnects; changes are audited without the token", async () => {
        const fine = PAT(5);
        env.fake.pat(fine, "fine-bot", ["acme/app"]);
        assert.equal((await setToken(fine)).body.kind, "fine-grained");
        assert.equal((await check()).body.account, "fine-bot");
        const cleared = await env.t.request("/api/v1/w/acme/settings/github/token", { method: "DELETE", session: env.admin });
        assert.equal(cleared.status, 200, cleared.text);
        assert.equal(cleared.body.set, false);
        assert.equal((await check()).body.code, "github_not_connected");
        const workspace = (await env.t.services.store.workspaces.bySlug("acme"))?.id as string;
        const audit = await env.t.services.store.audit.list({ workspaceId: workspace }, { limit: 50 });
        const text = JSON.stringify(audit);
        assert.ok(audit.some((a) => a.target === "workspace:github-token"));
        assert.ok(audit.some((a) => a.target === "github"));
        assert.ok(!text.includes(fine) && !text.includes(CLASSIC));
    });

    test("the app can't be chosen without an instance GitHub App", async () => {
        const r = await settings({ method: "app", server: null });
        assert.equal(r.status, 400);
        assert.match(r.text, /no GitHub App/);
    });
});

describe("a workspace on its own GitHub Enterprise Server", () => {
    let env: ReviewEnv;
    let ghe: FakeGitHub;
    before(async () => {
        ghe = await new FakeGitHub().start();
        env = await reviewEnv({ env: { ALLOW_PRIVATE_GITHUB_URLS: "true" } });
        // The fake Enterprise server is on 127.0.0.1 (stored repository addresses have no port).
        await workspaceWithProject(env, "corp", "https://127.0.0.1/corp/app");
        ghe.repo("corp/app");
    });
    after(async () => {
        await env.close();
        await ghe.stop();
    });

    const settings = (body: object) => env.t.request("/api/v1/w/corp/settings/github", { method: "PUT", session: env.admin, body });

    test("addresses are checked: a server's own address, not the instance's GitHub, and not the app", async () => {
        assert.match((await settings({ method: "token", server: "ftp://ghe.example.com" })).text, /must start https/);
        assert.match((await settings({ method: "token", server: `${ghe.url}/some/path` })).text, /with no path/);
        assert.match((await settings({ method: "token", server: env.fake.url })).text, /this instance's own GitHub/);
        assert.match((await settings({ method: "app", server: ghe.url })).text, /not on a GitHub Enterprise server/);
    });

    test("a token is checked with the workspace's server, which projects then reach, and clone from", async () => {
        assert.equal((await settings({ method: "token", server: ghe.url })).status, 200);
        const token = PAT(9);
        // Known to github.com's fake only: the Enterprise server turns it down.
        env.fake.pat(token, "elsewhere", ["corp/app"]);
        assert.match(
            (await env.t.request("/api/v1/w/corp/settings/github/token", { method: "PUT", session: env.admin, body: { token } })).text,
            /turned the token down/,
        );
        ghe.pat(token, "corp-bot", ["corp/app"]);
        const set = await env.t.request("/api/v1/w/corp/settings/github/token", { method: "PUT", session: env.admin, body: { token } });
        assert.equal(set.status, 200, set.text);
        assert.equal(set.body.owner, "corp-bot");

        const ok = await env.t.request("/api/v1/w/corp/p/app/settings/github/test", { method: "POST", session: env.admin, body: {} });
        assert.equal(ok.status, 200, ok.text);
        assert.equal(ok.body.account, "corp-bot");
        assert.ok(ghe.log.some((l) => l.path.startsWith("/repos/corp/app")));
        const workspace = await env.t.services.store.workspaces.bySlug("corp");
        assert.ok(workspace);
        const project = await env.t.services.projects.get(env.t.services.store, workspace, "app");
        const gh = await env.t.services.github.githubFor(project);
        assert.equal(gh.cloneUrl, `${ghe.url}/corp/app.git`);
        assert.equal((await gh.tokenForJob()).token, token);
        // Blame and the like go to its GraphQL address (/api/graphql on GitHub Enterprise).
        await gh.client.graphql("query { viewer { login } }", {}).catch(() => null);
        assert.ok(ghe.log.some((l) => l.path === "/graphql"));
    });

    test("a project whose repository is on another host isn't reached through the workspace's server", async () => {
        const created = await env.t.request("/api/v1/w/corp/projects", {
            method: "POST",
            session: env.admin,
            body: { slug: "elsewhere", repoUrl: "https://github.com/corp/app" },
        });
        assert.equal(created.status, 201, created.text);
        const r = await env.t.request("/api/v1/w/corp/p/elsewhere/settings/github/test", { method: "POST", session: env.admin, body: {} });
        assert.equal(r.body.code, "github_not_connected");
        assert.match(r.text, /repository is on github\.com, but the workspace's GitHub is/);
    });

    test("moving the server takes permission to manage secrets, and forgets the workspace's token rather than send it there", async () => {
        const manage = (
            await env.t.request("/api/v1/w/corp/settings/tokens", {
                method: "POST",
                session: env.admin,
                body: { name: "m", scope: "manage" },
            })
        ).body.token;
        const byToken = await env.t.request("/api/v1/w/corp/settings/github", {
            method: "PUT",
            token: manage,
            body: { method: "token", server: "https://elsewhere.example.com" },
        });
        assert.equal(byToken.status, 403);
        assert.match(byToken.text, /permission to manage secrets/);
        // The method alone it may change.
        assert.equal(
            (
                await env.t.request("/api/v1/w/corp/settings/github", {
                    method: "PUT",
                    token: manage,
                    body: { method: "token", server: ghe.url },
                })
            ).status,
            200,
        );
        const before = ghe.log.length;
        const moved = await settings({ method: "token", server: null });
        assert.equal(moved.status, 200, moved.text);
        assert.equal(moved.body.token.set, false);
        assert.equal(moved.body.token.owner, null);
        // Nothing was sent to either server to check it.
        assert.equal(ghe.log.length, before);
        assert.ok(!env.fake.log.some((l) => l.path === "/user"));
    });
});

describe("without ALLOW_PRIVATE_GITHUB_URLS", () => {
    let env: ReviewEnv;
    before(async () => {
        env = await reviewEnv({ lookup: async () => [{ address: "10.1.2.3", family: 4 }] });
        await workspaceWithProject(env, "corp", "https://ghe.example.com/corp/app");
    });
    after(() => env.close());

    test("an Enterprise address that resolves to a private network is refused, naming the setting that allows it", async () => {
        const r = await env.t.request("/api/v1/w/corp/settings/github", {
            method: "PUT",
            session: env.admin,
            body: { method: "token", server: "https://ghe.example.com" },
        });
        assert.equal(r.status, 400);
        assert.match(r.text, /private or loopback address/);
        assert.match(r.text, /ALLOW_PRIVATE_GITHUB_URLS=true/);
    });
});
