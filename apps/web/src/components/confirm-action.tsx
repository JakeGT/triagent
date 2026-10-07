// Confirmation for destructive actions: an alert dialog that, for the worst ones, only enables its
// button once the person has typed the name of what they're about to destroy.

import { type ReactNode, useId, useState } from "react";
import { FieldError } from "@/components/field";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api";

export interface ConfirmActionProps {
    /** The button that opens the dialog. */
    trigger: ReactNode;
    title: string;
    description: ReactNode;
    /** The confirm button's text, e.g. "Delete project". */
    confirmLabel: string;
    /** If set, the person must type exactly this to confirm. */
    typeToConfirm?: string;
    /** Runs on confirm; the dialog stays open and shows the error if it throws. */
    onConfirm(): Promise<unknown> | unknown;
    destructive?: boolean;
}

export function ConfirmAction({
    trigger,
    title,
    description,
    confirmLabel,
    typeToConfirm,
    onConfirm,
    destructive = true,
}: ConfirmActionProps) {
    const [open, setOpen] = useState(false);
    const [typed, setTyped] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const inputId = useId();
    const matches = !typeToConfirm || typed === typeToConfirm;

    const reset = (next: boolean) => {
        setOpen(next);
        if (!next) {
            setTyped("");
            setError(null);
        }
    };

    const confirm = async () => {
        if (!matches || busy) return;
        setBusy(true);
        setError(null);
        try {
            await onConfirm();
            reset(false);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <AlertDialog open={open} onOpenChange={reset}>
            <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
            <AlertDialogContent>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        void confirm();
                    }}
                    className="grid gap-4"
                >
                    <AlertDialogHeader>
                        <AlertDialogTitle>{title}</AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div>{description}</div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    {typeToConfirm && (
                        <div className="grid gap-1.5">
                            <Label htmlFor={inputId}>
                                Type <strong className="font-mono">{typeToConfirm}</strong> to confirm
                            </Label>
                            <Input
                                id={inputId}
                                value={typed}
                                onChange={(e) => setTyped(e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                            />
                        </div>
                    )}
                    <FieldError message={error} />
                    <AlertDialogFooter>
                        <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
                        <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={!matches || busy}>
                            {busy ? "Working…" : confirmLabel}
                        </Button>
                    </AlertDialogFooter>
                </form>
            </AlertDialogContent>
        </AlertDialog>
    );
}
