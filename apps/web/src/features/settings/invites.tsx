// Invites by email address, for the instance (Users) and for a workspace (Members). The person accepts
// by signing in through the identity provider with that address; until email delivery exists, whoever
// sends the invite tells them, and the server's hint says how to get onto the provider's allowlist.

import { type QueryKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Role } from "@triagent/shared";
import { Info } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Field, FieldError, FieldRow, NativeSelect } from "@/components/field";
import { FormActions } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Invite, InviteList } from "@/lib/types";
import { SettingsSection } from "./settings-page";

const STATUS: Record<Invite["status"], string> = { pending: "Waiting", expired: "Expired", accepted: "Accepted" };

export interface InvitesProps {
    /** The list's cache key (see lib/queries.ts). */
    queryKey: QueryKey;
    /** Where invites are listed and created; DELETE `${url}/{id}` revokes one. */
    url: string;
    /** Workspace invites carry a role (only those you may hand out); instance invites don't. */
    roles?: readonly Role[];
    roleInfo?: Record<Role, string>;
    description: string;
}

export function Invites({ queryKey, url, roles, roleInfo, description }: InvitesProps) {
    const queryClient = useQueryClient();
    const query = useQuery({ queryKey, queryFn: ({ signal }) => api.get<InviteList>(url, undefined, { signal }) });
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<Role>("editor");
    const [sent, setSent] = useState<{ email: string; hint: string | null } | null>(null);
    const refresh = () => queryClient.invalidateQueries({ queryKey });
    const create = useMutation({
        mutationFn: () => api.post<{ invite: Invite; hint: string | null }>(url, { email: email.trim(), ...(roles ? { role } : {}) }),
        onSuccess: async (r) => {
            setSent({ email: r.invite.email, hint: r.hint });
            setEmail("");
            await refresh();
        },
    });

    return (
        <SettingsSection title="Invites" description={description}>
            {sent && (
                <Alert>
                    <Info />
                    <AlertTitle>Invite ready for {sent.email}</AlertTitle>
                    <AlertDescription>
                        <p>Let them know: they accept it by signing in with that email address. No email is sent for now.</p>
                        {sent.hint && <p>{sent.hint}</p>}
                    </AlertDescription>
                </Alert>
            )}
            <form
                className="grid gap-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    setSent(null);
                    create.mutate();
                }}
            >
                <FieldRow>
                    <Field label="Email address">
                        {(p) => (
                            <Input
                                {...p}
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                maxLength={254}
                                autoComplete="off"
                            />
                        )}
                    </Field>
                    {roles && (
                        <Field label="Role" hint={roleInfo?.[role]}>
                            {(p) => (
                                <NativeSelect {...p} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                                    {roles.map((r) => (
                                        <option key={r} value={r}>
                                            {r}
                                        </option>
                                    ))}
                                </NativeSelect>
                            )}
                        </Field>
                    )}
                </FieldRow>
                <FieldError message={create.error ? errorMessage(create.error) : null} />
                <FormActions>
                    <Button type="submit" disabled={create.isPending || !email.trim()}>
                        {create.isPending ? "Inviting…" : "Invite"}
                    </Button>
                </FormActions>
            </form>
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : query.isPending ? (
                <LoadingRows rows={2} />
            ) : query.data.items.length ? (
                <TableFrame>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Email address</TableHead>
                                {roles && <TableHead>Role</TableHead>}
                                <TableHead>Status</TableHead>
                                <TableHead>
                                    <span className="sr-only">Actions</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {query.data.items.map((i) => (
                                <TableRow key={i.id}>
                                    <TableCell>
                                        <div className="font-medium break-all">{i.email}</div>
                                        <div className="text-xs text-muted-foreground">
                                            {i.createdBy ? `Invited by ${i.createdBy.displayName}` : "Invited"} on {formatDate(i.createdAt)}
                                        </div>
                                    </TableCell>
                                    {roles && <TableCell className="capitalize">{i.role}</TableCell>}
                                    <TableCell className="text-xs">
                                        <Badge variant={i.status === "pending" ? "secondary" : "outline"}>{STATUS[i.status]}</Badge>
                                        <div className="mt-1 text-muted-foreground">
                                            {i.status === "accepted"
                                                ? `${i.acceptedBy ? `${i.acceptedBy.displayName}, ` : ""}${formatDate(i.acceptedAt as string)}`
                                                : `${i.status === "expired" ? "Expired" : "Until"} ${formatDate(i.expiresAt)}`}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-end">
                                        {i.status !== "accepted" && (
                                            <ConfirmAction
                                                trigger={
                                                    <Button size="sm" variant="ghost">
                                                        Revoke<span className="sr-only"> the invite for {i.email}</span>
                                                    </Button>
                                                }
                                                title={`Revoke the invite for ${i.email}?`}
                                                description="Signing in with that address no longer creates an account or joins anything."
                                                confirmLabel="Revoke invite"
                                                onConfirm={async () => {
                                                    await api.delete(`${url}/${encodeURIComponent(i.id)}`);
                                                    await refresh();
                                                    toast.success(`Invite for ${i.email} revoked.`);
                                                }}
                                            />
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableFrame>
            ) : (
                <p className="text-sm text-muted-foreground">No invites yet.</p>
            )}
        </SettingsSection>
    );
}
