// Confirming it's you before a step that needs a recent sign-in (changing secrets, members, API tokens or
// the workspace, and the instance's accounts and keys). The API client asks
// through `requestReauth` when the server answers 401 reauth_required; this dialog explains why and
// either takes the password (local accounts), or has the person sign in at the identity provider in a
// window of its own, which comes back to /reauthenticated and says so here. Either way the page stays as
// it was and the step is sent again. If the window can't open (a popup blocker), the whole page goes to
// the identity provider and back instead, and what was typed is lost.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FieldError } from "@/components/field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { errorMessage, request, setCsrfToken } from "@/lib/api";
import { authConfigQuery, meQuery } from "@/lib/queries";
import type { ApiErrorBody, Me } from "@/lib/types";

/** How the sign-in window tells this page it's done (features/auth/reauthenticated-page.tsx). */
export const REAUTH_CHANNEL = "triagent-reauth";

/** What asks: the server's RECENT_SIGN_IN permissions, and the instance's accounts and keys. */
const WHY = "Changing secrets, members, API tokens or the workspace needs a recent sign-in.";

interface Pending {
    body: ApiErrorBody;
    promise: Promise<boolean>;
    resolve(ok: boolean): void;
}

let current: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => {
    for (const l of listeners) l();
};

/** Ask the person to confirm it's them. Several steps asking at once share one dialog. */
export function requestReauth(body: ApiErrorBody): Promise<boolean> {
    if (current) return current.promise;
    let resolve: (ok: boolean) => void = () => {};
    const promise = new Promise<boolean>((r) => {
        resolve = r;
    });
    current = { body, promise, resolve };
    emit();
    return promise;
}

function settle(ok: boolean): void {
    const pending = current;
    current = null;
    emit();
    pending?.resolve(ok);
}

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** The provider sign-in address from the server, coming back to this page. Only ever a path on this site. */
export function reauthHref(reauthUrl: unknown, here: string): string {
    const url = new URL(
        typeof reauthUrl === "string" && reauthUrl.startsWith("/auth/login") ? reauthUrl : "/auth/login?prompt=login&max_age=60",
        "http://x",
    );
    url.searchParams.set("next", here.startsWith("/") && !here.startsWith("//") ? here : "/");
    return `${url.pathname}${url.search}`;
}

export function ReauthDialog() {
    const pending = useSyncExternalStore(subscribe, () => current);
    const config = useQuery({ ...authConfigQuery, enabled: Boolean(pending) });
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // The sign-in window is open: waiting for it to say it's done.
    const [waiting, setWaiting] = useState(false);
    const queryClient = useQueryClient();
    const provider = pending?.body.method === "provider";
    const providerName = config.data?.providerName ?? "your identity provider";

    const close = (ok: boolean) => {
        setPassword("");
        setError(null);
        setWaiting(false);
        settle(ok);
    };

    // Signing in again starts a new session, with a new CSRF token: fetch it before the step is sent again.
    const signedIn = async () => {
        setBusy(true);
        try {
            const me = await request<Me>("/api/v1/me", { quiet401: true, noReauth: true });
            setCsrfToken(me.csrf);
            queryClient.setQueryData(meQuery.queryKey, me);
            close(true);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    // The latest signedIn, for the channel's listener (set up once per wait).
    const onSignedIn = useRef(signedIn);
    onSignedIn.current = signedIn;
    useEffect(() => {
        if (!waiting) return;
        let channel: BroadcastChannel | null = null;
        try {
            channel = new BroadcastChannel(REAUTH_CHANNEL);
            channel.onmessage = (e: MessageEvent) => {
                if ((e.data as { type?: string } | null)?.type === "reauthenticated") void onSignedIn.current();
            };
        } catch {
            // No BroadcastChannel: "I've signed in" below does the same.
        }
        return () => channel?.close();
    }, [waiting]);

    const openSignIn = () => {
        const back = reauthHref(pending?.body.reauthUrl, "/reauthenticated");
        const opened = window.open(back, "triagent-reauth", "popup,width=520,height=720");
        if (opened) {
            setError(null);
            setWaiting(true);
            return;
        }
        // Blocked: the whole page goes, and comes back here.
        const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        window.location.assign(reauthHref(pending?.body.reauthUrl, here));
    };

    const confirm = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!password) return setError("Enter your password.");
        setBusy(true);
        setError(null);
        try {
            await request("/auth/reauth", { method: "POST", body: { password }, noReauth: true });
            close(true);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && close(false)}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Confirm it's you</DialogTitle>
                    <DialogDescription>
                        {provider
                            ? waiting
                                ? `Sign in with ${providerName} in the window that opened. This carries on by itself once you have.`
                                : `${WHY} Sign in with ${providerName} again in a new window; this page stays as it is, and what you asked for carries on once you have.`
                            : `${WHY} Enter your password to carry on.`}
                    </DialogDescription>
                </DialogHeader>
                {provider ? (
                    <>
                        <FieldError message={error} />
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => close(false)}>
                                Cancel
                            </Button>
                            {waiting ? (
                                <>
                                    <Button type="button" variant="outline" onClick={openSignIn}>
                                        Open the window again
                                    </Button>
                                    <Button type="button" onClick={() => void signedIn()} disabled={busy}>
                                        {busy ? "Checking…" : "I've signed in"}
                                    </Button>
                                </>
                            ) : (
                                <Button type="button" onClick={openSignIn}>
                                    Sign in with {providerName}
                                </Button>
                            )}
                        </DialogFooter>
                    </>
                ) : (
                    <form onSubmit={confirm} className="grid gap-form" noValidate>
                        <div className="grid gap-1.5">
                            <Label htmlFor="reauth-password">Password</Label>
                            <PasswordInput
                                id="reauth-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete="current-password"
                                aria-invalid={error ? true : undefined}
                                aria-describedby={error ? "reauth-error" : undefined}
                                autoFocus
                            />
                            <FieldError id="reauth-error" message={error} />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => close(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={busy}>
                                {busy ? "Checking…" : "Confirm"}
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
