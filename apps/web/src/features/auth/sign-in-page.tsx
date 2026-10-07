import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { useActionState } from "react";
import { Field, FieldError } from "@/components/field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, request, setCsrfToken } from "@/lib/api";
import { meQuery } from "@/lib/queries";
import { AuthLayout } from "./auth-layout";

interface State {
    error: string | null;
    username: string;
}

export function SignInPage() {
    const { redirect } = useSearch({ from: "/sign-in" });
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const router = useRouter();

    const [state, signIn, pending] = useActionState<State, FormData>(
        async (_previous, form) => {
            const username = String(form.get("username") ?? "").trim();
            const password = String(form.get("password") ?? "");
            if (!username || !password) return { error: "Enter your username and password.", username };
            try {
                await request("/auth/login", { method: "POST", body: { username, password }, quiet401: true });
                // Nothing from a previous session should leak into this one.
                queryClient.clear();
                const me = await queryClient.fetchQuery(meQuery);
                setCsrfToken(me.csrf);
                if (me.mustChangePassword) await navigate({ to: "/change-password" });
                else if (redirect) router.history.push(redirect);
                else await navigate({ to: "/" });
                return { error: null, username };
            } catch (err) {
                return { error: errorMessage(err), username };
            }
        },
        { error: null, username: "" },
    );

    return (
        <AuthLayout title="Sign in" description="Use the account an administrator created for you.">
            <form action={signIn} className="grid gap-4" noValidate>
                <Field label="Username">
                    {(p) => <Input {...p} name="username" autoComplete="username" defaultValue={state.username} required autoFocus />}
                </Field>
                <Field label="Password">{(p) => <PasswordInput {...p} name="password" autoComplete="current-password" required />}</Field>
                <FieldError message={state.error} />
                <Button type="submit" disabled={pending}>
                    {pending ? "Signing in…" : "Sign in"}
                </Button>
            </form>
        </AuthLayout>
    );
}
