import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Note } from "@/lib/types";
import { NoteList } from "./notes";

const note = (id: string): Note => ({ id, authorKey: "user:me", by: "Me", at: "2026-10-09T12:00:00Z", text: `note ${id}` });

describe("NoteList", () => {
    it("stops editing (and tells the page) when the note being edited is gone", () => {
        const onEditingChange = vi.fn();
        const props = { myKey: "user:me", canEditOwn: true, canModerate: false, onEdit: vi.fn(), onDelete: vi.fn(), onEditingChange };
        const { rerender } = render(<NoteList notes={[note("a"), note("b")]} {...props} />);
        fireEvent.click(screen.getAllByRole("button", { name: /^edit/i })[0] as HTMLElement);
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
        rerender(<NoteList notes={[note("b")]} {...props} />);
        expect(onEditingChange).toHaveBeenLastCalledWith(false);
    });
});
