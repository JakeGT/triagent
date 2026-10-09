import { describe, expect, it } from "vitest";
import type { ModelChoices } from "@/lib/types";
import { modelLabels } from "./model-choice";

const choices = {
    favourites: [
        { id: "a", name: "Fast", model: "vendor/one", providerName: "OpenRouter", ready: true, missing: null },
        { id: "b", name: null, model: "vendor/two", providerName: "OpenRouter", ready: true, missing: null },
    ],
    defaultId: "a",
    instance: null,
    max: 3,
    fallback: ["a"],
} as unknown as ModelChoices;

describe("modelLabels", () => {
    it("names the models in the order given: a nickname, or the model's own name", () => {
        expect(modelLabels(choices, ["b", "a"])).toEqual(["vendor/two", "Fast"]);
    });

    it("still names one that's gone, so the rest don't look like the whole choice", () => {
        expect(modelLabels(choices, ["a", "removed"])).toEqual(["Fast", "A model that isn't a favourite any more"]);
        expect(modelLabels(choices, ["instance"])).toEqual(["Instance model"]);
    });

    it("is empty until the choices are known", () => {
        expect(modelLabels(undefined, ["a"])).toEqual([]);
    });
});
