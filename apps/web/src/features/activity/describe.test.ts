import { describe, expect, it } from "vitest";
import type { ActivityRow } from "@/lib/types";
import { describeActivity } from "./describe";

const row = (kind: string, itemId: string, changes: Record<string, unknown>): ActivityRow => ({
    id: "a1",
    workspaceId: "w",
    projectId: "p",
    branch: "main",
    at: "2026-01-01T00:00:00Z",
    actor: "Open Code Review",
    actorUserId: null,
    via: "github",
    kind,
    itemId,
    changes,
});

describe("describeActivity", () => {
    it("says what a finished review reviewed and found, not the run's id", () => {
        const text = describeActivity(
            row("run", "xw91TXVUTYLG", { finished: { title: "PR #12 Redesign the checkout", status: "done", total: 10, critical: 1 } }),
        );
        expect(text).toBe("reviewed PR #12 Redesign the checkout and found 10 findings (1 critical)");
        expect(text).not.toContain("xw91TXVUTYLG");
    });

    it("says why a review didn't finish", () => {
        expect(
            describeActivity(
                row("run", "r1", { finished: { title: "Full scan of main", status: "failed", total: null, error: "No runner" } }),
            ),
        ).toBe("couldn't finish reviewing Full scan of main: No runner");
        expect(describeActivity(row("run", "r1", { finished: { title: "Full scan of main", status: "cancelled", total: null } }))).toBe(
            "stopped reviewing Full scan of main: the review was cancelled",
        );
    });

    it("counts one finding as one", () => {
        expect(describeActivity(row("report", "code_review.json", { uploaded: { issues: 1 } }))).toBe(
            "uploaded code_review.json with 1 finding",
        );
        expect(describeActivity(row("report", "code_review.json", { uploaded: { issues: 12, added: 2 } }))).toBe(
            "uploaded code_review.json with 12 findings (2 new)",
        );
        expect(describeActivity(row("branch", "old", { deleted: { unresolved: 1 } }))).toBe("deleted branch old with 1 unresolved issue");
    });

    it("never shows a bare id for a kind it doesn't know", () => {
        expect(describeActivity(row("widget", "abc123", {}))).toBe("changed widget abc123");
    });
});
