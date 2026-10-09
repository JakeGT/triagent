import { describe, expect, it } from "vitest";
import { compactCount, hours, seconds } from "./insights-format";

describe("insights formatting", () => {
    it("picks the unit after rounding", () => {
        expect(compactCount(1284)).toBe("1,284");
        expect(compactCount(12_900)).toBe("12.9K");
        expect(compactCount(999_949)).toBe("999.9K");
        expect(compactCount(999_950)).toBe("1M");
        expect(compactCount(4_200_000)).toBe("4.2M");
        expect(compactCount(999_960_000)).toBe("1B");
    });

    it("carries rounded minutes into hours", () => {
        expect(seconds(45)).toBe("45 s");
        expect(seconds(150)).toBe("2 min 30 s");
        expect(seconds(3900)).toBe("1 h 5 min");
        expect(seconds(7170)).toBe("2 h");
    });

    it("never says 60 min", () => {
        expect(hours(0.5)).toBe("30 min");
        expect(hours(0.999)).not.toBe("60 min");
        expect(hours(5.5)).toBe("5.5 hours");
        expect(hours(72)).toBe("3 days");
    });
});
