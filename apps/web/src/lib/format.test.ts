import { describe, expect, it } from "vitest";
import { timeAgo } from "./format";

describe("timeAgo", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    const ago = (s: number) => timeAgo(new Date(now - s * 1000).toISOString(), now);

    it("rounds once, at the unit it shows", () => {
        expect(ago(10)).toBe("just now");
        expect(ago(45)).toBe("45 seconds ago");
        expect(ago(5 * 60)).toBe("5 minutes ago");
        expect(ago(89 * 60 + 59)).toBe("1 hour ago");
        expect(ago(91 * 60)).toBe("2 hours ago");
        expect(ago(36 * 3600)).toBe("2 days ago");
        expect(timeAgo("not a date", now)).toBe("");
    });
});
