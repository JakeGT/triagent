// Settings → Instance → Workspaces: every workspace, with its allowance of the instance model key (tokens
// a month) and this month's use of it. Instance admins give, change or remove allowances here.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { UsageBar } from "@/components/charts";
import { ConfirmAction } from "@/components/confirm-action";
import { Field, FieldError } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { compactCount, count, utcDay } from "@/lib/insights-format";
import { insightKeys, instancePaths, instanceWorkspacesQuery } from "@/lib/insights-queries";
import type { InstanceWorkspace } from "@/lib/insights-types";
import { useMe } from "@/lib/session";
import { ReadOnlyNote, SettingsPage } from "./settings-page";

const SHOWN = 100;

/** "2,000,000", "2m" or "500k" as a number of tokens; null if it isn't one. */
export function parseTokens(text: string): number | null {
    const m = /^\s*([\d,]+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(text);
    if (!m) return null;
    const n = Number((m[1] as string).replace(/,/g, "")) * ({ k: 1e3, m: 1e6 }[(m[2] as string).toLowerCase()] ?? 1);
    return Number.isFinite(n) ? Math.round(n) : null;
}

function GrantRow({ w }: { w: InstanceWorkspace }) {
    const queryClient = useQueryClient();
    const id = useId();
    const [value, setValue] = useState(w.grant ? count(w.grant.monthlyTokens) : "");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const url = `${instancePaths.workspaces}/${encodeURIComponent(w.id)}/grant`;
    const refresh = () => queryClient.invalidateQueries({ queryKey: insightKeys.instanceWorkspaces });

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const n = parseTokens(value);
        if (n === null || n < 1000) {
            setError("Give a whole number of tokens, at least 1,000 (e.g. 2,000,000 or 2m).");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await api.put(url, { monthlyTokens: n });
            setValue(count(n));
            await refresh();
            toast.success(`${w.name} may use ${count(n)} tokens a month.`);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <TableRow data-testid={`grant-${w.slug}`}>
            <TableCell className="whitespace-normal">
                <span className="block font-medium">{w.name}</span>
                <span className="block text-xs text-muted-foreground">
                    {w.slug} · {w.kind === "personal" ? "Personal" : "Organisation"}
                </span>
            </TableCell>
            <TableCell className="min-w-56 whitespace-normal">
                <form className="flex items-start gap-2" onSubmit={submit}>
                    <div className="grid gap-1">
                        <Label htmlFor={id} className="sr-only">
                            Monthly tokens for {w.name}
                        </Label>
                        <Input
                            id={id}
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            placeholder="No allowance"
                            inputMode="numeric"
                            className="h-8 w-36 tabular-nums"
                            aria-invalid={error ? true : undefined}
                            aria-describedby={error ? `${id}-error` : undefined}
                        />
                        <FieldError id={`${id}-error`} message={error} className="max-w-56 text-xs" />
                    </div>
                    <Button type="submit" size="sm" variant="outline" disabled={busy}>
                        {w.grant ? "Change" : "Allow"} <span className="sr-only">{w.name}'s allowance</span>
                    </Button>
                </form>
            </TableCell>
            <TableCell className="min-w-48 whitespace-normal">
                {w.grant ? (
                    <div className="grid gap-1">
                        <UsageBar used={w.used} total={w.grant.monthlyTokens} label={`${w.name}'s allowance used this month`} />
                        <span className="text-xs text-muted-foreground tabular-nums">
                            {compactCount(w.used)} of {compactCount(w.grant.monthlyTokens)} used
                        </span>
                    </div>
                ) : w.used ? (
                    <span className="text-xs text-muted-foreground">{compactCount(w.used)} used before its allowance was removed</span>
                ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                )}
            </TableCell>
            <TableCell className="text-end">
                {w.grant && (
                    <ConfirmAction
                        trigger={
                            <Button type="button" size="sm" variant="ghost">
                                Remove <span className="sr-only">{w.name}'s allowance</span>
                            </Button>
                        }
                        title={`Stop ${w.name} using the instance key?`}
                        description="Its reviews will need a key of its own. Reviews already running finish."
                        confirmLabel="Remove allowance"
                        onConfirm={async () => {
                            await api.delete(url);
                            setValue("");
                            await refresh();
                            toast.success(`${w.name} can no longer use the instance key.`);
                        }}
                    />
                )}
            </TableCell>
        </TableRow>
    );
}

export function InstanceWorkspacesSettings() {
    const me = useMe();
    const allowed = me.user.isInstanceAdmin;
    const query = useQuery({ ...instanceWorkspacesQuery, enabled: allowed });
    const [q, setQ] = useState("");

    if (!allowed)
        return (
            <SettingsPage title="Workspaces">
                <ReadOnlyNote>Only instance administrators can manage allowances.</ReadOnlyNote>
            </SettingsPage>
        );

    const items = (query.data?.items ?? []).filter(
        (w) => !q.trim() || `${w.name} ${w.slug}`.toLowerCase().includes(q.trim().toLowerCase()),
    );
    const granted = (query.data?.items ?? []).filter((w) => w.grant).length;
    return (
        <SettingsPage
            title="Workspaces"
            description={
                query.data
                    ? `Every workspace on this instance. Those with an allowance can use the instance model key when they have no key of their own, up to their tokens each month; allowances reset on ${utcDay(query.data.resetsAt)} (UTC).`
                    : "Every workspace on this instance, and its allowance of the instance model key."
            }
            wide
        >
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : !query.data ? (
                <LoadingRows rows={5} />
            ) : (
                <>
                    <Field
                        label="Find a workspace"
                        width="md"
                        hint={
                            <span role="status">
                                {count(query.data.items.length)} workspaces, {count(granted)} with an allowance.
                            </span>
                        }
                    >
                        {(p) => <Input {...p} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}
                    </Field>
                    <TableFrame>
                        <Table>
                            <caption className="sr-only">Workspaces and their instance key allowances</caption>
                            <TableHeader>
                                <TableRow>
                                    <TableHead scope="col">Workspace</TableHead>
                                    <TableHead scope="col">Tokens a month</TableHead>
                                    <TableHead scope="col">Used this month</TableHead>
                                    <TableHead scope="col">
                                        <span className="sr-only">Actions</span>
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {items.slice(0, SHOWN).map((w) => (
                                    <GrantRow key={`${w.id}:${w.grant?.monthlyTokens ?? ""}`} w={w} />
                                ))}
                            </TableBody>
                        </Table>
                    </TableFrame>
                    {items.length > SHOWN && (
                        <p className="text-sm text-muted-foreground">
                            Showing {SHOWN} of {count(items.length)}. Search to find the others.
                        </p>
                    )}
                </>
            )}
        </SettingsPage>
    );
}
