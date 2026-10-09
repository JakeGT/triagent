import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { providerSignInUrl } from "@/lib/api";
import { authConfigQuery } from "@/lib/queries";
import { AuthLayout } from "./auth-layout";

/** Where the server sends someone the provider let in, but who has no account here and no invite. */
export function InviteRequiredPage() {
    const config = useQuery(authConfigQuery);
    const provider = config.data?.providerName ?? "your identity provider";
    return (
        <AuthLayout
            title="You need an invite"
            description={`${provider} signed you in, but there's no account here for you yet, and no invite for your email address.`}
        >
            <div className="grid gap-4 text-sm">
                {config.data?.inviteHint && <p className="rounded-md border bg-muted/50 px-3 py-2">{config.data.inviteHint}</p>}
                <p className="text-muted-foreground">
                    Ask someone who uses this Triagent to invite the email address you sign in with. Once they have, sign in again.
                </p>
                <Button asChild>
                    <a href={providerSignInUrl("/dashboard", { prompt: "login" })}>Sign in again</a>
                </Button>
                <Button asChild variant="link" className="px-0">
                    <Link to="/sign-in">Back to the sign-in page</Link>
                </Button>
            </div>
        </AuthLayout>
    );
}
