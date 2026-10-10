import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserMinus } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { CheckField, Field, FieldError, FieldRow } from "@/components/field";
import { FormActions } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { OneTimeReveal } from "@/components/one-time-reveal";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, paths } from "@/lib/api";
import { formatDate, plural, timeAgo } from "@/lib/format";
import { instanceUsersQuery, keys } from "@/lib/queries";
import { useMe } from "@/lib/session";
import type { InstanceUser, PublicUser } from "@/lib/types";
import { Invites } from "./invites";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

interface Revealed {
    label: string;
    value: string;
}

function CreateAccount({ onPassword }: { onPassword(r: Revealed): void }) {
    const queryClient = useQueryClient();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [isAdmin, setIsAdmin] = useState(false);
    const create = useMutation({
        mutationFn: () =>
            api.post<{ user: PublicUser; password: string | null }>(paths.instanceUsers, {
                username: username.trim(),
                isInstanceAdmin: isAdmin,
                ...(password ? { password } : {}),
            }),
        onSuccess: async (r) => {
            if (r.password) onPassword({ label: `Temporary password for ${r.user.username}`, value: r.password });
            else toast.success(`Account ${r.user.username} created.`);
            setUsername("");
            setPassword("");
            setIsAdmin(false);
            await queryClient.invalidateQueries({ queryKey: keys.instanceUsers });
        },
    });
    return (
        <SettingsSection
            title="Create an account"
            description="The person signs in with this username and a temporary password, and must choose their own straight away. Add them to workspaces under Members."
        >
            <form
                className="grid gap-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
                }}
            >
                <FieldRow>
                    <Field label="Username" hint="Letters, numbers and . _ @ -">
                        {(p) => (
                            <Input
                                {...p}
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                required
                                maxLength={64}
                                autoComplete="off"
                            />
                        )}
                    </Field>
                    <Field label="Temporary password" hint="Leave empty to have one generated and shown once.">
                        {(p) => (
                            <PasswordInput
                                {...p}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete="new-password"
                            />
                        )}
                    </Field>
                </FieldRow>
                <CheckField label="Instance administrator" hint="Can manage every account on this Triagent.">
                    {(p) => <Checkbox {...p} checked={isAdmin} onCheckedChange={(v) => setIsAdmin(v === true)} />}
                </CheckField>
                <FieldError message={create.error ? errorMessage(create.error) : null} />
                <FormActions>
                    <Button type="submit" disabled={create.isPending || !username.trim()}>
                        {create.isPending ? "Creating…" : "Create account"}
                    </Button>
                </FormActions>
            </form>
        </SettingsSection>
    );
}

function UserActions({ user, onPassword }: { user: InstanceUser; onPassword(r: Revealed): void }) {
    const queryClient = useQueryClient();
    const [error, setError] = useState<string | null>(null);
    const url = `${paths.instanceUsers}/${encodeURIComponent(user.id)}`;
    const name = user.username ?? user.displayName;
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.instanceUsers });
    const run = async (fn: () => Promise<void>) => {
        setError(null);
        try {
            await fn();
        } catch (err) {
            setError(errorMessage(err));
            throw err;
        }
    };
    return (
        <div className="grid justify-items-end gap-1">
            <div className="flex flex-col items-stretch gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
                {user.signsInWith === "password" && (
                    <ConfirmAction
                        trigger={
                            <Button size="sm" variant="outline">
                                Reset password<span className="sr-only"> of {name}</span>
                            </Button>
                        }
                        title={`Reset ${name}'s password?`}
                        description="A temporary password is generated and shown once. They're signed out everywhere and must choose a new password when they next sign in."
                        confirmLabel="Reset password"
                        destructive={false}
                        onConfirm={() =>
                            run(async () => {
                                const r = await api.post<{ password: string | null; signedOutSessions: number }>(`${url}/password`, {});
                                if (r.password) onPassword({ label: `Temporary password for ${name}`, value: r.password });
                                await refresh();
                            })
                        }
                    />
                )}
                <ConfirmAction
                    trigger={
                        <Button size="sm" variant="outline">
                            Sign out<span className="sr-only"> {name}</span>
                        </Button>
                    }
                    title={`Sign ${name} out everywhere?`}
                    description="Every browser session of this account ends. Their API tokens keep working."
                    confirmLabel="Sign out everywhere"
                    destructive={false}
                    onConfirm={() =>
                        run(async () => {
                            const r = await api.post<{ signedOutSessions: number }>(`${url}/sign-out`, {});
                            await refresh();
                            toast.success(`${name} signed out of ${plural(r.signedOutSessions, "session")}.`);
                        })
                    }
                />
                <ConfirmAction
                    trigger={
                        <Button size="sm" variant="danger" className="mt-2 sm:ms-3 sm:mt-0">
                            <UserMinus /> Remove<span className="sr-only"> {name}</span>
                        </Button>
                    }
                    title={`Remove ${name}?`}
                    description="The account, its personal workspace and its memberships are deleted. This can't be undone."
                    confirmLabel="Remove account"
                    typeToConfirm={name}
                    onConfirm={() =>
                        run(async () => {
                            await api.delete(url);
                            await refresh();
                            toast.success(`${name} removed.`);
                        })
                    }
                />
            </div>
            <FieldError message={error} />
        </div>
    );
}

export function UsersSettings() {
    const me = useMe();
    const allowed = me.user.isInstanceAdmin;
    const provider = me.authMode === "oidc";
    const query = useQuery({ ...instanceUsersQuery, enabled: allowed });
    // A generated password lives only here, shown once.
    const [revealed, setRevealed] = useState<Revealed | null>(null);
    const dismiss = useCallback(() => setRevealed(null), []);

    if (!allowed)
        return (
            <SettingsPage title="Users">
                <ReadOnlyNote>Only instance administrators can manage accounts.</ReadOnlyNote>
            </SettingsPage>
        );

    return (
        <SettingsPage
            title="Users"
            description={
                provider
                    ? "Everyone with an account on this Triagent, across all workspaces. People sign in through the identity provider, which looks after their passwords; members of its admin group are instance administrators."
                    : "Every local account on this Triagent, across all workspaces."
            }
        >
            {revealed && (
                <OneTimeReveal
                    value={revealed.value}
                    label={revealed.label}
                    hint="Give it to the person privately. They must choose their own password when they sign in."
                    onDismiss={dismiss}
                />
            )}
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : query.isPending ? (
                <LoadingRows rows={3} />
            ) : (
                <TableFrame>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Account</TableHead>
                                <TableHead className="hidden sm:table-cell">Status</TableHead>
                                <TableHead className="hidden sm:table-cell">Last sign-in</TableHead>
                                <TableHead>
                                    <span className="sr-only">Actions</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {query.data.map((u) => (
                                <TableRow key={u.id} className="align-top">
                                    <TableCell className="whitespace-normal">
                                        <div className="font-medium break-all">
                                            {u.username ?? u.displayName}
                                            {u.id === me.user.id && <span className="text-muted-foreground"> (you)</span>}
                                        </div>
                                        {u.email && <div className="text-xs break-all text-muted-foreground">{u.email}</div>}
                                        <div className="text-xs text-muted-foreground">Created {formatDate(u.createdAt)}</div>
                                    </TableCell>
                                    <TableCell className="hidden text-xs sm:table-cell">
                                        <ul className="grid gap-0.5">
                                            {u.isInstanceAdmin && <li>Instance administrator</li>}
                                            {u.mustChangePassword && <li>Must choose a new password</li>}
                                            <li>{plural(u.sessions, "active session")}</li>
                                        </ul>
                                    </TableCell>
                                    <TableCell className="hidden text-xs sm:table-cell">
                                        {u.lastLoginAt ? timeAgo(u.lastLoginAt) : "Never"}
                                    </TableCell>
                                    <TableCell className="text-end">
                                        {u.id !== me.user.id && <UserActions user={u} onPassword={setRevealed} />}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableFrame>
            )}
            {provider ? (
                <Invites
                    queryKey={keys.instanceInvites}
                    url={paths.instanceInvites}
                    description="Invite an email address to have an account here. They accept by signing in with that address (it must be verified by the identity provider). Members of the admin group don't need an invite."
                />
            ) : (
                <CreateAccount onPassword={setRevealed} />
            )}
        </SettingsPage>
    );
}
