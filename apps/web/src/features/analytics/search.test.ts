import { describe, expect, it } from "vitest";
import { analyticsTab, parseAnalyticsSearch } from "./search";

describe("analyticsTab", () => {
    it("is the tab an address names, or the overview for one it doesn't know", () => {
        expect(analyticsTab("models")).toBe("models");
        expect(analyticsTab("triage")).toBe("triage");
        for (const odd of [undefined, "", "nonsense", "Models", 3]) expect(analyticsTab(odd)).toBe("overview");
    });
});

describe("parseAnalyticsSearch", () => {
    it("keeps a range from the list, as a number or a string", () => {
        expect(parseAnalyticsSearch({ days: 90 })).toEqual({ days: 90 });
        expect(parseAnalyticsSearch({ days: "7" })).toEqual({ days: 7 });
        expect(parseAnalyticsSearch({ days: "0" })).toEqual({ days: 0 });
    });

    it("ignores blank or odd values rather than reading them as All time", () => {
        for (const days of ["", " ", null, [], false, "abc", 12]) expect(parseAnalyticsSearch({ days })).toEqual({});
    });

    it("keeps a branch only with a project", () => {
        expect(parseAnalyticsSearch({ branch: "main" })).toEqual({});
        expect(parseAnalyticsSearch({ project: "web", branch: "main" })).toEqual({ project: "web", branch: "main" });
    });
});
