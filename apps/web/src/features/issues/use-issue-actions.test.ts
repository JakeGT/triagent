import { describe, expect, it } from "vitest";
import { inverseOf, undoPlan } from "./use-issue-actions";

const issue = (id: string, over: Partial<Parameters<typeof inverseOf>[0]> = {}) => ({
    id,
    status: "open" as const,
    assignee: null,
    severity: "low" as const,
    reviewerSeverity: null,
    needsDiscussion: false,
    ...over,
});

describe("undoing a bulk change", () => {
    it("puts back only the field that was changed", () => {
        expect(inverseOf(issue("a", { status: "in_progress", assignee: "Sam" }), { status: "resolved" })).toEqual({
            status: "in_progress",
        });
        expect(inverseOf(issue("a", { assignee: "Sam" }), { assignee: null })).toEqual({ assignee: "Sam" });
        expect(inverseOf(issue("a"), { assignee: "Sam" })).toEqual({ assignee: null });
        expect(inverseOf(issue("a", { needsDiscussion: true }), { needsDiscussion: false })).toEqual({ needsDiscussion: true });
    });

    it("restores a corrected rating as it was, and an uncorrected one to the reviewer's", () => {
        expect(inverseOf(issue("a", { severity: "high", reviewerSeverity: "low" }), { severity: "critical" })).toEqual({
            severity: "high",
        });
        expect(inverseOf(issue("a", { severity: "low" }), { severity: "critical" })).toEqual({ severity: "reviewer" });
        expect(inverseOf(issue("a", { severity: "high", reviewerSeverity: "low" }), { severity: "reviewer" })).toEqual({
            severity: "high",
        });
    });

    it("makes one request for each distinct previous value", () => {
        const plan = undoPlan([issue("a"), issue("b", { status: "in_progress" }), issue("c"), issue("d", { status: "resolved" })], {
            status: "wont_fix",
        });
        expect(plan).toEqual([
            { ids: ["a", "c"], change: { status: "open" } },
            { ids: ["b"], change: { status: "in_progress" } },
            { ids: ["d"], change: { status: "resolved" } },
        ]);
    });

    it("keeps an unassigned issue apart from an assigned one", () => {
        const plan = undoPlan([issue("a"), issue("b", { assignee: "Sam" })], { assignee: "Ada" });
        expect(plan).toEqual([
            { ids: ["a"], change: { assignee: null } },
            { ids: ["b"], change: { assignee: "Sam" } },
        ]);
    });
});
