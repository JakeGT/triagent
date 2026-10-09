// Where the sign-in window opened to confirm it's you comes back to: it tells the page that opened it
// (over a BroadcastChannel: the opener link is cut by Cross-Origin-Opener-Policy once the window has been
// to the identity provider) and closes. Opened by itself, it's just a way home.

import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { REAUTH_CHANNEL } from "@/components/reauth-dialog";

export function ReauthenticatedPage() {
    useEffect(() => {
        try {
            const channel = new BroadcastChannel(REAUTH_CHANNEL);
            channel.postMessage({ type: "reauthenticated" });
            channel.close();
        } catch {
            // No BroadcastChannel: the page that asked offers to carry on by hand.
        }
        window.close();
    }, []);
    return (
        <main className="grid min-h-svh place-items-center p-6 text-center">
            <div className="grid gap-2">
                <h1 className="text-lg font-semibold">You're signed in again</h1>
                <p className="text-sm text-muted-foreground">You can close this window and carry on where you were.</p>
                <Link to="/dashboard" className="text-sm underline">
                    Go to Triagent
                </Link>
            </div>
        </main>
    );
}
