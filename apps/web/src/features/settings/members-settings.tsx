import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ROLES, type Role } from "@triagent/shared";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Field, FieldError, FieldRow, NativeSelect } from "@/components/field";
import { FormActions } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, paths } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { keys, membersQuery } from "@/lib/queries";
import { useMe, useWorkspace } from "@/lib/session";
import type { Member } from "@/lib/types";
import { Invites } from "./invites";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

const ROLE_INFO: Record<Role, string> = {
    viewer: "Viewer: sees everything, changes nothing",
    editor: "Editor: also triages issues and tasks",
    admin: "Admin: also uploads, configures projects, sets secrets, and manages members and tokens",
    owner: "Owner: also renames the workspace and manages owners",
};

/** Roles you may hand out: only owners make or unmake owners. */
const assignable = (myRole: Role) => ROLES.filter((r) => r !== "owner" || myRole === "owner");

function MemberRow({ member, manage }: { member: Member; manage: boolean }) {
    const me = useMe();
    const { ws, role: myRole } = useWorkspace();
    const queryClient = useQueryClient();
    const selectId = useId();
    const [role, setRole] = useState<Role>(member.role);
    const isMe = member.user.id === me.user.id;
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.wsSettings(ws, "members") });
    const url = `${paths.workspace(ws)}/settings/members/${encodeURIComponent(member.user.id)}`;
    const change = useMutation({
        mutationFn: () => api.patch(url, { role }),
        onSuccess: async () => {
            await refresh();
            toast.success(`${member.user.displayName} is now ${role === "admin" || role === "editor" ? "an" : "a"} ${role}.`);
        },
    });
    const canChange = manage && !isMe && (member.role !== "owner" || myRole === "owner");
    return (
        <TableRow>
            <TableCell>
                <div className="font-medium">
                    {member.user.displayName}
                    {isMe && <span className="text-muted-foreground"> (you)</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                    {member.user.username}
                    {member.user.email ? ` · ${member.user.email}` : ""}
                </div>
            </TableCell>
            <TableCell>
                {canChange ? (
                    <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                            e.preventDefault();
                            change.mutate();
                        }}
                    >
                        <label htmlFor={selectId} className="sr-only">
                            Role of {member.user.displayName}
                        </label>
                        <NativeSelect id={selectId} value={role} onChange={(e) => setRole(e.target.value as Role)} className="h-8 w-28">
                            {assignable(myRole).map((r) => (
                                <option key={r} value={r}>
                                    {r}
                                </option>
                            ))}
                        </NativeSelect>
                        {role !== member.role && (
                            <Button type="submit" size="sm" disabled={change.isPending}>
                                Save<span className="sr-only"> role of {member.user.displayName}</span>
                            </Button>
                        )}
                        <FieldError message={change.error ? errorMessage(change.error) : null} className="w-full" />
                    </form>
                ) : (
                    <span className="capitalize">{member.role}</span>
                )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{formatDate(member.since)}</TableCell>
            <TableCell className="text-end">
                {manage && (isMe || canChange) && (
                    <ConfirmAction
                        trigger={
                            <Button size="sm" variant="ghost">
                                {isMe ? "Leave" : "Remove"}
                                <span className="sr-only"> {member.user.displayName}</span>
                            </Button>
                        }
                        title={isMe ? "Leave this workspace?" : `Remove ${member.user.displayName}?`}
                        description={
                            isMe
                                ? "You lose access to everything in this workspace until someone adds you again."
                                : "They lose access to this workspace, and API tokens that act for them here are revoked."
                        }
                        confirmLabel={isMe ? "Leave" : "Remove"}
                        onConfirm={async () => {
                            await api.delete(url);
                            await refresh();
                            if (isMe) await queryClient.invalidateQueries({ queryKey: keys.me });
                            toast.success(isMe ? "You left the workspace." : `${member.user.displayName} removed.`);
                        }}
                    />
                )}
            </TableCell>
        </TableRow>
    );
}

function AddMember() {
    const { ws, role: myRole } = useWorkspace();
    const queryClient = useQueryClient();
    const [username, setUsername] = useState("");
    const [role, setRole] = useState<Role>("editor");
    const add = useMutation({
        mutationFn: () =>
            api.post<{ user: { displayName: string } }>(`${paths.workspace(ws)}/settings/members`, { username: username.trim(), role }),
        onSuccess: async (r) => {
            await queryClient.invalidateQueries({ queryKey: keys.wsSettings(ws, "members") });
            setUsername("");
            toast.success(`${r.user.displayName} added.`);
        },
    });
    return (
        <SettingsSection
            title="Add a member"
            description="They need an account on this Triagent first: an instance administrator creates it under Users."
        >
            <form
                className="grid gap-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    add.mutate();
                }}
            >
                <FieldRow>
                    <Field label="Username">
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
                    <Field label="Role" hint={ROLE_INFO[role]}>
                        {(p) => (
                            <NativeSelect {...p} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                                {assignable(myRole).map((r) => (
                                    <option key={r} value={r}>
                                        {r}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                </FieldRow>
                <FieldError message={add.error ? errorMessage(add.error) : null} />
                <FormActions>
                    <Button type="submit" disabled={add.isPending || !username.trim()}>
                        Add member
                    </Button>
                </FormActions>
            </form>
        </SettingsSection>
    );
}

/** Adding people: by username (local accounts), or by inviting an email address (an identity provider). */
export function AddPeople() {
    const me = useMe();
    const { ws, workspace, role: myRole } = useWorkspace();
    return me.authMode === "local" ? (
        <AddMember />
    ) : (
        <Invites
            queryKey={keys.wsSettings(ws, "invites")}
            url={`${paths.workspace(ws)}/settings/invites`}
            roles={assignable(myRole)}
            roleInfo={ROLE_INFO}
            description={`Invite someone by email address to join ${workspace.name}. They join with this role when they next sign in with that address, and get an account here if they don't have one.`}
        />
    );
}

export function MembersSettings() {
    const { ws, workspace, can } = useWorkspace();
    const query = useQuery(membersQuery(ws));
    const manage = can("members");
    const personal = workspace.kind === "personal";
    return (
        <SettingsPage title="Members" description={`Who can use ${workspace.name}, and what their role lets them do.`}>
            {personal && (
                <p className="text-sm text-muted-foreground">
                    This is your personal workspace, so you're its only member. To work with others, create an organisation from the
                    workspace menu at the top of the sidebar.
                </p>
            )}
            {!manage && !personal && <ReadOnlyNote>Only admins of this workspace can add or remove members.</ReadOnlyNote>}
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : query.isPending ? (
                <LoadingRows rows={3} />
            ) : (
                <TableFrame>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Person</TableHead>
                                <TableHead>Role</TableHead>
                                <TableHead>Member since</TableHead>
                                <TableHead>
                                    <span className="sr-only">Actions</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {query.data.map((m) => (
                                <MemberRow key={m.user.id} member={m} manage={manage && !personal} />
                            ))}
                        </TableBody>
                    </Table>
                </TableFrame>
            )}
            <dl className="grid gap-1 text-xs text-muted-foreground">
                {ROLES.map((r) => (
                    <div key={r}>
                        <dt className="sr-only">{r}</dt>
                        <dd>{ROLE_INFO[r]}</dd>
                    </div>
                ))}
            </dl>
            {manage && !personal && <AddPeople />}
        </SettingsPage>
    );
}
