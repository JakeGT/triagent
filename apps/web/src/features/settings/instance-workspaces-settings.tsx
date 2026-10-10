// Settings → Instance → Workspaces: every workspace, with its allowance of the instance model key (tokens
// a month) and this month's use of it, and its own limit on reviews running at once. Instance admins give,
// change or remove allowances and limits here.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleMinus } from "lucide-react";
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
import type { InstanceWorkspace, ReviewLimits } from "@/lib/insights-types";
import { keys } from "@/lib/queries";
import { useMe, useWorkspace } from "@/lib/session";
import { MAX_LIMIT, MIN_LIMIT, parseLimit } from "./instance-reviews-settings";
import { ReadOnlyNote, SettingsPage } from "./settings-page";

const SHOWN = 100;

/** "2,000,000", "2m" or "500k" as a number of tokens; null if it isn't one. */
export function parseTokens(text: string): number | null {
    const m = /^\s*([\d,]+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(text);
    if (!m) return null;
    const n = Number((m[1] as string).replace(/,/g, "")) * ({ k: 1e3, m: 1e6 }[(m[2] as string).toLowerCase()] ?? 1);
    return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * A workspace's own limit on reviews at once: a number, or left empty to go by the one for every
 * workspace. Saved with its own button, like the allowance beside it.
 */
export function ReviewLimitForm({ w, limits }: { w: InstanceWorkspace; limits: ReviewLimits }) {
    const queryClient = useQueryClient();
    const id = useId();
    const [value, setValue] = useState(w.reviewLimit === null ? "" : String(w.reviewLimit));
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const url = `${instancePaths.workspaces}/${encodeURIComponent(w.id)}/review-limit`;

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const n = value.trim() ? parseLimit(value) : null;
        if (value.trim() && n === null) {
            setError(`Give a whole number from ${MIN_LIMIT} to ${MAX_LIMIT}, or leave it empty for the default.`);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            if (n === null) await api.delete(url);
            else await api.put(url, { limit: n });
            setValue(n === null ? "" : String(n));
            await queryClient.invalidateQueries({ queryKey: insightKeys.instanceWorkspaces });
            // The workspace's Runs page says what its limit is.
            void queryClient.invalidateQueries({ queryKey: keys.runs(w.slug) });
            toast.success(
                n === null
                    ? `${w.name} goes by the default again: ${limits.perWorkspace} at once.`
                    : `${w.name} runs up to ${n} review${n === 1 ? "" : "s"} at once.`,
            );
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form className="flex items-start gap-2" onSubmit={submit} noValidate>
            <div className="grid gap-1">
                <Label htmlFor={id} className="sr-only">
                    Reviews at once in {w.name}
                </Label>
                <Input
                    id={id}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={`Default (${limits.perWorkspace})`}
                    inputMode="numeric"
                    className="h-8 w-28 tabular-nums"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id}-error` : undefined}
                />
                <FieldError id={`${id}-error`} message={error} className="max-w-56 text-xs" />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
                {w.reviewLimit === null ? "Set" : "Change"} <span className="sr-only">{w.name}'s reviews at once</span>
            </Button>
        </form>
    );
}

function GrantRow({ w, limits }: { w: InstanceWorkspace; limits: ReviewLimits }) {
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
            <TableCell className="whitespace-normal">
                <ReviewLimitForm w={w} limits={limits} />
            </TableCell>
            <TableCell className="text-end">
                {w.grant && (
                    <ConfirmAction
                        trigger={
                            <Button type="button" size="sm" variant="danger">
                                <CircleMinus /> Remove <span className="sr-only">{w.name}'s allowance</span>
                            </Button>
                        }
                        title={`Stop ${w.name} using the instance key?`}
                        description="Its reviews will need a key of its own. Reviews already running finish. You can give it an allowance again later."
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
    const { ws } = useWorkspace();
    const allowed = me.user.isInstanceAdmin;
    const query = useQuery({ ...instanceWorkspacesQuery, enabled: allowed });
    const [q, setQ] = useState("");

    if (!allowed)
        return (
            <SettingsPage title="Workspaces">
                <ReadOnlyNote>Only instance administrators can manage allowances and limits.</ReadOnlyNote>
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
                query.data ? (
                    <div className="grid gap-2">
                        <p>
                            Every workspace on this instance. Those with an allowance can use the instance model key when they have no key
                            of their own, up to their tokens each month; allowances reset on {utcDay(query.data.resetsAt)} (UTC).
                        </p>
                        <p data-testid="review-limits-note">
                            Reviews at once is how many of a workspace's reviews may run together. Leave it empty for the default (
                            {query.data.reviewLimits.perWorkspace}). A workspace's own limit can be lower or higher, but the instance never
                            runs more than {query.data.reviewLimits.instance} at once. Both numbers are set under{" "}
                            <Link to="/w/$ws/settings/instance-reviews" params={{ ws }} className="link">
                                Reviews
                            </Link>
                            .
                        </p>
                    </div>
                ) : (
                    "Every workspace on this instance, its allowance of the instance model key, and how many reviews it runs at once."
                )
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
                            <caption className="sr-only">Workspaces, their instance key allowances and their reviews at once</caption>
                            <TableHeader>
                                <TableRow>
                                    <TableHead scope="col">Workspace</TableHead>
                                    <TableHead scope="col">Tokens a month</TableHead>
                                    <TableHead scope="col">Used this month</TableHead>
                                    <TableHead scope="col">Reviews at once</TableHead>
                                    <TableHead scope="col">
                                        <span className="sr-only">Actions</span>
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {items.slice(0, SHOWN).map((w) => (
                                    <GrantRow
                                        key={`${w.id}:${w.grant?.monthlyTokens ?? ""}:${w.reviewLimit ?? ""}`}
                                        w={w}
                                        limits={query.data.reviewLimits}
                                    />
                                ))}
                            </TableBody>
                        </Table>
                    </TableFrame>
                    {items.length === 0 && q.trim() && <p className="text-sm text-muted-foreground">No workspace matches “{q.trim()}”.</p>}
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
