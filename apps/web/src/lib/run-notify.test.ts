import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { invalidateFor } from "./live";
import { keys } from "./queries";
import { describeRun, shouldNotify } from "./run-notify";
import type { Run } from "./types";

const me = (scope: "mine" | "all" | "none", problemsOnly = false) => ({
    user: { id: "u1", username: "me", displayName: "Me", email: null, isInstanceAdmin: false, createdAt: "", lastLoginAt: null },
    notify: { scope, problemsOnly },
});

const run = (extra: Partial<Run> = {}): Run =>
    ({
        id: "r1",
        title: "PR #3: Fix it",
        status: "done",
        startedAt: "2026-10-08T10:00:00Z",
        requestedBy: { name: "Me", userId: "u1" },
        result: { total: 2, bySeverity: { critical: 0, high: 2, medium: 0, low: 0 }, gaps: null, counts: null, tokens: null },
        error: null,
        ...extra,
    }) as Run;

describe("finished-review notifications", () => {
    it("follow the person's settings: mine, all or none, and problems only", () => {
        expect(shouldNotify(run(), me("mine"))).toBe(true);
        expect(shouldNotify(run({ requestedBy: { name: "Sam", userId: "u2" } }), me("mine"))).toBe(false);
        expect(shouldNotify(run({ requestedBy: { name: "automation", userId: null } }), me("all"))).toBe(true);
        expect(shouldNotify(run(), me("none"))).toBe(false);
        expect(shouldNotify(run(), me("mine", true))).toBe(false);
        expect(shouldNotify(run({ status: "failed" }), me("mine", true))).toBe(true);
        expect(shouldNotify(run({ status: "partial" }), me("mine", true))).toBe(true);
        expect(
            shouldNotify(
                run({
                    result: { total: 1, bySeverity: { critical: 1, high: 0, medium: 0, low: 0 }, gaps: null, counts: null, tokens: null },
                }),
                me("mine", true),
            ),
        ).toBe(true);
    });

    it("say nothing about a review that never started (replaced, or cancelled while queued)", () => {
        expect(shouldNotify(run({ status: "cancelled", startedAt: null }), me("all"))).toBe(false);
    });

    it("say what happened, plainly", () => {
        expect(describeRun(run())).toEqual({ title: "Review finished", body: "PR #3: Fix it: 2 findings." });
        expect(describeRun(run({ status: "failed", error: "OCR failed" }))).toEqual({
            title: "Review failed",
            body: "PR #3: Fix it: OCR failed",
        });
    });
});

describe("live run notices", () => {
    it("refresh runs on progress without refetching the project's issues; a finished run refreshes the project", () => {
        const client = new QueryClient();
        const spy = vi.spyOn(client, "invalidateQueries");
        invalidateFor(client, "ws", { kind: "run", project: "app", fields: ["progress"] });
        expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([keys.runs("ws")]);
        spy.mockClear();
        invalidateFor(client, "ws", { kind: "run", project: "app", fields: ["finished"] });
        expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([
            keys.runs("ws"),
            keys.pullRequests("ws", "app"),
            keys.project("ws", "app"),
            keys.projects("ws"),
        ]);
    });
});
