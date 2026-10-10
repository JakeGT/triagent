// Choosing a review's models. The first rule that says wins: the run's own choice, then the project's set
// for that kind of review, then the project's set, then the workspace's default. Sets are ids of the
// workspace's favourite models, or "instance" for the instance's model paid from an allowance. Projects'
// lists from before favourites become sets of favourites when they're read; a favourite projects use
// can't be removed without saying so; and tokens choose models only where they could start a review.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Actor } from "../src/services/core.ts";
import type { RunModel } from "../src/services/models.ts";
import { type RunnerHello, specForBranch } from "../src/services/runs.ts";
import type { Job, JobKind, Project, Workspace } from "../src/store/types.ts";
import { finished, PAT, patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const ADMIN: Actor = { name: "admin", userId: null, via: "web" };
const runner = (id: string): RunnerHello => ({ id: `runner-${id}-0000`, name: id, version: "1", slots: 1 });
const fakeKey = () => `sk-${randomBytes(16).toString("hex")}`;

let env: ReviewEnv;
let n = 0;

before(async () => {
    env = await reviewEnv({ env: { REVIEW_CONCURRENCY: "10", REVIEW_CONCURRENCY_PER_WORKSPACE: "10" } });
});
after(() => env.close());

interface Place {
    ws: string;
    w: Workspace;
    p: Project;
    /** The default favourite: OpenRouter's fake/model. */
    usual: string;
}

/** A workspace with a project on GitHub and (unless `key` is false) an OpenRouter key, whose fake/model is the default. */
async function place(opts: { key?: boolean } = {}): Promise<Place> {
    const ws = `models-${++n}`;
    await patProject(env, ws, { repo: `${ws}/app`, token: PAT(n), ...opts });
    const w = (await env.t.services.store.workspaces.bySlug(ws)) as Workspace;
    const p = (await env.t.services.store.projects.bySlug(w.id, "app")) as Project;
    return { ws, w, p, usual: (await env.t.services.settings.favourites(w)).defaultId as string };
}

const ok = (r: { status: number; text: string }, status = 200) => assert.equal(r.status, status, r.text);

async function favourite(at: Place, model: string, extra: { provider?: string; name?: string } = {}): Promise<string> {
    const provider = extra.provider ?? "openrouter";
    const r = await env.t.request(`/api/v1/w/${at.ws}/settings/models/favourites`, {
        method: "POST",
        session: env.admin,
        body: { provider, model, ...(extra.name ? { name: extra.name } : {}) },
    });
    ok(r, 201);
    return r.body.favourites.find((f: { provider: string; model: string }) => f.provider === provider && f.model === model).id;
}

const setModels = (at: Place, models: object) =>
    env.t.request(`/api/v1/w/${at.ws}/p/app/settings/automation`, { method: "PATCH", session: env.admin, body: { models } });
const removeFavourite = (at: Place, id: string, query = "") =>
    env.t.request(`/api/v1/w/${at.ws}/settings/models/favourites/${id}${query}`, { method: "DELETE", session: env.admin });

/** What a review would run with: its models' names in order, or why it can't run. */
async function uses(at: Place, kind: JobKind | null, requested: string[] | null = null): Promise<string[] | string> {
    const r = await env.t.services.models.forProject(at.w, at.p, kind, requested);
    return r.ready ? r.models.map((m) => m.model) : r.reason;
}

describe("which models a review uses", () => {
    test("the run's choice, then the project's for that kind of review, then the project's, then the workspace's default", async () => {
        const at = await place();
        const a = await favourite(at, "fake/a");
        const b = await favourite(at, "fake/b");
        const c = await favourite(at, "fake/c");
        const all = async (requested: string[] | null = null) => [
            await uses(at, "pr", requested),
            await uses(at, "changes", requested),
            await uses(at, "full", requested),
        ];

        // Nothing chosen anywhere: the default, alone, known by its id.
        assert.deepEqual(await all(), [["fake/model"], ["fake/model"], ["fake/model"]]);
        const usual = await env.t.services.models.forProject(at.w, at.p, "pr");
        assert.equal(usual.ready && usual.models[0]?.id, at.usual);

        // The project's set, for every kind.
        ok(await setModels(at, { all: [a] }));
        assert.deepEqual(await all(), [["fake/a"], ["fake/a"], ["fake/a"]]);

        // A kind's own set wins over the project's, in the order given; the other kinds keep the project's.
        ok(await setModels(at, { all: [a], pr: [b], full: [c, a] }));
        assert.deepEqual(await all(), [["fake/b"], ["fake/a"], ["fake/c", "fake/a"]]);
        // Asked about the project's reviews in general (no kind): the project's set.
        assert.deepEqual(await uses(at, null), ["fake/a"]);

        // A kind's set with no project set: the others fall through to the default.
        ok(await setModels(at, { pr: [b], changes: [] }));
        assert.deepEqual(await all(), [["fake/b"], ["fake/model"], ["fake/model"]]);
        assert.deepEqual(
            (await env.t.services.settings.automation(env.t.services.store, at.p)).models,
            { pr: [b] },
            "an empty set isn't kept",
        );

        // The run's own choice wins over all of them; an empty choice is no choice.
        ok(await setModels(at, { all: [a], pr: [b] }));
        assert.deepEqual(await all([c, b]), [
            ["fake/c", "fake/b"],
            ["fake/c", "fake/b"],
            ["fake/c", "fake/b"],
        ]);
        assert.deepEqual(await all([]), [["fake/b"], ["fake/a"], ["fake/a"]]);

        // The list for pickers says the same, and which rule decided.
        const list = (await env.t.request(`/api/v1/w/${at.ws}/models?project=app`, { session: env.admin })).body;
        assert.deepEqual(list.rules, {
            pr: { ids: [b], from: "kind" },
            changes: { ids: [a], from: "project" },
            full: { ids: [a], from: "project" },
        });
        ok(await setModels(at, {}));
        const plain = (await env.t.request(`/api/v1/w/${at.ws}/models?project=app`, { session: env.admin })).body;
        assert.deepEqual(plain.rules.full, { ids: [at.usual], from: "default" });
        assert.deepEqual([plain.defaultId, plain.fallback, plain.instance, plain.max], [at.usual, [at.usual], null, 5]);
        assert.deepEqual(
            plain.favourites.map((f: { model: string; isDefault: boolean; ready: boolean }) => [f.model, f.isDefault, f.ready]),
            [
                ["fake/model", true, true],
                ["fake/a", false, true],
                ["fake/b", false, true],
                ["fake/c", false, true],
            ],
        );
        assert.equal(JSON.stringify(plain).includes("sk-or-"), false, "never a key");
    });

    test("a set takes the workspace's favourites, each once, five at most", async () => {
        const at = await place();
        const other = await place();
        const theirs = await favourite(other, "fake/theirs");
        const a = await favourite(at, "fake/a");
        const refused = async (models: object, why: RegExp) => {
            const r = await setModels(at, models);
            assert.equal(r.status, 400, r.text);
            assert.match(r.text, why);
        };
        await refused({ all: [theirs] }, /isn't one of this workspace's favourite models/);
        await refused({ pr: [a, a] }, /only be chosen once/);
        const five = [a, at.usual, await favourite(at, "fake/b"), await favourite(at, "fake/c"), await favourite(at, "fake/d")];
        await refused({ full: [...five, await favourite(at, "fake/e")] }, /models\.full/);
        ok(await setModels(at, { full: five }));
        await refused({ all: ["instance"] }, /no allowance on the instance's key/);
        await refused({ nightly: [a] }, /models/);
        await refused([{ provider: "openrouter", model: "fake/a" }], /models/);
        // The same favourite in two sets is fine: they're different rules.
        ok(await setModels(at, { all: [a], pr: [a, at.usual] }));
    });

    test("a favourite that isn't ready keeps the review waiting, naming it; labels are nicknames, kept on the job", async () => {
        const at = await place();
        const fast = await favourite(at, "fake/a", { name: "Fast" });
        const claude = await favourite(at, "claude-test", { provider: "anthropic", name: "Careful" });
        ok(await setModels(at, { full: [fast, claude] }));
        assert.match(
            (await uses(at, "full")) as string,
            /^Add an Anthropic API key in Settings → Models: this project's reviews use Careful\. Or take it out/,
        );
        assert.match(
            (await uses(at, "pr", [claude])) as string,
            /this review was asked to use Careful\. Or cancel it and start it with another model\.$/,
        );
        assert.deepEqual(await uses(at, "pr"), ["fake/model"], "other kinds of review aren't held up");

        const runs = env.t.services.runs;
        const queued = await runs.enqueue(ADMIN, at.p, specForBranch("full", "main", null));
        assert.equal(await runs.claim(runner("wait")), null);
        const list = await runs.list(at.w, { projectId: at.p.id });
        assert.match(list.queued[0]?.waiting ?? "", /this project's reviews use Careful/);
        assert.equal(list.ready, true, "the project's other reviews can start");

        // With its key, it starts: the job records what it ran with, as it was then.
        ok(
            await env.t.request(`/api/v1/w/${at.ws}/settings/review-model/keys/anthropic`, {
                method: "PUT",
                session: env.admin,
                body: { key: fakeKey() },
            }),
        );
        const claimed = await runs.claim(runner("wait"));
        assert.deepEqual(
            claimed?.models.map((m) => [m.label, m.model, m.provider]),
            [
                ["Fast", "fake/a", "openrouter"],
                ["Careful", "claude-test", "anthropic"],
            ],
        );
        ok(
            await env.t.request(`/api/v1/w/${at.ws}/settings/models/favourites/${fast}`, {
                method: "PATCH",
                session: env.admin,
                body: { name: "Quick", model: "fake/renamed" },
            }),
        );
        const job = (await env.t.services.store.jobs.get(queued.id)) as Job;
        assert.deepEqual(job.model?.models, [
            { id: fast, provider: "openrouter", model: "fake/a", label: "Fast", keySource: "workspace", budget: null },
            { id: claude, provider: "anthropic", model: "claude-test", label: "Careful", keySource: "workspace", budget: null },
        ]);
        assert.deepEqual([job.model?.id, job.model?.label, job.requestedModels], [fast, "Fast", null]);
        await runs.finish(runner("wait"), queued.id, { status: "cancelled" });
    });

    test("a review asked to use a favourite that's since been removed fails, saying so, rather than waiting for ever", async () => {
        const at = await place();
        const a = await favourite(at, "fake/a");
        const runs = env.t.services.runs;
        const gone = await runs.enqueue(ADMIN, at.p, specForBranch("full", "gone", null), [at.usual, a]);
        const fine = await runs.enqueue(ADMIN, at.p, specForBranch("full", "fine", null), [at.usual]);
        // A run's own choice isn't a project using the favourite: it can be removed.
        ok(await removeFavourite(at, a));
        const claimed = await runs.claim(runner("gone"));
        assert.equal(claimed?.id, fine.id, "the next review in the queue starts instead");
        const failed = (await env.t.services.store.jobs.get(gone.id)) as Job;
        assert.equal(failed.status, "failed");
        assert.match(failed.error ?? "", /asked to use a favourite model that has since been removed\. Start it again/);
        assert.equal(failed.startedAt, null);
        await runs.finish(runner("gone"), fine.id, { status: "cancelled" });
    });
});

describe("the instance's model, as one more model to choose", () => {
    const instanceKey = fakeKey();
    before(async () => {
        await env.t.services.allowances.setKey(ADMIN, "openrouter", instanceKey);
        await env.t.services.allowances.setModel(ADMIN, { provider: "openrouter", model: "fake/instance" });
    });

    test("only with an allowance; alone or with favourites; the allowance covers that model only", async () => {
        const at = await place();
        const a = await favourite(at, "fake/a");
        const start = (models: string[]) =>
            env.t.request(`/api/v1/w/${at.ws}/p/app/reviews`, { method: "POST", session: env.admin, body: { kind: "full", models } });
        await env.fake.gitRepo(`${at.ws}/app`, { "src/a.ts": "a\n" });

        // No allowance: it isn't offered, and can't be chosen.
        assert.equal((await env.t.request(`/api/v1/w/${at.ws}/models`, { session: env.admin })).body.instance, null);
        const refused = await start(["instance"]);
        assert.equal(refused.status, 400);
        assert.match(refused.text, /no allowance on the instance's key/);

        await env.t.services.allowances.setGrant(ADMIN, at.w.id, 50_000);
        const list = (await env.t.request(`/api/v1/w/${at.ws}/models`, { session: env.admin })).body;
        assert.deepEqual(list.instance, {
            id: "instance",
            provider: "openrouter",
            providerName: "OpenRouter",
            model: "fake/instance",
            name: "Instance model",
            ready: true,
            reason: null,
        });
        assert.deepEqual(list.fallback, [at.usual], "the workspace's own default still comes first");

        // Alone, and in a project's set with a favourite.
        assert.deepEqual(await uses(at, "pr", ["instance"]), ["fake/instance"]);
        ok(await setModels(at, { full: ["instance", a] }));
        const chosen = await env.t.services.models.forProject(at.w, at.p, "full");
        assert.ok(chosen.ready);
        assert.deepEqual(
            chosen.models.map((m) => [m.id, m.model, m.keySource, m.allowance?.remaining ?? null, m.apiKey === instanceKey]),
            [
                ["instance", "fake/instance", "instance", 50_000, true],
                [a, "fake/a", "workspace", null, false],
            ],
        );

        // The job: the instance's model is given what's left of the allowance; the favourite, the project's budget (none).
        const runs = env.t.services.runs;
        const queued = await runs.enqueue(ADMIN, at.p, specForBranch("full", "main", null));
        const claimed = await runs.claim(runner("inst"));
        assert.deepEqual(
            claimed?.models.map((m) => [m.model, m.maxTokensBudget]),
            [
                ["fake/instance", 50_000],
                ["fake/a", undefined],
            ],
        );
        assert.equal(claimed?.maxTokensBudget, 50_000, "a runner that knows one budget only gets the tighter one");
        const job = (await env.t.services.store.jobs.get(queued.id)) as Job;
        assert.deepEqual(
            job.model?.models?.map((m) => [m.id, m.keySource, m.budget]),
            [
                ["instance", "instance", 50_000],
                [a, "workspace", null],
            ],
        );
        // While it runs, its budget is set aside: another review can't use the instance's model, and says why.
        assert.match(
            (await uses(at, "pr", ["instance"])) as string,
            /^Less than 10,000 tokens .* This review was asked to use the instance's model\.$/,
        );
        assert.deepEqual(await uses(at, "pr"), ["fake/model"], "reviews with the workspace's own models carry on");

        // Each model's record says whose key paid; only the instance's counts against the allowance.
        await runs.finish(runner("inst"), queued.id, {
            status: "done",
            parts: [
                { status: "done", report: { comments: [], summary: { total_tokens: 4_000 } } },
                { status: "done", report: { comments: [], summary: { total_tokens: 9_000 } } },
            ],
        });
        const history = (await env.t.services.history.list({ workspaceId: at.w.id })).filter((h) => h.details.scan?.id === queued.id);
        assert.deepEqual(history.map((h) => [h.model, h.keySource, h.tokens?.total]).sort(), [
            ["fake/a", "workspace", 9_000],
            ["fake/instance", "instance", 4_000],
        ]);
        const left = (await env.t.services.models.forProject(at.w, at.p, "pr", ["instance"])) as { models: RunModel[] };
        assert.equal(left.models[0]?.allowance?.remaining, 46_000);

        // Used up: reviews that chose it wait, saying so; taking the allowance away says that instead.
        await env.t.services.allowances.setGrant(ADMIN, at.w.id, 4_000);
        assert.match(
            (await uses(at, "full")) as string,
            /allowance of 4,000 tokens is used up.* This project's reviews use the instance's model\.$/,
        );
        await env.t.services.allowances.removeGrant(ADMIN, at.w.id);
        assert.match(
            (await uses(at, "full")) as string,
            /no allowance on the instance's key now.*Choose another in the project's review settings/,
        );
        // Its settings can still be saved as they are, but the instance's model can't be put anywhere new.
        ok(await setModels(at, { full: ["instance", a] }));
        assert.equal((await setModels(at, { full: ["instance", a], pr: ["instance"] })).status, 400);
    });

    test("an instance-key model that ends without a word is charged its whole budget; one that never had its turn isn't", async () => {
        const at = await place();
        const a = await favourite(at, "fake/a");
        await env.t.services.allowances.setGrant(ADMIN, at.w.id, 100_000);
        await env.t.services.settings.setAutomation(ADMIN, at.p, { maxTokensBudget: 20_000 });
        const runs = env.t.services.runs;
        const used = async () => (await env.t.services.allowances.usage(at.w)).used;

        const silent = await runs.enqueue(ADMIN, at.p, specForBranch("full", "silent", null), [a, "instance"]);
        const claimed = await runs.claim(runner("silent"));
        assert.deepEqual(
            claimed?.models.map((m) => m.maxTokensBudget),
            [undefined, 20_000],
        );
        assert.equal(claimed?.maxTokensBudget, 20_000);
        await runs.finish(runner("silent"), silent.id, {
            status: "failed",
            parts: [
                { status: "done", report: { comments: [], summary: { total_tokens: 500 } } },
                { status: "failed", error: "It fell over." },
            ],
        });
        assert.equal(await used(), 20_000);
        assert.equal(((await env.t.services.store.jobs.get(silent.id)) as Job).result?.estimatedTokens, true);

        const stopped = await runs.enqueue(ADMIN, at.p, specForBranch("full", "stopped", null), [a, "instance"]);
        await runs.claim(runner("stopped"));
        await runs.finish(runner("stopped"), stopped.id, { status: "cancelled", parts: [{ status: "cancelled" }] });
        assert.equal(await used(), 20_000, "cancelled before the instance's model started");
    });

    test("a workspace with an allowance and no key of its own falls back on the instance's model, as before", async () => {
        const at = await place({ key: false });
        await env.t.services.allowances.setGrant(ADMIN, at.w.id, 50_000);
        const list = (await env.t.request(`/api/v1/w/${at.ws}/models?project=app`, { session: env.admin })).body;
        assert.deepEqual([list.fallback, list.rules.pr], [["instance"], { ids: ["instance"], from: "default" }]);
        const chosen = await env.t.services.models.forProject(at.w, at.p, "pr");
        assert.deepEqual(chosen.ready && chosen.models.map((m) => [m.id, m.keySource]), [["instance", "instance"]]);
    });
});

describe("projects' lists from before favourites", () => {
    const old = (at: Place, models: unknown) =>
        env.t.services.store.settings.put({
            workspaceId: at.w.id,
            projectId: at.p.id,
            key: "automation",
            value: { enabled: true, pollMinutes: 7, models },
        });
    const stored = async (at: Place) =>
        (await env.t.services.store.settings.get(at.w.id, at.p.id, "automation"))?.value as { models: unknown; pollMinutes: number };
    const read = async (at: Place) => (await env.t.request(`/api/v1/w/${at.ws}/p/app/settings/automation`, { session: env.admin })).body;
    const favourites = async (at: Place) =>
        (await env.t.services.settings.favourites(at.w)).favourites.map((f) => [f.provider, f.model, f.isDefault]);

    test("each model becomes the favourite it is, or a new one, once; the list becomes the project's set", async () => {
        const at = await place();
        const other = await place();
        const list = [
            { provider: "openrouter", model: "fake/model" },
            { provider: "mistral", model: "codestral-latest" },
            { provider: "nope", model: "x" },
            { provider: "mistral", model: "codestral-latest" },
        ];
        await old(at, list);
        await old(other, [{ provider: "mistral", model: "codestral-latest" }]);

        // Read by two requests at once, and by a review being scheduled: the same answer each time.
        const [first, second] = await Promise.all([read(at), read(at)]);
        assert.deepEqual(first, second);
        const [usual, added] = first.models.all as [string, string];
        assert.equal(usual, at.usual, "the model that was a favourite already keeps its id");
        assert.deepEqual(Object.keys(first.models), ["all"]);
        assert.deepEqual([first.enabled, first.pollMinutes], [true, 7], "the other settings are as they were");
        assert.deepEqual(await favourites(at), [
            ["openrouter", "fake/model", true],
            ["mistral", "codestral-latest", false],
        ]);
        assert.deepEqual((await stored(at)).models, { all: [usual, added] }, "saved in the new shape");
        assert.deepEqual((await read(at)).models, { all: [usual, added] });
        assert.equal((await favourites(at)).length, 2, "reading again adds nothing");

        // Reviews run with what they ran with before, and the new favourite is one like any other.
        assert.match(
            (await uses(at, "pr")) as string,
            /Add a Mistral API key in Settings → Models: this project's reviews use codestral-latest/,
        );
        ok(
            await env.t.request(`/api/v1/w/${at.ws}/settings/review-model/keys/mistral`, {
                method: "PUT",
                session: env.admin,
                body: { key: fakeKey() },
            }),
        );
        assert.deepEqual(await uses(at, "pr"), ["fake/model", "codestral-latest"]);
        // Another workspace's project gets a favourite of its own.
        assert.notEqual(((await read(other)).models.all as string[])[0], added);
    });

    test("an empty list is no choice, and nothing is written until the settings are next saved", async () => {
        const at = await place();
        await old(at, []);
        assert.deepEqual((await read(at)).models, {});
        assert.deepEqual((await stored(at)).models, []);
        assert.deepEqual(await uses(at, "full"), ["fake/model"]);
        ok(
            await env.t.request(`/api/v1/w/${at.ws}/p/app/settings/automation`, {
                method: "PATCH",
                session: env.admin,
                body: { pollMinutes: 3 },
            }),
        );
        assert.deepEqual(await stored(at), { ...(await read(at)), pollMinutes: 3, models: {} });
    });

    test("a list read for the first time when its review is scheduled", async () => {
        const at = await place();
        await old(at, [
            { provider: "openrouter", model: "fake/b" },
            { provider: "openrouter", model: "fake/model" },
        ]);
        const runs = env.t.services.runs;
        const queued = await runs.enqueue(ADMIN, at.p, specForBranch("full", "main", null));
        const claimed = await runs.claim(runner("old"));
        assert.deepEqual(
            claimed?.models.map((m) => m.model),
            ["fake/b", "fake/model"],
        );
        assert.deepEqual(await favourites(at), [
            ["openrouter", "fake/model", true],
            ["openrouter", "fake/b", false],
        ]);
        await runs.finish(runner("old"), queued.id, { status: "cancelled" });
    });
});

describe("removing a favourite that projects use", () => {
    test("refused, naming the projects and their sets; with force, it's taken out of them too", async () => {
        const at = await place();
        const a = await favourite(at, "fake/a");
        const b = await favourite(at, "fake/b");
        ok(
            await env.t.request(`/api/v1/w/${at.ws}/projects`, {
                method: "POST",
                session: env.admin,
                body: { slug: "second", name: "Second" },
            }),
            201,
        );
        ok(await env.t.request(`/api/v1/w/${at.ws}/projects`, { method: "POST", session: env.admin, body: { slug: "third" } }), 201);
        ok(await setModels(at, { all: [a, b], pr: [a] }));
        ok(
            await env.t.request(`/api/v1/w/${at.ws}/p/second/settings/automation`, {
                method: "PATCH",
                session: env.admin,
                body: { models: { full: [b, a] } },
            }),
        );

        const refused = await removeFavourite(at, a);
        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.body.code, "favourite_in_use");
        assert.match(refused.body.error, /^2 projects' reviews use this model\. Remove it from them too with force=true/);
        assert.deepEqual(refused.body.projects, [
            { slug: "app", name: "app", sets: ["all", "pr"] },
            { slug: "second", name: "Second", sets: ["full"] },
        ]);
        assert.equal((await env.t.services.settings.favourites(at.w)).favourites.length, 3, "nothing was removed");
        assert.equal((await removeFavourite(at, a, "?force=false")).status, 409);

        const forced = await removeFavourite(at, a, "?force=true");
        ok(forced);
        assert.deepEqual(
            forced.body.favourites.map((f: { id: string }) => f.id),
            [at.usual, b],
        );
        // A set left empty is gone, so that kind of review falls through to the project's set.
        assert.deepEqual((await env.t.services.settings.automation(env.t.services.store, at.p)).models, { all: [b] });
        assert.deepEqual(await uses(at, "pr"), ["fake/b"]);
        const second = (await env.t.services.store.projects.bySlug(at.w.id, "second")) as Project;
        assert.deepEqual((await env.t.services.settings.automation(env.t.services.store, second)).models, { full: [b] });
        const audit = (await env.t.request(`/api/v1/w/${at.ws}/settings/audit?limit=5`, { session: env.admin })).body.items;
        assert.ok(
            audit.some(
                (x: { target: string; changes: { models?: { to: unknown } } }) =>
                    x.target === "project:second:automation" && x.changes.models,
            ),
            "each project's change is in the audit log",
        );

        // Forcing still can't remove the default without naming the next one: nothing changes, in the projects either.
        ok(await setModels(at, { all: [at.usual, b] }));
        const isDefault = await removeFavourite(at, at.usual, "?force=true");
        assert.equal(isDefault.status, 400);
        assert.deepEqual((await env.t.services.settings.automation(env.t.services.store, at.p)).models, { all: [at.usual, b] });
        ok(await removeFavourite(at, at.usual, `?force=true&defaultId=${b}`));
        assert.deepEqual((await env.t.services.settings.automation(env.t.services.store, at.p)).models, { all: [b] });
        // One nothing uses goes without being asked twice.
        const c = await favourite(at, "fake/c");
        ok(await removeFavourite(at, c));
    });
});

describe("choosing models over the API and MCP", () => {
    let at: Place;
    let a: string;
    let wordy: string;
    let manage: string;
    let read: string;
    let viewer: Awaited<ReturnType<ReviewEnv["t"]["signIn"]>>;
    const token = async (name: string, scope: string) =>
        (await env.t.request(`/api/v1/w/${at.ws}/settings/tokens`, { method: "POST", session: env.admin, body: { name, scope } })).body
            .token as string;
    const call = async (bearer: string, name: string, args: object) =>
        (
            await env.t.request("/mcp", {
                method: "POST",
                token: bearer,
                body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
            })
        ).body.result;
    const tools = async (bearer: string) =>
        (
            await env.t.request("/mcp", { method: "POST", token: bearer, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })
        ).body.result.tools.map((x: { name: string }) => x.name) as string[];

    before(async () => {
        at = await place();
        a = await favourite(at, "fake/model-a", { name: "Fast" });
        wordy = await favourite(at, "fake/wordy-extra");
        await env.fake.gitRepo(`${at.ws}/app`, { "src/a.ts": "export const a = 1;\n", "README.md": "# App\n" });
        manage = await token("agent", "manage");
        read = await token("reader", "read");
        const password = `pw-${randomBytes(12).toString("hex")}`;
        ok(
            await env.t.request("/api/v1/instance/users", { method: "POST", session: env.admin, body: { username: "vera", password } }),
            201,
        );
        ok(
            await env.t.request(`/api/v1/w/${at.ws}/settings/members`, {
                method: "POST",
                session: env.admin,
                body: { username: "vera", role: "viewer" },
            }),
            201,
        );
        // A new account sets a password of its own before anything else.
        const first = await env.t.signIn("vera", password);
        const own = `pw-${randomBytes(12).toString("hex")}`;
        ok(await env.t.request("/api/v1/me/password", { method: "POST", session: first, body: { current: password, password: own } }));
        viewer = await env.t.signIn("vera", own);
        env.runner();
    });

    test("anyone who can read sees the models; choosing them needs what starting a review needs", async () => {
        for (const who of [{ session: viewer }, { token: read }, { token: manage }]) {
            const list = await env.t.request(`/api/v1/w/${at.ws}/models?project=app`, who);
            ok(list);
            assert.deepEqual(
                list.body.favourites.map((f: { id: string }) => f.id),
                [at.usual, a, wordy],
            );
            assert.deepEqual(list.body.rules.pr, { ids: [at.usual], from: "default" });
        }
        assert.equal((await env.t.request(`/api/v1/w/${at.ws}/models`, {})).status, 401);
        const body = { kind: "full", models: [a] };
        assert.equal((await env.t.request(`/api/v1/w/${at.ws}/p/app/reviews`, { method: "POST", session: viewer, body })).status, 403);
        assert.equal((await env.t.request(`/api/v1/w/${at.ws}/p/app/reviews`, { method: "POST", token: read, body })).status, 403);
        for (const scope of ["write", "upload", "full"])
            assert.equal(
                (await env.t.request(`/api/v1/w/${at.ws}/p/app/reviews`, { method: "POST", token: await token(scope, scope), body }))
                    .status,
                403,
                scope,
            );
        assert.ok((await tools(read)).includes("list_models"));
        assert.ok(!(await tools(read)).includes("start_review"));
        assert.deepEqual((await env.t.services.runs.list(at.w)).counts, { running: 0, queued: 0 }, "nothing was queued");
    });

    test("POST …/reviews with models: checked, kept on the run, and what it runs with", async () => {
        const start = (models: unknown, who: object = { session: env.admin }) =>
            env.t.request(`/api/v1/w/${at.ws}/p/app/reviews`, { method: "POST", body: { kind: "full", branch: "main", models }, ...who });
        for (const [models, why] of [
            [["nope"], /isn't one of this workspace's favourite models/],
            [[a, a], /only be chosen once/],
            [[a, wordy, at.usual, a, wordy, at.usual], /models/],
            ["fake/model-a", /models/],
        ] as const) {
            const r = await start(models);
            assert.equal(r.status, 400, r.text);
            assert.match(r.text, why);
        }

        // A token that can start reviews chooses models like a person does.
        const queued = await start([wordy, a], { token: manage });
        ok(queued, 201);
        assert.deepEqual(queued.body.requestedModels, [wordy, a]);
        const run = await finished(env, at.ws, queued.body.id);
        assert.equal(run.status, "done", run.error);
        assert.deepEqual(run.requestedModels, [wordy, a]);
        assert.deepEqual(
            run.model.models.map((m: { id: string; label: string; model: string }) => [m.id, m.label, m.model]),
            [
                [wordy, "fake/wordy-extra", "fake/wordy-extra"],
                [a, "Fast", "fake/model-a"],
            ],
        );
        assert.deepEqual(
            run.result.models.map((m: { label: string; status: string }) => [m.label, m.status]),
            [
                ["fake/wordy-extra", "done"],
                ["Fast", "done"],
            ],
        );
        const issues = (await env.t.request(`/api/v1/w/${at.ws}/p/app/issues?branch=main&sort=agreement`, { session: env.admin })).body;
        assert.deepEqual(issues.items[0].foundBy, ["fake/wordy-extra", "Fast"]);

        // Without models, the project's rule: here the default, alone, with its favourite's id on the run.
        const plain = await finished(env, at.ws, (await start(undefined)).body.id);
        assert.deepEqual(
            [plain.requestedModels, plain.model.id, plain.model.label, plain.model.models],
            [null, at.usual, "fake/model", undefined],
        );
    });

    test("MCP: list_models says what there is and what a project uses; start_review takes models", async () => {
        ok(await setModels(at, { pr: [a, wordy] }));
        const listed = await call(read, "list_models", { project: "app" });
        const text = listed.content[0].text as string;
        assert.ok(text.includes(`- ${at.usual}: fake/model via OpenRouter [default]`), text);
        assert.ok(text.includes(`- ${a}: Fast (fake/model-a) via OpenRouter`), text);
        assert.ok(text.includes("app pr reviews use: Fast, fake/wordy-extra"), text);
        assert.ok(text.includes("app full reviews use: fake/model"), text);
        assert.deepEqual(listed.structuredContent.rules.pr, { ids: [a, wordy], from: "kind" });
        ok(await setModels(at, {}));

        assert.equal((await call(read, "start_review", { project: "app", kind: "full", models: [a] })).isError, true);
        const bad = await call(manage, "start_review", { project: "app", kind: "full", models: ["nope"] });
        assert.equal(bad.isError, true);
        assert.match(bad.content[0].text, /isn't one of this workspace's favourite models/);
        const started = await call(manage, "start_review", { project: "app", kind: "full", models: [a] });
        assert.equal(started.isError ?? false, false, JSON.stringify(started));
        const run = await finished(env, at.ws, started.structuredContent.id);
        assert.deepEqual([run.status, run.requestedModels, run.model.id, run.model.label], ["done", [a], a, "Fast"]);
        assert.equal(run.model.models, undefined, "one model: no list");
    });
});
