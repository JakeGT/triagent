import { useActionState } from "react";
import { Field, FieldError } from "@/components/field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { api, errorMessage, paths } from "@/lib/api";

const MIN_PASSWORD = 12;

/** Change your own password: used by the forced change after first sign-in and by Settings. */
export function PasswordForm({ onChanged, submitLabel = "Change password" }: { onChanged(signedOut: number): void; submitLabel?: string }) {
    const [state, change, pending] = useActionState<{ error: string | null; field?: "current" | "password" | "confirm" }, FormData>(
        async (_previous, form) => {
            const current = String(form.get("current") ?? "");
            const password = String(form.get("password") ?? "");
            const confirm = String(form.get("confirm") ?? "");
            if (!current) return { error: "Enter your current password.", field: "current" };
            if (password.length < MIN_PASSWORD) return { error: `Use at least ${MIN_PASSWORD} characters.`, field: "password" };
            if (password !== confirm) return { error: "The two new passwords don't match.", field: "confirm" };
            try {
                const out = await api.post<{ signedOutSessions: number }>(`${paths.me}/password`, { current, password });
                onChanged(out.signedOutSessions);
                return { error: null };
            } catch (err) {
                return { error: errorMessage(err) };
            }
        },
        { error: null },
    );
    const fieldError = (f: "current" | "password" | "confirm") => (state.field === f ? state.error : null);

    return (
        <form action={change} className="grid max-w-sm gap-4" noValidate>
            <Field label="Current password" error={fieldError("current")}>
                {(p) => <PasswordInput {...p} name="current" autoComplete="current-password" required />}
            </Field>
            <Field
                label="New password"
                hint={`At least ${MIN_PASSWORD} characters, not containing your username.`}
                error={fieldError("password")}
            >
                {(p) => <PasswordInput {...p} name="password" autoComplete="new-password" required minLength={MIN_PASSWORD} />}
            </Field>
            <Field label="New password again" error={fieldError("confirm")}>
                {(p) => <PasswordInput {...p} name="confirm" autoComplete="new-password" required />}
            </Field>
            {!state.field && <FieldError message={state.error} />}
            <div>
                <Button type="submit" disabled={pending}>
                    {pending ? "Saving…" : submitLabel}
                </Button>
            </div>
        </form>
    );
}
