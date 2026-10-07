// A write-only secret (a GitHub token, a model key). The server only says whether it's set, who set it
// and when, and its last four characters; that's shown as text. A new value can replace it or it can be
// cleared, but the stored value is never shown or put back in the input.

import { useId, useState } from "react";
import { ConfirmAction } from "@/components/confirm-action";
import { FieldError } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { SecretView } from "@/lib/types";

/** "Set by Sam on 7 Oct 2026, ends …abcd", or "Not set". */
export function describeSecret(secret: Pick<SecretView, "set" | "hint" | "setBy" | "setAt">): string {
    if (!secret.set) return "Not set";
    const parts = ["Set"];
    if (secret.setBy) parts.push(`by ${secret.setBy}`);
    if (secret.setAt) parts.push(`on ${formatDate(secret.setAt)}`);
    let text = parts.join(" ");
    if (secret.hint) text += `, ends …${secret.hint}`;
    return text;
}

export interface SecretFieldProps {
    label: string;
    secret: SecretView;
    /** What the value is and where to get it. */
    hint?: string;
    /** May this person replace or clear it? Otherwise only the status is shown. */
    canEdit: boolean;
    onSave(value: string): Promise<unknown>;
    onClear(): Promise<unknown>;
}

export function SecretField({ label, secret, hint, canEdit, onSave, onClear }: SecretFieldProps) {
    const id = useId();
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const showInput = canEdit && (editing || !secret.set);

    const save = async () => {
        if (!value.trim()) {
            setError(`Enter the new ${label.toLowerCase()}.`);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onSave(value.trim());
            setValue("");
            setEditing(false);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="grid gap-2" data-testid="secret-field">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Label htmlFor={showInput ? id : undefined} id={`${id}-label`}>
                    {label}
                </Label>
                <p className="text-sm text-muted-foreground" id={`${id}-status`}>
                    {describeSecret(secret)}
                </p>
            </div>
            {hint && (
                <p className="text-xs text-muted-foreground" id={`${id}-hint`}>
                    {hint}
                </p>
            )}
            {showInput ? (
                <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                    }}
                >
                    <Input
                        id={id}
                        type="password"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        autoComplete="new-password"
                        spellCheck={false}
                        aria-describedby={[`${id}-status`, hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ")}
                        aria-invalid={error ? true : undefined}
                        className="min-w-0 flex-1 font-mono"
                    />
                    <Button type="submit" disabled={busy}>
                        {busy ? "Saving…" : secret.set ? "Save new value" : "Save"}
                    </Button>
                    {editing && (
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => {
                                setEditing(false);
                                setValue("");
                                setError(null);
                            }}
                        >
                            Cancel
                        </Button>
                    )}
                </form>
            ) : (
                canEdit && (
                    <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                            Replace
                        </Button>
                        <ConfirmAction
                            trigger={
                                <Button type="button" variant="outline" size="sm">
                                    Clear
                                </Button>
                            }
                            title={`Clear the ${label.toLowerCase()}?`}
                            description="The stored value is deleted. Anything that uses it stops working until a new one is set."
                            confirmLabel="Clear"
                            onConfirm={onClear}
                        />
                    </div>
                )
            )}
            <FieldError id={`${id}-error`} message={error} />
        </div>
    );
}
