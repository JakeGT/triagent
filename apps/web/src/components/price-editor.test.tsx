import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { appliesTo, PriceEditor, readPrice } from "./price-editor";

const PRICES = [
    { model: "anthropic/claude-sonnet-4.5", input: 3, output: 15, cacheRead: null, setBy: "Sam", setAt: "2026-10-07T09:30:00.000Z" },
];
const CATALOGUE = [
    { id: "openai/gpt-5", name: "OpenAI: GPT-5", price: { input: 1.25, output: 10, cacheRead: 0.125 }, contextLength: null },
];

describe("readPrice", () => {
    it("accepts prices per million tokens, with cache reads optional", () => {
        expect(readPrice({ model: " openai/gpt-5 ", input: "1.25", output: "10", cacheRead: "" })).toEqual({
            model: "openai/gpt-5",
            input: 1.25,
            output: 10,
            cacheRead: null,
        });
        expect(readPrice({ model: "m", input: "0", output: "0", cacheRead: "0.1" })).toEqual({
            model: "m",
            input: 0,
            output: 0,
            cacheRead: 0.1,
        });
    });

    it("explains what's wrong", () => {
        expect(readPrice({ model: "has spaces", input: "1", output: "1", cacheRead: "" })).toMatch(/model's name/);
        expect(readPrice({ model: "m", input: "", output: "1", cacheRead: "" })).toMatch(/^The input price/);
        expect(readPrice({ model: "m", input: "1", output: "-2", cacheRead: "" })).toMatch(/^The output price/);
        expect(readPrice({ model: "m", input: "1", output: "2", cacheRead: "lots" })).toMatch(/^The cache read price/);
        expect(readPrice({ model: "m", input: "20000", output: "2", cacheRead: "" })).toMatch(/from 0 to 10,000/);
        for (const odd of ["0x10", "1e3", "0b1", "Infinity", "1.2.3"])
            expect(readPrice({ model: "m", input: odd, output: "1", cacheRead: "" }), odd).toMatch(/^The input price/);
    });
});

describe("PriceEditor", () => {
    it("lists prices, with cache reads at the input price when not set", () => {
        render(<PriceEditor title="instance prices" prices={PRICES} canEdit={false} onSave={vi.fn()} onRemove={vi.fn()} />);
        const row = screen.getByRole("row", { name: /claude-sonnet/ });
        expect(within(row).getByText("US$3")).toBeTruthy();
        expect(within(row).getByText("As input")).toBeTruthy();
        // Read-only: no form, no buttons.
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("refuses a bad price without sending it, then saves a good one and clears the form", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn(async () => undefined);
        render(<PriceEditor title="prices" prices={[]} canEdit onSave={onSave} onRemove={vi.fn()} />);
        await user.type(screen.getByLabelText("Model"), "openai/gpt-5");
        await user.type(screen.getByLabelText("Input (US$ per million)"), "1.25");
        await user.click(screen.getByRole("button", { name: "Save price" }));
        expect(screen.getByRole("alert").textContent).toMatch(/^The output price/);
        expect(onSave).not.toHaveBeenCalled();
        await user.type(screen.getByLabelText("Output (US$ per million)"), "10");
        await user.click(screen.getByRole("button", { name: "Save price" }));
        expect(onSave).toHaveBeenCalledWith({ model: "openai/gpt-5", input: 1.25, output: 10, cacheRead: null });
        await waitFor(() => expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(""));
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("fills in OpenRouter's listed price for a model in the catalogue", async () => {
        const user = userEvent.setup();
        render(<PriceEditor title="prices" prices={[]} canEdit catalogue={CATALOGUE} onSave={vi.fn()} onRemove={vi.fn()} />);
        expect(screen.queryByRole("button", { name: "Use OpenRouter's price" })).toBeNull();
        await user.type(screen.getByLabelText("Model"), "openai/gpt-5");
        await user.click(screen.getByRole("button", { name: "Use OpenRouter's price" }));
        expect((screen.getByLabelText("Input (US$ per million)") as HTMLInputElement).value).toBe("1.25");
        expect((screen.getByLabelText("Cache reads (optional)") as HTMLInputElement).value).toBe("0.125");
    });

    it("shows the server's refusal and keeps what was typed", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn(async () => {
            throw new Error("There can be at most 500 prices.");
        });
        render(<PriceEditor title="prices" prices={[]} canEdit onSave={onSave} onRemove={vi.fn()} />);
        await user.type(screen.getByLabelText("Model"), "m");
        await user.type(screen.getByLabelText("Input (US$ per million)"), "1");
        await user.type(screen.getByLabelText("Output (US$ per million)"), "2");
        await user.click(screen.getByRole("button", { name: "Save price" }));
        expect((await screen.findByRole("alert")).textContent).toBe("There can be at most 500 prices.");
        expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("m");
    });

    it("edits and removes an existing price", async () => {
        const user = userEvent.setup();
        const onRemove = vi.fn(async () => undefined);
        render(<PriceEditor title="prices" prices={PRICES} canEdit onSave={vi.fn()} onRemove={onRemove} />);
        await user.click(screen.getByRole("button", { name: "Edit the price of anthropic/claude-sonnet-4.5" }));
        expect((screen.getByLabelText("Output (US$ per million)") as HTMLInputElement).value).toBe("15");
        await user.click(screen.getByRole("button", { name: "Remove the price of anthropic/claude-sonnet-4.5" }));
        await user.click(await screen.findByRole("button", { name: "Remove price" }));
        expect(onRemove).toHaveBeenCalledWith("anthropic/claude-sonnet-4.5");
    });

    it("suggests only favourites' names, and says when a name matches no review or favourite", async () => {
        const user = userEvent.setup();
        const { container, rerender } = render(
            <PriceEditor
                title="prices"
                prices={[]}
                canEdit
                catalogue={CATALOGUE}
                suggest={[{ model: "muse-spark-1.3-contributor", provider: "meta", label: "Muse" }]}
                used={[{ model: "deepseek-flash", provider: "deepseek" }]}
                onSave={vi.fn()}
                onRemove={vi.fn()}
            />,
        );
        const options = [...container.querySelectorAll("datalist option")].map((o) => (o as HTMLOptionElement).value);
        expect(options).toEqual(["muse-spark-1.3-contributor"]);

        const model = screen.getByLabelText("Model");
        await user.type(model, "meta/muse-spark");
        expect(screen.getByTestId("price-unused").textContent).toMatch(/won't change any costs/);
        for (const name of ["deepseek-flash", "deepseek/deepseek-flash", "muse-spark-1.3-contributor", "meta/muse-spark-1.3-contributor"]) {
            await user.clear(model);
            await user.type(model, name);
            expect(screen.queryByTestId("price-unused"), name).toBeNull();
        }

        // Set price from the list of models reviews used fills in the name.
        rerender(
            <PriceEditor
                title="prices"
                prices={[]}
                canEdit
                used={[{ model: "deepseek-flash", provider: "deepseek" }]}
                fill={{ model: "deepseek-flash" }}
                onSave={vi.fn()}
                onRemove={vi.fn()}
            />,
        );
        await waitFor(() => expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("deepseek-flash"));
        expect(document.activeElement).toBe(screen.getByLabelText("Model"));
    });

    it("matches names as the server does", () => {
        const used = { model: "muse-spark-1.3-contributor", provider: "meta" };
        expect(appliesTo("muse-spark-1.3-contributor", used)).toBe(true);
        expect(appliesTo("meta/muse-spark-1.3-contributor", used)).toBe(true);
        expect(appliesTo("openrouter/muse-spark-1.3-contributor", used)).toBe(false);
        expect(appliesTo("meta/x", { model: "x", provider: null })).toBe(false);
    });
});
