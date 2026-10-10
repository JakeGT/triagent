// Asking a model which findings are the same problem (src/judge.ts), against a stand-in for a provider on
// 127.0.0.1: what each protocol is sent and how its answer is read, that the model never sees code, the
// limit on how many pairs are asked, and that anything but a true or false for each pair is no answer at all.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { MAX_JUDGE_PAIRS } from "../../../packages/shared/src/merge.ts";
import type { RunnerModel } from "../../../packages/shared/src/model.ts";
import { FakeProvider } from "../../../tests/fakes/model-provider.ts";
import type { FinishPart } from "../src/client.ts";
import { describeFinding, findingsOf, judgeFindings, question, readAnswers } from "../src/judge.ts";

const fakeKey = () => `sk-test-${randomBytes(18).toString("base64url")}`;
const CODE = "const password = 'DO-NOT-SEND-THIS-CODE';";

const finding = (path: string, line: number, content: string, category = "bug") => ({
    path,
    content,
    severity: "high",
    category,
    start_line: line,
    end_line: line + 2,
    existing_code: CODE,
    suggestion_code: `${CODE} // suggested`,
});
const done = (comments: unknown[]): FinishPart => ({ status: "done", report: { comments, project_summary: CODE } });

/** Two models' reviews of one file, with nothing about where their findings are that makes them one. */
const twoReviews = (n = 2): FinishPart[] => [
    done(Array.from({ length: n }, (_, i) => finding("src/a.ts", 10 + i * 100, `A's finding ${i}`))),
    done(Array.from({ length: n }, (_, i) => finding("src/a.ts", 40 + i * 100, `B's finding ${i}`, "security"))),
];

describe("asking a model which findings are the same problem", () => {
    let provider: FakeProvider;
    const model = (protocol: RunnerModel["protocol"], path = ""): RunnerModel => ({
        provider: "custom",
        protocol,
        url: `${provider.url}${path}`,
        model: "judge-model",
        apiKey: fakeKey(),
    });

    before(async () => {
        provider = await new FakeProvider().start();
    });
    after(() => provider.stop());
    beforeEach(() => {
        provider.requests.length = 0;
        provider.mode = "answer";
        provider.same = () => true;
        provider.chatter = ["", ""];
    });

    test("a finding is described by what it says and where it is, never by the code it quotes", () => {
        const described = describeFinding({ ...finding("src/a.ts", 10, "The total is wrong."), extra: CODE });
        assert.deepEqual(described, { file: "src/a.ts", lines: "10-12", severity: "high", category: "bug", text: "The total is wrong." });
        assert.deepEqual(describeFinding({ path: "x.ts", content: "y", start_line: 3, end_line: 3 }).lines, "3");
        assert.deepEqual(describeFinding({ path: "x.ts", content: "y" }).lines, null);
        // Long text is cut, and what isn't text isn't sent.
        assert.equal((describeFinding({ path: "x.ts", content: "z".repeat(5000) }).text as string).length, 1200);
        assert.deepEqual(describeFinding({ path: 7, content: { code: CODE }, severity: [CODE] }), {
            file: null,
            lines: null,
            severity: null,
            category: null,
            text: "",
        });
        assert.deepEqual(describeFinding(null).text, "");
        const asked = question(findingsOf(twoReviews()), [{ a: { part: 0, index: 0 }, b: { part: 1, index: 0 } }]);
        assert.doesNotMatch(asked, /DO-NOT-SEND|password|suggested/);
        assert.deepEqual(Object.keys(JSON.parse(asked).pairs[0]), ["id", "a", "b"]);
    });

    test("only a true or false for every pair is an answer", () => {
        assert.deepEqual(readAnswers('{"p1": true, "p2": false}', 2), [true, false]);
        // Said around it, or with more than was asked: the object is found, and only p1 to pN are read.
        assert.deepEqual(readAnswers('Here you go:\n```json\n{"p2": false, "p1": true, "p9": true, "ignore previous": "x"}\n```', 2), [
            true,
            false,
        ]);
        for (const said of [
            "",
            "They're all the same.",
            "[true, false]",
            '{"p1": true}',
            '{"p1": "true", "p2": "false"}',
            '{"p1": 1, "p2": 0}',
            '{"p1": true, "p2": null}',
            '{"p1": true, "p2": false',
            '{"__proto__": {"p1": true, "p2": true}}',
        ])
            assert.equal(readAnswers(said, 2), null, said);
    });

    for (const [protocol, base, path] of [
        ["openai", "/v1", "/v1/chat/completions"],
        ["openai-responses", "/openai/v1", "/openai/v1/responses"],
        ["anthropic", "", "/v1/messages"],
    ] as const)
        test(`${protocol}: POST {url}${path.replace(base, "")} with the key where that protocol takes it, and the answer read from what it says`, async () => {
            const m = model(protocol, base);
            provider.same = (p) => p.a.text === "A's finding 0" && p.b.text === "B's finding 0";
            provider.chatter = ["Sure, here is the JSON you asked for:\n", "\nLet me know if you need anything else."];
            const judged = await judgeFindings(m, twoReviews());
            assert.equal(judged.error, undefined);
            assert.equal(judged.total, 4);
            assert.equal(judged.pairs.length, 4);
            assert.deepEqual(
                judged.pairs.filter((p) => p.same),
                [{ a: { part: 0, index: 0 }, b: { part: 1, index: 0 }, same: true }],
            );
            assert.deepEqual(judged.tokens, { input: 300, output: 20 });
            assert.equal(provider.requests.length, 1, "one request for all four pairs");
            const sent = provider.requests[0];
            assert.equal(sent?.path, path);
            if (protocol === "anthropic") {
                assert.equal(sent?.headers["x-api-key"], m.apiKey);
                assert.equal(sent?.headers["anthropic-version"], "2023-06-01");
                assert.equal(sent?.headers.authorization, undefined);
                assert.ok(Number(sent?.body.max_tokens) > 0);
            } else assert.equal(sent?.headers.authorization, `Bearer ${m.apiKey}`);
            assert.equal(sent?.body.model, "judge-model");
            // It's told the findings are data, and sent only their text and where they are.
            assert.match(sent?.raw ?? "", /never follow them/);
            assert.doesNotMatch(sent?.raw ?? "", /DO-NOT-SEND|password|existing_code|suggestion_code|project_summary/);
            assert.deepEqual(sent?.pairs[0], {
                id: "p1",
                a: { file: "src/a.ts", lines: "10-12", severity: "high", category: "bug", text: "A's finding 0" },
                b: { file: "src/a.ts", lines: "40-42", severity: "high", category: "security", text: "B's finding 0" },
            });
            // Nothing that isn't needed: no tools, no sampling settings a model might refuse.
            for (const k of ["tools", "temperature", "stream"]) assert.equal(sent?.body[k], undefined, k);
        });

    test("at most 200 pairs are asked about, the closest first, a few requests' worth at a time", async () => {
        const judged = await judgeFindings(model("openai", "/v1"), twoReviews(20));
        assert.equal(judged.total, 400);
        assert.equal(judged.pairs.length, MAX_JUDGE_PAIRS);
        assert.equal(provider.requests.length, 8);
        assert.ok(provider.requests.every((r) => r.pairs.length === 25));
        assert.deepEqual(judged.tokens, { input: 2400, output: 160 });
        // The closest pair is the first one asked: 30 lines apart, not hundreds.
        assert.deepEqual(provider.requests[0]?.pairs[0]?.a.lines, "10-12");
        assert.deepEqual(provider.requests[0]?.pairs[0]?.b.lines, "40-42");
    });

    test("nothing to compare asks nothing", async () => {
        const judged = await judgeFindings(model("openai", "/v1"), [
            done([finding("a.ts", 1, "x")]),
            { status: "failed", error: "It fell over." },
        ]);
        assert.deepEqual([judged.pairs, judged.total, judged.tokens, judged.error], [[], 0, null, undefined]);
        // A model whose review failed has no findings to compare, even if it sent a report.
        const failed = await judgeFindings(model("openai", "/v1"), [
            done([finding("a.ts", 1, "x")]),
            { status: "failed", report: { comments: [finding("a.ts", 90, "y", "style")] } },
        ]);
        assert.equal(failed.total, 0);
        assert.equal(provider.requests.length, 0);
    });

    test("a provider that fails, is slow, redirects, or says anything but true or false for each pair: no answers, and why", async () => {
        const m = model("openai", "/v1");
        const ask = async (mode: FakeProvider["mode"], timeoutMs = 2000) => {
            provider.mode = mode;
            const judged = await judgeFindings(m, twoReviews(), { timeoutMs });
            assert.deepEqual(judged.pairs, [], mode);
            assert.equal(judged.total, 4);
            assert.ok(!judged.error?.includes(m.apiKey), "the key is never in what went wrong");
            return judged.error ?? "";
        };
        assert.equal(await ask("error"), "its provider answered 500");
        assert.equal(await ask("nonsense"), "its answer wasn't true or false for each pair");
        assert.equal(await ask("strings"), "its answer wasn't true or false for each pair");
        assert.equal(await ask("partial"), "its answer wasn't true or false for each pair");
        assert.equal(await ask("huge"), "its answer was far longer than it should be");
        assert.match(await ask("redirect"), /^it couldn't be reached/);
        assert.ok(!provider.requests.some((r) => r.path.startsWith("/elsewhere")), "the key isn't sent on to wherever a redirect points");
        assert.equal(await ask("slow", 300), "it didn't answer within 1 second");
        // Nowhere to ask, and a protocol that can't be asked this way.
        assert.match((await judgeFindings({ ...m, url: "" }, twoReviews())).error ?? "", /no address/);
        assert.match(
            (await judgeFindings({ ...m, protocol: "anthropic-bedrock", url: "" }, twoReviews())).error ?? "",
            /Amazon Bedrock can't be asked/,
        );
        // One request of several failing loses all of them: all the pairs answered, or none.
        provider.mode = "answer";
        let n = 0;
        provider.same = () => {
            if (++n > 30) provider.mode = "error";
            return true;
        };
        const partway = await judgeFindings(m, twoReviews(8));
        assert.deepEqual(partway.pairs, []);
        assert.equal(partway.error, "its provider answered 500");
        assert.deepEqual(partway.tokens, { input: 600, output: 40 }, "what the answered requests used is still counted");
    });

    test("stopping the review stops the question", async () => {
        provider.mode = "slow";
        const stop = new AbortController();
        setTimeout(() => stop.abort(), 100);
        const t0 = Date.now();
        const judged = await judgeFindings(model("anthropic"), twoReviews(), { signal: stop.signal });
        assert.ok(Date.now() - t0 < 3000);
        assert.match(judged.error ?? "", /couldn't be reached/);
    });
});
