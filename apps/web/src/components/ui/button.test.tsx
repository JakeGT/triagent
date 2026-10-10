import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
    it("draws the danger variant as an outline in the danger colour, not a filled button", () => {
        render(<Button variant="danger">Delete</Button>);
        const button = screen.getByRole("button", { name: "Delete" });
        const classes = button.className.split(/\s+/);
        expect(classes).toContain("border");
        expect(classes).toContain("border-destructive");
        expect(classes).toContain("text-destructive");
        expect(classes).not.toContain("bg-destructive");
        expect(classes).not.toContain("text-white");
    });

    it("keeps the filled destructive variant for a dialog's confirming button", () => {
        render(<Button variant="destructive">Delete project</Button>);
        expect(screen.getByRole("button", { name: "Delete project" }).className.split(/\s+/)).toContain("bg-destructive");
    });

    it("gives every labelled variant a fill or a border", () => {
        for (const variant of ["default", "outline", "secondary", "danger", "destructive"] as const) {
            const { unmount } = render(<Button variant={variant}>Go</Button>);
            const classes = screen.getByRole("button", { name: "Go" }).className.split(/\s+/);
            expect(classes.some((c) => c === "border" || /^bg-(primary|secondary|destructive)$/.test(c))).toBe(true);
            unmount();
        }
    });
});
