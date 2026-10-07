import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDraft, useHeldWhileEditing } from "./drafts";

describe("useDraft: a form's working copy of server data", () => {
    it("follows the server while untouched", () => {
        const { result, rerender } = renderHook(({ server }) => useDraft(server), { initialProps: { server: { name: "App" } } });
        expect(result.current.draft).toEqual({ name: "App" });
        rerender({ server: { name: "Renamed" } });
        expect(result.current.draft).toEqual({ name: "Renamed" });
        expect(result.current.changedElsewhere).toBe(false);
    });

    it("keeps the edits when the server changes, and says so", () => {
        const { result, rerender } = renderHook(({ server }) => useDraft(server), { initialProps: { server: { name: "App" } } });
        act(() => result.current.setDraft({ name: "My edit" }));
        rerender({ server: { name: "Their edit" } });
        expect(result.current.draft).toEqual({ name: "My edit" });
        expect(result.current.dirty).toBe(true);
        expect(result.current.changedElsewhere).toBe(true);
        act(() => result.current.reload());
        expect(result.current.draft).toEqual({ name: "Their edit" });
        expect(result.current.changedElsewhere).toBe(false);
    });

    it("treats a refetch of the same data as no change", () => {
        const { result, rerender } = renderHook(({ server }) => useDraft(server), { initialProps: { server: { name: "App" } } });
        act(() => result.current.setDraft({ name: "My edit" }));
        rerender({ server: { name: "App" } });
        expect(result.current.changedElsewhere).toBe(false);
    });
});

describe("useHeldWhileEditing: data next to something being typed", () => {
    const version = (x: { rev: number }) => x.rev;

    it("holds the version on screen while editing and flags newer ones", () => {
        const { result, rerender } = renderHook(({ live, editing }) => useHeldWhileEditing(live, editing, version), {
            initialProps: { live: { rev: 1 }, editing: false },
        });
        rerender({ live: { rev: 2 }, editing: false });
        expect(result.current.shown).toEqual({ rev: 2 });
        rerender({ live: { rev: 2 }, editing: true });
        rerender({ live: { rev: 3 }, editing: true });
        expect(result.current.shown).toEqual({ rev: 2 });
        expect(result.current.changedElsewhere).toBe(true);
        act(() => result.current.reload());
        expect(result.current.shown).toEqual({ rev: 3 });
        expect(result.current.changedElsewhere).toBe(false);
    });

    it("shows our own saved version without a banner", () => {
        const { result, rerender } = renderHook(({ live, editing }) => useHeldWhileEditing(live, editing, version), {
            initialProps: { live: { rev: 1 }, editing: true },
        });
        act(() => result.current.accept({ rev: 2 }));
        rerender({ live: { rev: 2 }, editing: true });
        expect(result.current.shown).toEqual({ rev: 2 });
        expect(result.current.changedElsewhere).toBe(false);
    });
});
