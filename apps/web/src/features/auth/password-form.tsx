import { useState } from "react";
import { Field, FieldError } from "@/components/field";
import { FormActions } from "@/components/form";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { api, errorMessage, paths } from "@/lib/api";

const MIN_PASSWORD = 12;

type FieldName = "current" | "password" | "confirm";

/** Change your own password: used by the forced change after first sign-in and by Settings. */
export function PasswordForm({ onChanged, submitLabel = "Change password" }: { onChanged(signedOut: number): void; submitLabel?: string }) {
    // Controlled, so a refused attempt keeps what was typed.
    const [values, setValues] = useState<Record<FieldName, string>>({ current: "", password: "", confirm: "" });
    const set = (f: FieldName) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [f]: e.target.value }));

    const [state, setState] = useState<{ error: string | null; field?: FieldName }>({ error: null });
    const [pending, setPending] = useState(false);

    const change = async (e: React.FormEvent) => {
        e.preventDefault();
        const { current, password, confirm } = values;
        if (!current) return setState({ error: "Enter your current password.", field: "current" });
        if (password.length < MIN_PASSWORD) return setState({ error: `Use at least ${MIN_PASSWORD} characters.`, field: "password" });
        if (password !== confirm) return setState({ error: "The two new passwords don't match.", field: "confirm" });
        setPending(true);
        try {
            const out = await api.post<{ signedOutSessions: number }>(`${paths.me}/password`, { current, password });
            setValues({ current: "", password: "", confirm: "" });
            setState({ error: null });
            onChanged(out.signedOutSessions);
        } catch (err) {
            setState({ error: errorMessage(err) });
        } finally {
            setPending(false);
        }
    };
    const fieldError = (f: FieldName) => (state.field === f ? state.error : null);

    return (
        <form onSubmit={change} className="grid max-w-control-lg gap-form" noValidate>
            <Field label="Current password" error={fieldError("current")}>
                {(p) => <PasswordInput {...p} value={values.current} onChange={set("current")} autoComplete="current-password" required />}
            </Field>
            <Field
                label="New password"
                hint={`At least ${MIN_PASSWORD} characters, not containing your username.`}
                error={fieldError("password")}
            >
                {(p) => (
                    <PasswordInput
                        {...p}
                        value={values.password}
                        onChange={set("password")}
                        autoComplete="new-password"
                        required
                        minLength={MIN_PASSWORD}
                    />
                )}
            </Field>
            <Field label="New password again" error={fieldError("confirm")}>
                {(p) => <PasswordInput {...p} value={values.confirm} onChange={set("confirm")} autoComplete="new-password" required />}
            </Field>
            {!state.field && <FieldError message={state.error} />}
            <FormActions>
                <Button type="submit" disabled={pending}>
                    {pending ? "Saving…" : submitLabel}
                </Button>
            </FormActions>
        </form>
    );
}
