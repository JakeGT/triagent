import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SCOPE_INFO, TOKEN_SCOPES, type TokenScope } from "@triagent/shared";
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
    const { ws } = useWorkspace();
    const queryClient = useQueryClient();
    const members = useQuery(membersQuery(ws));
    const [name, setName] = useState("");
    const [scope, setScope] = useState<TokenScope>("full");
    const [days, setDays] = useState("90");
    const [owner, setOwner] = useState(me.user.id);
    const create = useMutation({
        mutationFn: () =>
            api.post<{ token: string; record: ApiToken }>(`${paths.workspace(ws)}/settings/tokens`, {
                name: name.trim(),
                scope,
                expiresInDays: days.trim() ? Number(days) : null,
                ownerUserId: owner || null,
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
                <ChoiceField
                    legend="Access"
                    name="scope"
                    value={scope}
                    onChange={setScope}
                    choices={TOKEN_SCOPES.map((s) => ({
                        value: s,
                        label: (
                            <>
                                <span className="font-mono">{s}</span>: {SCOPE_INFO[s]}
                            </>
                        ),
                    }))}
                    hint="No token can manage members or tokens, or set secrets: those stay with people signed in here."
                />
                <FieldRow>
                    <Field label="Expires after (days)" hint="Empty for a token that never expires." width="xs">
                        {(p) => <Input {...p} type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />}
                    </Field>
                    <Field label="Acts for" hint="Who hears about the reviews it starts. Revoked if they leave the workspace.">
                        {(p) => (
                            <NativeSelect {...p} value={owner} onChange={(e) => setOwner(e.target.value)}>
                                <option value="">Nobody</option>
                                {(members.data ?? [{ user: me.user, role: "owner", since: "" }]).map((m) => (
                                    <option key={m.user.id} value={m.user.id}>
                                        {m.user.displayName}
                                        {m.user.id === me.user.id ? " (you)" : ""}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                </FieldRow>
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
                                <TableHead>Acts for</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead>Expires</TableHead>
                                <TableHead>Last used</TableHead>
                                <TableHead>
                                    <span className="sr-only">Actions</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {query.data.map((t) => (
                                <TableRow key={t.id}>
                                    <TableCell>
                                        <div className="font-medium">{t.name}</div>
                                        <div className="font-mono text-xs text-muted-foreground">{t.prefix}…</div>
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        <span className="font-mono">{t.scope}</span>
                                        <div className="text-muted-foreground">{SCOPE_INFO[t.scope]}</div>
                                    </TableCell>
                                    <TableCell className="text-xs">{t.owner?.displayName ?? "Nobody"}</TableCell>
                                    <TableCell className="text-xs">
                                        {formatDate(t.createdAt)}
                                        <div className="text-muted-foreground">by {t.createdBy}</div>
                                    </TableCell>
                                    <TableCell className="text-xs">{t.expiresAt ? formatDate(t.expiresAt) : "Never"}</TableCell>
                                    <TableCell className="text-xs">{t.lastUsedAt ? timeAgo(t.lastUsedAt) : "Never"}</TableCell>
                                    <TableCell className="text-end">
                                        <ConfirmAction
                                            trigger={
                                                <Button size="sm" variant="ghost">
                                                    Revoke<span className="sr-only"> {t.name}</span>
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
