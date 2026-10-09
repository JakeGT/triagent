import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfirmAction } from "./confirm-action";

describe("ConfirmAction", () => {
    it("stays open while the action runs, then closes", async () => {
        let finish: () => void = () => {};
        const onConfirm = () =>
            new Promise<void>((resolve) => {
                finish = resolve;
            });
        render(
            <ConfirmAction
                trigger={<button type="button">Delete</button>}
                title="Delete it?"
                description="Gone for good."
                confirmLabel="Delete it"
                onConfirm={onConfirm}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
        const working = (await screen.findByRole("button", { name: "Working…" })) as HTMLButtonElement;
        expect(working.disabled).toBe(true);
        expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
        expect(screen.queryByRole("alertdialog")).not.toBeNull();
        await act(async () => finish());
        expect(screen.queryByRole("alertdialog")).toBeNull();
    });
});
