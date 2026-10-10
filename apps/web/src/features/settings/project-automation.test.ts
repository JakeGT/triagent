import { describe, expect, it } from "vitest";
import { skipPaths } from "./project-automation";

describe("skipPaths", () => {
    it("reads one pattern on each line, leaving out blank ones", () => {
        expect(skipPaths(" docs/**\n\n*.md \r\n")).toEqual(["docs/**", "*.md"]);
    });

    it("refuses what the server would: too many, too long, or with control characters", () => {
        expect(() => skipPaths(Array.from({ length: 51 }, (_, i) => `p${i}`).join("\n"))).toThrow(/at most 50 patterns/);
        expect(() => skipPaths("a".repeat(201))).toThrow(/longer than 200 characters/);
        expect(() => skipPaths("docs/\tguide.md")).toThrow(/control characters/);
        expect(skipPaths("a".repeat(200))).toHaveLength(1);
    });
});
