import { describe, expect, it } from "vitest";
import { favouriteLabel, moved } from "./model-library";

describe("moved", () => {
    it("swaps a favourite with its neighbour, and leaves the ends where they are", () => {
        expect(moved(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
        expect(moved(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
        expect(moved(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
        expect(moved(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
        expect(moved(["a"], 3, 1)).toEqual(["a"]);
    });

    it("returns a new list", () => {
        const ids = ["a", "b"];
        expect(moved(ids, 0, 1)).not.toBe(ids);
        expect(ids).toEqual(["a", "b"]);
    });
});

describe("favouriteLabel", () => {
    it("is the nickname, or the model's name without one", () => {
        expect(favouriteLabel({ name: "Fast", model: "codestral-latest" })).toBe("Fast");
        expect(favouriteLabel({ name: null, model: "codestral-latest" })).toBe("codestral-latest");
    });
});
