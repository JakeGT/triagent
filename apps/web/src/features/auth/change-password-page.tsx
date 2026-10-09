import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { keys } from "@/lib/queries";
import { AuthLayout } from "./auth-layout";
import { PasswordForm } from "./password-form";
import { useSignOut } from "./use-sign-out";

/** Shown instead of everything else until an account with a temporary password sets its own. */
export function ChangePasswordPage() {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const signOut = useSignOut();
    return (
        <AuthLayout title="Choose a new password" description="Your account has a temporary password. Choose your own before you continue.">
            <PasswordForm
                submitLabel="Save and continue"
                onChanged={async () => {
                    await queryClient.invalidateQueries({ queryKey: keys.me });
                    await navigate({ to: "/dashboard" });
                }}
            />
            <Button variant="link" className="px-0" onClick={() => signOut.mutate()}>
                Sign out instead
            </Button>
        </AuthLayout>
    );
}
