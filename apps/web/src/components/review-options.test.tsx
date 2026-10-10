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

    it("a model can be asked about the findings: the review's first that can be, or a favourite, but not one on Amazon Bedrock", async () => {
        const fav = (id: string, model: string, canJudge = true) => ({
            id,
            provider: "p",
            providerName: "Provider",
            model,
            name: null,
            isDefault: false,
            ready: true,
            missing: null,
            canJudge,
        });
        const choices = {
            favourites: [fav("b", "bedrock-model", false), fav("a", "model-a"), fav("c", "model-c")],
            defaultId: "a",
            instance: null,
            max: 5,
            fallback: ["a"],
        };
        const onChange = vi.fn();
        const { rerender } = render(<ReviewOptions value={{}} models={2} choices={choices} chosen={["b", "a"]} onChange={onChange} />);
        expect(screen.queryByLabelText("Model to ask")).toBeNull();
        await userEvent.click(screen.getByRole("checkbox", { name: /^Ask a model whether findings/ }));
        expect(onChange).toHaveBeenLastCalledWith({ judge: "first" });
        rerender(<ReviewOptions value={{ judge: true }} models={2} choices={choices} chosen={["b", "a"]} onChange={onChange} />);
        const who = screen.getByLabelText("Model to ask") as HTMLSelectElement;
        // The first that can be is the second model: the first is on Amazon Bedrock.
        expect([...who.options].map((o) => o.text)).toEqual(["The review's first model that can be (model-a)", "model-a", "model-c"]);
        await userEvent.selectOptions(who, "c");
        expect(onChange).toHaveBeenLastCalledWith({ judge: "c" });
        // None of the review's models can be asked: it says so.
        rerender(<ReviewOptions value={{ judge: "first" }} models={2} choices={choices} chosen={["b"]} onChange={onChange} />);
        expect(screen.getByRole("alert").textContent).toBe("None of this review's models can be asked. Choose a model to ask.");
    });
});
