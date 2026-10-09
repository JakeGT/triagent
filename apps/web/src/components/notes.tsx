// Notes on an issue or task: everyone's, newest last. You can edit and delete your own; people who
// moderate can delete anyone's. The text being typed is the caller's state, so live updates never
// clear it.

import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ConfirmAction } from "@/components/confirm-action";
import { FieldError } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { Note } from "@/lib/types";

export function NoteList({
    notes,
    myKey,
    canEditOwn,
    canModerate,
    onEdit,
    onDelete,
    onEditingChange,
}: {
    notes: Note[];
    /** "user:<id>": the signed-in person's notes. */
    myKey: string;
    canEditOwn: boolean;
    canModerate: boolean;
    onEdit(noteId: string, text: string): Promise<unknown>;
    onDelete(noteId: string): Promise<unknown>;
    /** Told when a note is opened for editing, so the page can hold still meanwhile. */
    onEditingChange?(editing: boolean): void;
}) {
    const [editing, setEditing] = useState<string | null>(null);
    const setEdit = (id: string | null) => {
        setEditing(id);
        onEditingChange?.(id !== null);
    };
    // The note being edited was deleted (shown after a reload): stop editing, so the page stops holding still.
    const editedGone = editing !== null && !notes.some((n) => n.id === editing);
    // biome-ignore lint/correctness/useExhaustiveDependencies: only when the edited note goes; setEdit is recreated each render
    useEffect(() => {
        if (editedGone) setEdit(null);
    }, [editedGone]);
    if (!notes.length) return <p className="text-sm text-muted-foreground">No notes yet.</p>;
    return (
        <ol className="grid gap-3">
            {notes.map((n) => {
                const mine = n.authorKey === myKey;
                return (
                    <li key={n.id} className="rounded-md border bg-card p-3 text-sm">
                        <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{n.by}</span>
                            <time dateTime={n.at} title={formatDateTime(n.at)}>
                                {timeAgo(n.at)}
                            </time>
                            {n.editedAt && <span title={formatDateTime(n.editedAt)}>(edited)</span>}
                            <span className="ms-auto flex gap-1">
                                {mine && canEditOwn && editing !== n.id && (
                                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEdit(n.id)}>
                                        <Pencil /> Edit<span className="sr-only"> your note from {timeAgo(n.at)}</span>
                                    </Button>
                                )}
                                {((mine && canEditOwn) || canModerate) && editing !== n.id && (
                                    <ConfirmAction
                                        trigger={
                                            <Button type="button" variant="ghost" size="sm" className="h-7 px-2">
                                                <Trash2 /> Delete
                                                <span className="sr-only">
                                                    {" "}
                                                    {mine ? "your" : `${n.by}'s`} note from {timeAgo(n.at)}
                                                </span>
                                            </Button>
                                        }
                                        title="Delete this note?"
                                        description={
                                            mine ? "Your note is removed for everyone." : `${n.by}'s note is removed for everyone.`
                                        }
                                        confirmLabel="Delete note"
                                        onConfirm={() => onDelete(n.id)}
                                    />
                                )}
                            </span>
                        </div>
                        {editing === n.id ? (
                            <NoteEditor
                                initial={n.text}
                                label="Edit your note"
                                submitLabel="Save note"
                                onCancel={() => setEdit(null)}
                                onSubmit={async (text) => {
                                    await onEdit(n.id, text);
                                    setEdit(null);
                                }}
                            />
                        ) : (
                            <p className="whitespace-pre-wrap break-words">{n.text}</p>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}

/** A note being written or edited. */
export function NoteEditor({
    initial = "",
    value: controlled,
    onChange,
    label,
    submitLabel,
    onSubmit,
    onCancel,
    disabled,
}: {
    initial?: string;
    /** Controlled text (the caller keeps it, e.g. to know someone is typing). */
    value?: string;
    onChange?(text: string): void;
    label: string;
    submitLabel: string;
    onSubmit(text: string): Promise<unknown>;
    onCancel?(): void;
    disabled?: boolean;
}) {
    const id = useId();
    const [own, setOwn] = useState(initial);
    const text = controlled ?? own;
    const setText = onChange ?? setOwn;
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    return (
        <form
            className="grid gap-2"
            onSubmit={async (e) => {
                e.preventDefault();
                if (!text.trim()) {
                    setError("Write something first.");
                    return;
                }
                setBusy(true);
                setError(null);
                try {
                    await onSubmit(text.trim());
                } catch (err) {
                    setError(errorMessage(err));
                } finally {
                    setBusy(false);
                }
            }}
        >
            <Label htmlFor={id}>{label}</Label>
            <Textarea
                id={id}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={4000}
                disabled={disabled}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
            />
            <FieldError id={`${id}-error`} message={error} />
            <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy || disabled}>
                    {busy ? "Saving…" : submitLabel}
                </Button>
                {onCancel && (
                    <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
            </div>
        </form>
    );
}
