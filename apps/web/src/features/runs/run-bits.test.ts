import { describe, expect, it } from "vitest";
import type { RunRetry } from "@/lib/types";
import { addedText, attemptText, linesOf, modelProgressText, optionsText, progressText, retryText } from "./run-bits";

describe("modelProgressText", () => {
    it("says what a model is doing, with its own files, round, tokens and time", () => {
        expect(modelProgressText({ label: "a", phase: "reviewing", files: 12, round: "1/2", tokens: 4321, seconds: 75 })).toBe(
            "Reviewing · 12 files · round 1/2 · 4,321 tokens · 1m 15s so far",
        );
        expect(modelProgressText({ label: "a", phase: "starting", seconds: 0 })).toBe("Starting · 0s so far");
        expect(modelProgressText({ label: "a", phase: "waiting" })).toBe("Waiting for its turn");
    });

    it("says how a model ended, and why it was stopped", () => {
        expect(modelProgressText({ phase: "done", files: 3, round: "2/2", tokens: 1500, seconds: 9 })).toBe(
            "Finished · 3 files · 1,500 tokens · took 9s",
        );
        expect(modelProgressText({ phase: "failed", seconds: 2 })).toBe("Failed · took 2s");
        expect(modelProgressText({ phase: "failed", reason: "stalled", seconds: 40 })).toBe("Stopped: it went quiet · took 40s");
        expect(modelProgressText({ phase: "failed", reason: "timeLimit", seconds: 600 })).toBe("Stopped at the time limit · took 10m 0s");
        expect(modelProgressText({ phase: "failed", reason: "overBudget", tokens: 25000, seconds: 5 })).toBe(
            "Stopped: it passed its token budget · 25,000 tokens · took 5s",
        );
        expect(modelProgressText({ phase: "failed", reason: "something new" })).toBe("Failed");
        expect(modelProgressText({ phase: "cancelled", seconds: 1 })).toBe("Cancelled · took 1s");
    });
});

describe("progressText", () => {
    it("says how many models a review with several is using", () => {
        expect(progressText({ progress: { phase: "reviewing", model: "3 models (1 finished)", files: 4 }, cancelRequested: null })).toBe(
            "Reviewing with 3 models (1 finished) · 4 files",
        );
    });
});

describe("linesOf", () => {
    const lines = [
        { seq: 1, line: "[triagent] Reviewing with 2 models at once: gpt-5, gpt-5 (OpenAI)." },
        { seq: 2, line: "[gpt-5] [ocr] Round 1/2" },
        { seq: 3, line: "[gpt-5 (OpenAI)] [ocr] Round 1/2" },
        { seq: 4, line: "[gpt-5] [triagent] Finished." },
    ];

    it("keeps one model's lines: those that start with its label, and no other model's", () => {
        expect(linesOf(lines, "gpt-5").map((l) => l.seq)).toEqual([2, 4]);
        expect(linesOf(lines, "gpt-5 (OpenAI)").map((l) => l.seq)).toEqual([3]);
        expect(linesOf(lines, null)).toBe(lines);
    });
});

describe("a model run again", () => {
    const retry = (extra: Partial<RunRetry>): RunRetry => ({
        index: 1,
        label: "b",
        id: "r2",
        attempt: 2,
        auto: false,
        status: "done",
        queuedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: null,
        total: null,
        added: null,
        agreed: null,
        notAdded: null,
        error: null,
        ...extra,
    });

    it("says which attempt it is, and how it's going", () => {
        expect([2, 3, 4, 5].map(attemptText)).toEqual(["Second attempt", "Third attempt", "Fourth attempt", "Attempt 5"]);
        expect(retryText(retry({ status: "queued" }))).toBe("Second attempt: waiting to start");
        expect(retryText(retry({ status: "running", auto: true }))).toBe("Second attempt, automatic: running now");
        expect(retryText(retry({ status: "failed", error: "It fell over.", attempt: 3 }))).toBe("Third attempt: failed (It fell over.)");
        expect(retryText(retry({ status: "cancelled" }))).toBe("Second attempt: cancelled");
    });

    it("says what its findings added to the report, or why they weren't added", () => {
        expect(addedText({ added: 1, agreed: 2, notAdded: null })).toBe(
            "Added to the report: 1 new finding, and 2 that other models also found.",
        );
        expect(addedText({ added: 0, agreed: 1, notAdded: null })).toBe("Added to the report: 1 that another model also found.");
        expect(addedText({ added: 3, agreed: 0, notAdded: null })).toBe("Added to the report: 3 new findings.");
        expect(addedText({ added: 0, agreed: 0, notAdded: null })).toBe("It found nothing, so the report is as it was.");
        expect(addedText({ added: null, agreed: null, notAdded: "A newer report has replaced it." })).toBe(
            "Not added to the report. A newer report has replaced it.",
        );
        expect(retryText(retry({ added: 1, agreed: 0 }))).toBe("Second attempt: Added to the report: 1 new finding.");
    });
});

describe("optionsText", () => {
    it("says each option a run has, and nothing for a run with none", () => {
        expect(optionsText({ options: null })).toEqual([]);
        expect(
            optionsText({ options: { retryFailed: true, agreement: { failAt: 3, markSingles: true }, judge: null, bakeOff: false } }),
        ).toEqual([
            "Models that fail are run again once automatically.",
            "The pull request check fails only for criticals at least 3 models found.",
            "Findings only one model found are marked as lower confidence.",
        ]);
    });
});
