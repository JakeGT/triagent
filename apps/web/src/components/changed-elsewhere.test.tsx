import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChangedElsewhere } from "./changed-elsewhere";

describe("ChangedElsewhere", () => {
    it("reloads without submitting the form it sits in", () => {
        const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
        const onReload = vi.fn();
        render(
            <form onSubmit={onSubmit}>
                <ChangedElsewhere show onReload={onReload} what="These settings" />
            </form>,
        );
        fireEvent.click(screen.getByRole("button", { name: /reload/i }));
        expect(onReload).toHaveBeenCalledOnce();
        expect(onSubmit).not.toHaveBeenCalled();
    });
});
