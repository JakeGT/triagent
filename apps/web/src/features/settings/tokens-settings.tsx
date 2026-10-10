import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SCOPE_INFO, scopesFor, TOKEN_SCOPES, type TokenScope } from "@triagent/shared";
import { Ban } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { ChoiceField, Field, FieldError, FieldRow, NativeSelect } from "@/components/field";
import { FormActions } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { OneTimeReveal } from "@/components/one-time-reveal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, paths } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { keys, membersQuery, tokensQuery } from "@/lib/queries";
import { useMe, useWorkspace } from "@/lib/session";
import type { ApiToken } from "@/lib/types";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

function CreateToken({ onCreated }: { onCreated(token: string): void }) {
    const me = useMe();
    const { ws, role: myRole } = useWorkspace();
    const queryClient = useQueryClient();
    const members = useQuery(membersQuery(ws));
    const [name, setName] = useState("");
    const [scope, setScope] = useState<TokenScope>("full");
    const [days, setDays] = useState("90");
    const [owner, setOwner] = useState(me.user.id);
    // A token has at most the access of the member it acts for: only their scopes can be chosen.
    const list = members.data ?? [{ user: me.user, role: myRole, since: "" }];
    const ownerMember = list.find((m) => m.user.id === owner);
    const allowed = ownerMember ? scopesFor(ownerMember.role) : [];
    const chosen = allowed.includes(scope) ? scope : (allowed.at(-1) ?? scope);
    const create = useMutation({
        mutationFn: () =>
            api.post<{ token: string; record: ApiToken }>(`${paths.workspace(ws)}/settings/tokens`, {
                name: name.trim(),
                scope: chosen,
                expiresInDays: days.trim() ? Number(days) : null,
                ownerUserId: owner,
            }),
        onSuccess: async (r) => {
            onCreated(r.token);
            setName("");
            await queryClient.invalidateQueries({ queryKey: keys.wsSettings(ws, "tokens") });
        },
    });
    return (
        <SettingsSection title="Create a token" description="For an agent, a CI job or a script. A token belongs to this workspace only.">
            <form
                className="grid gap-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
                }}
            >
                <Field label="Name" hint="Shown as the author of what the token changes, e.g. “Claude on Sam's laptop”.">
                    {(p) => (
                        <Input {...p} value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} autoComplete="off" />
                    )}
                </Field>
                <FieldRow>
                    <Field
                        label="Acts for"
                        hint="The member it works for: it has at most their access, loses what they lose, and is revoked if they leave. They hear about the reviews it starts."
                    >
                        {(p) => (
                            <NativeSelect {...p} value={owner} onChange={(e) => setOwner(e.target.value)}>
                                {list.map((m) => (
                                    <option key={m.user.id} value={m.user.id}>
                                        {m.user.displayName}
                                        {m.user.id === me.user.id ? " (you)" : ""} · {m.role}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                    <Field label="Expires after (days)" hint="Empty for a token that never expires." width="xs">
                        {(p) => <Input {...p} type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />}
                    </Field>
                </FieldRow>
                <ChoiceField
                    legend="Access"
                    name="scope"
                    value={chosen}
                    onChange={setScope}
                    choices={TOKEN_SCOPES.map((s) => ({
                        value: s,
                        label: (
                            <>
                                {SCOPE_INFO[s]} (<code className="font-mono">{s}</code>)
                            </>
                        ),
                        ...(allowed.includes(s)
                            ? {}
                            : {
                                  disabled: true,
                                  hint: `More than ${ownerMember?.user.id === me.user.id ? "you have" : `${ownerMember?.user.displayName ?? "they"} has`} as ${ownerMember?.role ?? "a member"}.`,
                              }),
                    }))}
                    hint="No token can manage members or tokens, or set secrets: those stay with people signed in here."
                />
                <FieldError message={create.error ? errorMessage(create.error) : null} />
                <FormActions>
                    <Button type="submit" disabled={create.isPending || !name.trim()}>
                        {create.isPending ? "Creating…" : "Create token"}
                    </Button>
                </FormActions>
            </form>
        </SettingsSection>
    );
}

export function TokensSettings() {
    const { ws, workspace, can } = useWorkspace();
    const queryClient = useQueryClient();
    const allowed = can("tokens");
    const query = useQuery({ ...tokensQuery(ws), enabled: allowed });
    // The new token lives only here: never in the query cache, so refetches can't redraw or drop it.
    const [created, setCreated] = useState<string | null>(null);
    const dismiss = useCallback(() => setCreated(null), []);

    if (!allowed)
        return (
            <SettingsPage title="API tokens">
                <ReadOnlyNote>Only admins of this workspace can see and create API tokens.</ReadOnlyNote>
            </SettingsPage>
        );

    return (
        <SettingsPage
            title="API tokens"
            description={`Tokens let agents, CI jobs and scripts use ${workspace.name} through the API and MCP. Send one as Authorization: Bearer tri_…`}
        >
            {created && (
                <OneTimeReveal
                    value={created}
                    label="New API token"
                    hint="Paste it into your agent's MCP settings or your CI secrets."
                    onDismiss={dismiss}
                />
            )}
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : query.isPending ? (
                <LoadingRows rows={3} />
            ) : query.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tokens yet.</p>
            ) : (
                <TableFrame>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Token</TableHead>
                                <TableHead>Access</TableHead>
                                <TableHead className="hidden sm:table-cell">Acts for</TableHead>
                                <TableHead className="hidden sm:table-cell">Created</TableHead>
                                <TableHead className="hidden sm:table-cell">Expires</TableHead>
                                <TableHead className="hidden sm:table-cell">Last used</TableHead>
                                <TableHead>
                                    <span className="sr-only">Actions</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {query.data.map((t) => (
                                <TableRow key={t.id}>
                                    <TableCell className="whitespace-normal">
                                        <div className="font-medium break-words">{t.name}</div>
                                        <div className="font-mono text-xs text-muted-foreground">{t.prefix}…</div>
                                    </TableCell>
                                    <TableCell className="text-xs whitespace-normal">
                                        {SCOPE_INFO[t.scope]}
                                        <div className="font-mono text-muted-foreground">{t.scope}</div>
                                    </TableCell>
                                    <TableCell className="hidden text-xs sm:table-cell">
                                        {t.owner?.displayName ?? (
                                            <span className="text-destructive">
                                                Nobody: it no longer works. Revoke it, and make one that acts for a member.
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell className="hidden text-xs sm:table-cell">
                                        {formatDate(t.createdAt)}
                                        <div className="text-muted-foreground">by {t.createdBy}</div>
                                    </TableCell>
                                    <TableCell className="hidden text-xs sm:table-cell">
                                        {t.expiresAt ? formatDate(t.expiresAt) : "Never"}
                                    </TableCell>
                                    <TableCell className="hidden text-xs sm:table-cell">
                                        {t.lastUsedAt ? timeAgo(t.lastUsedAt) : "Never"}
                                    </TableCell>
                                    <TableCell className="text-end">
                                        <ConfirmAction
                                            trigger={
                                                <Button size="sm" variant="danger">
                                                    <Ban /> Revoke<span className="sr-only"> {t.name}</span>
                                                </Button>
                                            }
                                            title={`Revoke ${t.name}?`}
                                            description="Anything using this token stops working at once. This can't be undone."
                                            confirmLabel="Revoke token"
                                            onConfirm={async () => {
                                                await api.delete(`${paths.workspace(ws)}/settings/tokens/${encodeURIComponent(t.id)}`);
                                                await queryClient.invalidateQueries({ queryKey: keys.wsSettings(ws, "tokens") });
                                                toast.success(`${t.name} revoked.`);
                                            }}
                                        />
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableFrame>
            )}
            <CreateToken onCreated={setCreated} />
        </SettingsPage>
    );
}
