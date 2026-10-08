// Confirming it's you before a step that needs a recent sign-in (changing secrets, members, API tokens or
// the workspace, and the instance's accounts and keys). The API client asks
// through `requestReauth` when the server answers 401 reauth_required; this dialog explains why and
// either takes the password (local accounts), after which the step is sent again, or sends the person
// to sign in at the identity provider and back to the same page.

import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { FieldError } from "@/components/field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { errorMessage, request } from "@/lib/api";
import { authConfigQuery } from "@/lib/queries";
import type { ApiErrorBody } from "@/lib/types";

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
        typeof reauthUrl === "string" && reauthUrl.startsWith("/auth/login") ? reauthUrl : "/auth/login?prompt=login&max_age=0",
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
    const provider = pending?.body.method === "provider";
    const providerName = config.data?.providerName ?? "your identity provider";

    const close = (ok: boolean) => {
        setPassword("");
        setError(null);
        settle(ok);
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
                            ? `${WHY} Sign in with ${providerName} again and you'll come back to this page. Anything you typed here will need entering again.`
                            : `${WHY} Enter your password to carry on.`}
                    </DialogDescription>
                </DialogHeader>
                {provider ? (
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => close(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            onClick={() => {
                                const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
                                window.location.assign(reauthHref(pending?.body.reauthUrl, here));
                            }}
                        >
                            Sign in with {providerName}
                        </Button>
                    </DialogFooter>
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
