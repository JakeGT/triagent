import { describe, expect, it } from "vitest";
import { isExample } from "@/lib/tutorial";
import type { Me } from "@/lib/types";
import { STEPS } from "./steps";

describe("the tutorial's steps", () => {
    it("each has a page, and all but the first and last point at a part of it", () => {
        const ids = STEPS.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const s of STEPS) expect(s.path, s.id).toBeTypeOf("function");
        expect(STEPS.filter((s) => !s.anchor).map((s) => s.id)).toEqual(["welcome", "finish"]);
    });

    it("stay inside the example project's workspace", () => {
        const example = { workspace: "sam", project: "example-acme-shop", name: "Example: Acme Shop", issue: "ocr-1" };
        for (const s of STEPS) expect(s.path?.(example), s.id).toMatch(/^\/w\/sam\//);
    });

    it("mention the range of review model providers in Settings", () => {
        const settings = STEPS.find((s) => s.id === "settings");
        expect(JSON.stringify(settings?.body({ example: {} as never, isInstanceAdmin: false }))).toMatch(/Models.*Bedrock.*Azure/s);
    });
});

describe("isExample", () => {
    const me = { tutorial: { status: "completed", step: 0, example: { workspace: "sam", project: "example-acme-shop" } } } as Me;
    it("is only the person's own example project", () => {
        expect(isExample(me, "sam", "example-acme-shop")).toBe(true);
        expect(isExample(me, "acme", "example-acme-shop")).toBe(false);
        expect(isExample(me, "sam", "web")).toBe(false);
        expect(isExample({ ...me, tutorial: { ...me.tutorial, example: null } }, "sam", "example-acme-shop")).toBe(false);
    });
});
