import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodeView } from "./code-view";

describe("CodeView", () => {
    it("shows the suggestion when the existing code is empty", () => {
        render(<CodeView existing="" suggestion="const fixed = true;" />);
        expect(screen.getByText("Suggested code")).toBeTruthy();
        expect(screen.getByText("const fixed = true;")).toBeTruthy();
    });
});
