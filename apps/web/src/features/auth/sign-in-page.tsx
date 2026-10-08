import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import { useActionState } from "react";
import { Field, FieldError } from "@/components/field";
import { LoadingRows } from "@/components/load-state";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, providerSignInUrl, request, setCsrfToken } from "@/lib/api";
import { authConfigQuery, meQuery } from "@/lib/queries";
import type { AuthConfig } from "@/lib/types";
import { AuthLayout } from "./auth-layout";

export type SignInError = "expired" | "denied" | "failed" | "unavailable";

/** Why the last attempt through the identity provider didn't work, in plain words. */
export function signInErrorMessage(error: SignInError, provider: string): string {
    switch (error) {
        case "expired":
            return "That sign-in took too long, or was started in another tab or browser. Try again.";
        case "denied":
            return `${provider} didn't sign you in. If you think you should have access, ask whoever runs this Triagent.`;
        case "unavailable":
            return `Couldn't reach ${provider}. Try again in a moment.`;
        default:
            return "Your sign-in couldn't be checked, so you're not signed in. Try again, and if it keeps happening, tell whoever runs this Triagent.";
    }
}

function ProviderSignIn({ config, redirect, error }: { config: AuthConfig; redirect?: string; error?: SignInError }) {
    const provider = config.providerName ?? "your identity provider";
    return (
        <AuthLayout title="Sign in" description={`Use your ${provider} account.`}>
            <div className="grid gap-4">
                <FieldError message={error ? signInErrorMessage(error, provider) : null} />
                {/* A plain link, not a form: the server redirects to the provider, which a form's CSP (form-action 'self') would block. */}
                <Button asChild>
                    <a href={providerSignInUrl(redirect ?? "/")}>
                        <LogIn /> Sign in with {provider}
                    </a>
                </Button>
            </div>
        </AuthLayout>
    );
}

interface State {
    error: string | null;
    username: string;
}

function PasswordSignIn({ redirect }: { redirect?: string }) {
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

export function SignInPage() {
    const { redirect, error } = useSearch({ from: "/sign-in" });
    const config = useQuery(authConfigQuery);
    if (config.isPending)
        return (
            <AuthLayout title="Sign in">
                <LoadingRows rows={2} />
            </AuthLayout>
        );
    // If the server can't say, offer the password form: it explains itself if passwords are off.
    if (config.data?.mode === "oidc") return <ProviderSignIn config={config.data} redirect={redirect} error={error} />;
    return <PasswordSignIn redirect={redirect} />;
}
