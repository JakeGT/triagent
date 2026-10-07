import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { describeSecret, SecretField } from "./secret-field";

const SET = { name: "github-token", set: true, hint: "abcd", setBy: "Sam", setAt: "2026-10-07T09:30:00.000Z" };
const UNSET = { name: "github-token", set: false, hint: null, setBy: null, setAt: null };

describe("SecretField", () => {
    it("says who set the secret, when, and how it ends, as text and never in a placeholder", () => {
        render(<SecretField label="GitHub token" secret={SET} canEdit onSave={vi.fn()} onClear={vi.fn()} />);
        expect(screen.getByText("Set by Sam on 7 Oct 2026, ends …abcd")).toBeTruthy();
        // Write-only: no input until asked to replace it, and nothing anywhere shows a value.
        expect(screen.queryByLabelText("GitHub token")).toBeNull();
        for (const input of document.querySelectorAll("input")) {
            expect(input.value).toBe("");
            expect(input.placeholder).toBe("");
        }
    });

    it("replaces the secret with a new value and then forgets what was typed", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn(async () => undefined);
        render(<SecretField label="GitHub token" secret={SET} canEdit onSave={onSave} onClear={vi.fn()} />);
        await user.click(screen.getByRole("button", { name: "Replace" }));
        const input = screen.getByLabelText("GitHub token") as HTMLInputElement;
        expect(input.type).toBe("password");
        expect(input.placeholder).toBe("");
        await user.type(input, "github_pat_new_value");
        await user.click(screen.getByRole("button", { name: "Save new value" }));
        expect(onSave).toHaveBeenCalledWith("github_pat_new_value");
        await waitFor(() => expect(screen.queryByLabelText("GitHub token")).toBeNull());
        expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
    });

    it("shows the server's refusal inline and keeps the input", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn(async () => {
            throw new Error("That doesn't look like a GitHub token.");
        });
        render(<SecretField label="GitHub token" secret={UNSET} canEdit onSave={onSave} onClear={vi.fn()} />);
        await user.type(screen.getByLabelText("GitHub token"), "nope");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect((await screen.findByRole("alert")).textContent).toBe("That doesn't look like a GitHub token.");
        expect(screen.getByLabelText("GitHub token").getAttribute("aria-invalid")).toBe("true");
    });

    it("clears the secret only after confirming", async () => {
        const user = userEvent.setup();
        const onClear = vi.fn(async () => undefined);
        render(<SecretField label="GitHub token" secret={SET} canEdit onSave={vi.fn()} onClear={onClear} />);
        await user.click(screen.getByRole("button", { name: "Clear" }));
        expect(onClear).not.toHaveBeenCalled();
        const dialog = await screen.findByRole("alertdialog");
        expect(dialog.textContent).toContain("Clear the github token?");
        await user.click(screen.getByRole("button", { name: "Clear" }));
        await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
    });

    it("only shows the status to people who can't change it", () => {
        render(<SecretField label="GitHub token" secret={SET} canEdit={false} onSave={vi.fn()} onClear={vi.fn()} />);
        expect(screen.getByText(/Set by Sam/)).toBeTruthy();
        expect(screen.queryByRole("button")).toBeNull();
        expect(document.querySelector("input")).toBeNull();
    });

    it("describes an unset secret", () => {
        expect(describeSecret(UNSET)).toBe("Not set");
        expect(describeSecret({ set: true, hint: null, setBy: null, setAt: null })).toBe("Set");
    });
});
