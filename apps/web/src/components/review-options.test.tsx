import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RunOptionsInput } from "@/lib/types";
import { optionsFor, ReviewOptions } from "./review-options";

describe("optionsFor", () => {
    it("never asks more models to agree than the review has", () => {
        expect(optionsFor({ agreement: { failAt: 4, markSingles: true } }, 3)).toEqual({ agreement: { failAt: 3, markSingles: true } });
        expect(optionsFor({ agreement: { failAt: 2 } }, 5)).toEqual({ agreement: { failAt: 2 } });
        expect(optionsFor({ agreement: { failAt: null } }, 2)).toEqual({ agreement: { failAt: null } });
        expect(optionsFor({}, 2)).toEqual({});
    });
});

describe("ReviewOptions", () => {
    const show = (value: RunOptionsInput, models: number, project = false) => {
        const onChange = vi.fn();
        render(<ReviewOptions value={value} models={models} project={project} onChange={onChange} />);
        return onChange;
    };

    it("everything is off until ticked, and ticking says what to save", async () => {
        const onChange = show({}, 3);
        const boxes = screen.getAllByRole("checkbox");
        expect(boxes.every((b) => b.getAttribute("aria-checked") === "false")).toBe(true);
        expect(screen.queryByLabelText("How many models must have found it")).toBeNull();
        await userEvent.click(screen.getByRole("checkbox", { name: /^Fail the pull request check only for criticals/ }));
        expect(onChange).toHaveBeenLastCalledWith({ agreement: { failAt: 2 } });
        await userEvent.click(screen.getByRole("checkbox", { name: "Mark findings only one model found as lower confidence" }));
        expect(onChange).toHaveBeenLastCalledWith({ agreement: { markSingles: true } });
    });

    it("how many models must agree is chosen when there are more than two, up to how many the review has", async () => {
        const onChange = show({ agreement: { failAt: 5 } }, 3);
        // Five can't agree when there are three: all three must.
        expect(
            screen.getByRole("checkbox", { name: "Fail the pull request check only for criticals at least 3 models found" }),
        ).toBeTruthy();
        const many = screen.getByLabelText("How many models must have found it") as HTMLSelectElement;
        expect([...many.options].map((o) => o.text)).toEqual(["At least 2 of 3", "All 3"]);
        await userEvent.selectOptions(many, "2");
        expect(onChange).toHaveBeenLastCalledWith({ agreement: { failAt: 2 } });
    });

    it("with two models there's nothing to choose", () => {
        show({ agreement: { failAt: 2 } }, 2);
        expect(screen.queryByLabelText("How many models must have found it")).toBeNull();
    });
});
