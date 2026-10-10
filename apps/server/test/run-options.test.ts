// Options for reviews run with several models (packages/shared/src/run-options.ts): each is off unless
// chosen for a run or by its project, and a review with one model has none.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { NO_OPTIONS, type RunOptions } from "@triagent/shared";
import { candidatePairs, groupFindings, joinGroups } from "@triagent/shared/merge";
import { effectiveOptions } from "../src/services/runs.ts";
import { patProject, type ReviewEnv, reviewEnv } from "./review-helpers.ts";

const on = (change: Partial<RunOptions>): RunOptions => ({ ...structuredClone(NO_OPTIONS), ...change });

describe("which findings are the same, as the server and the runner both work it out", () => {
    const f = (path: string, line: number | null, category = "bug") => ({
        path,
        category,
        content: "x",
        ...(line === null ? {} : { start_line: line, end_line: line }),
    });

    test("findings are grouped by place, named by the model's place and the finding's", () => {
        const parts = [[f("x.ts", 10), f("y.ts", 1)], null, [f("x.ts", 12), "not a finding", f("x.ts", 30)]];
        assert.deepEqual(groupFindings(parts), [
            [
                { part: 0, index: 0 },
                { part: 2, index: 0 },
            ],
            [{ part: 0, index: 1 }],
            [{ part: 2, index: 2 }],
        ]);
    });

    test("pairs to ask about: groups in the same file with no model in both, the closest first, up to a limit", () => {
        const parts = [
            [f("x.ts", 10), f("x.ts", 100), f("y.ts", 1)],
            [f("x.ts", 60, "security"), f("x.ts", 11, "style"), f("z.ts", 1), f("x.ts", null)],
        ];
        const { pairs, total } = candidatePairs(parts);
        // Never two findings of one model, and never across files.
        assert.equal(total, 6);
        assert.deepEqual(pairs.slice(0, 2), [
            { a: { part: 0, index: 0 }, b: { part: 1, index: 1 } },
            { a: { part: 0, index: 1 }, b: { part: 1, index: 0 } },
        ]);
        assert.ok(pairs.every((p) => p.a.part !== p.b.part));
        // A finding without lines is asked about last.
        assert.deepEqual(pairs.at(-1)?.b, { part: 1, index: 3 });
        assert.deepEqual(candidatePairs(parts, 2), { pairs: pairs.slice(0, 2), total: 6 });
        // What the lines and category already made one finding isn't asked about.
        assert.deepEqual(candidatePairs([[f("x.ts", 10)], [f("x.ts", 11)]]), { pairs: [], total: 0 });
    });

    test("groups a model said are the same are joined, unless a model would then be in one twice", () => {
        const parts = [[f("x.ts", 10), f("x.ts", 50)], [f("x.ts", 30, "style")], [f("x.ts", 52, "security")]];
        const groups = groupFindings(parts);
        assert.equal(groups.length, 4);
        const a0 = { part: 0, index: 0 };
        const a1 = { part: 0, index: 1 };
        const b0 = { part: 1, index: 0 };
        const c0 = { part: 2, index: 0 };
        assert.deepEqual(
            joinGroups(groups, [
                { a: a1, b: c0 },
                { a: a0, b: b0 },
            ]),
            [
                [a0, b0],
                [a1, c0],
            ],
        );
        // The second would put the first model's two findings in one group: it's left out.
        assert.deepEqual(
            joinGroups(groups, [
                { a: a0, b: b0 },
                { a: a1, b: b0 },
            ]),
            [[a0, b0], [a1], [c0]],
        );
        assert.deepEqual(joinGroups(groups, []), groups);
    });
});

describe("a review's options", () => {
    let env: ReviewEnv;
    const ws = "options";

    before(async () => {
        env = await reviewEnv();
        await patProject(env, ws, { repo: "options/app" });
        await env.fake.gitRepo("options/app", { "src/a.ts": "export const a = 1;\n" });
    });
    after(() => env.close());

    test("a review with one model has none, and no rule asks more models to agree than it has", () => {
        const asked = on({ retryFailed: true, agreement: { failAt: 4, markSingles: true }, judge: "first" });
        assert.deepEqual(effectiveOptions(asked, 1), NO_OPTIONS);
        assert.deepEqual(effectiveOptions(asked, 3), { ...asked, agreement: { failAt: 3, markSingles: true } });
        assert.deepEqual(effectiveOptions(asked, 5), asked);
    });

    test("options that aren't known are refused; none at all, or an empty set, changes nothing", async () => {
        const start = (body: object) => env.t.request(`/api/v1/w/${ws}/p/app/reviews`, { method: "POST", session: env.admin, body });
        const unknown = await start({ kind: "full", branch: "main", options: { nonsense: true } });
        assert.equal(unknown.status, 400, unknown.text);
        const plain = await start({ kind: "full", branch: "main", options: {} });
        assert.equal(plain.status, 201, plain.text);
        assert.deepEqual(plain.body.options, NO_OPTIONS);
        await env.t.request(`/api/v1/w/${ws}/runs/${plain.body.id}/cancel`, { method: "POST", session: env.admin });
        const automation = (await env.t.request(`/api/v1/w/${ws}/p/app/settings/automation`, { session: env.admin })).body;
        assert.deepEqual(automation.options, {});
    });
});
