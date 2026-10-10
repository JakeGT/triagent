// Settings → Instance → Reviews: how many reviews run at once on the instance and in one workspace, beside
// the connected runners and what each is doing. Instance admins only. A workspace's own limit is set on
// the Workspaces page.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { Field, FieldError, FieldRow } from "@/components/field";
import { FormActions, FormSection } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { formatDateTime, timeAgo } from "@/lib/format";
import { insightKeys, instancePaths, instanceReviewsQuery } from "@/lib/insights-queries";
import type { InstanceReviews, InstanceRunner } from "@/lib/insights-types";
import { useMe, useWorkspace } from "@/lib/session";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

export const MIN_LIMIT = 1;
export const MAX_LIMIT = 100;

/** A limit as typed: a whole number from 1 to 100, or null if it isn't one. */
export function parseLimit(text: string): number | null {
    if (!/^\s*\d{1,3}\s*$/.test(text)) return null;
    const n = Number(text);
    return n >= MIN_LIMIT && n <= MAX_LIMIT ? n : null;
}

const reviews = (n: number) => `${n} review${n === 1 ? "" : "s"}`;

/**
 * What the limits and the runners add up to: how many reviews can really run at once, and what holds
 * that down. The limits can be set above what the runners can do; then reviews wait for a runner slot.
 */
export function capacityNote(instanceLimit: number, runners: Pick<InstanceRunner, "slots">[]): string {
    if (!runners.length) return "No runner is connected, so no review can start. Start a runner (see the README).";
    const slots = runners.reduce((n, r) => n + r.slots, 0);
    const these = `The connected runner${runners.length === 1 ? "" : "s"} can work on ${reviews(slots)} at once`;
    if (instanceLimit > slots)
        return `${these}, fewer than this instance's limit of ${instanceLimit}: reviews past ${slots} wait for a free runner slot.`;
    if (instanceLimit < slots) return `${these}; this instance's limit keeps it to ${instanceLimit}.`;
    return `${these}, the same as this instance's limit.`;
}

interface LimitsForm {
    instance: string;
    perWorkspace: string;
}

const toForm = (d: InstanceReviews): LimitsForm => ({ instance: String(d.limits.instance), perWorkspace: String(d.limits.perWorkspace) });

const NOT_A_LIMIT = `Give a whole number from ${MIN_LIMIT} to ${MAX_LIMIT}.`;

function LimitsSection({ data }: { data: InstanceReviews }) {
    const queryClient = useQueryClient();
    const { ws } = useWorkspace();
    const form = useDraft(toForm(data));
    const [checked, setChecked] = useState(false);
    const d = form.draft as LimitsForm;
    const instance = parseLimit(d.instance);
    const perWorkspace = parseLimit(d.perWorkspace);

    const save = useMutation({
        mutationFn: (v: { instance: number; perWorkspace: number }) => api.put<InstanceReviews>(instancePaths.reviews, v),
        onSuccess: (saved) => {
            form.saved(toForm(saved));
            setChecked(false);
            queryClient.setQueryData(insightKeys.instanceReviews, saved);
            // The Workspaces page and every Runs page say what the limits are.
            void queryClient.invalidateQueries({ queryKey: insightKeys.instanceWorkspaces });
            void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "ws" && q.queryKey[2] === "runs" });
            toast.success("Limits saved.");
        },
    });

    return (
        <SettingsSection
            title="Limits"
            description="A change applies to the next review to start. A running review is never stopped: after lowering a limit, no more start until enough have finished."
        >
            <ChangedElsewhere show={form.changedElsewhere} onReload={form.reload} what="These limits" />
            <form
                className="grid gap-form"
                noValidate
                onSubmit={(e) => {
                    e.preventDefault();
                    setChecked(true);
                    if (instance === null || perWorkspace === null) return;
                    save.mutate({ instance, perWorkspace });
                }}
            >
                <FieldRow>
                    <Field
                        label="At once on this instance"
                        hint="Reviews running at the same time, in every workspace together."
                        error={checked && instance === null ? NOT_A_LIMIT : null}
                        width="xs"
                    >
                        {(p) => (
                            <Input
                                {...p}
                                type="number"
                                inputMode="numeric"
                                min={MIN_LIMIT}
                                max={MAX_LIMIT}
                                step={1}
                                value={d.instance}
                                onChange={(e) => form.setDraft({ ...d, instance: e.target.value })}
                                className="tabular-nums"
                            />
                        )}
                    </Field>
                    <Field
                        label="At once in one workspace"
                        hint={
                            <>
                                For a workspace without a limit of its own. Give one its own under{" "}
                                <Link to="/w/$ws/settings/instance-workspaces" params={{ ws }} className="link">
                                    Workspaces
                                </Link>
                                .
                            </>
                        }
                        error={checked && perWorkspace === null ? NOT_A_LIMIT : null}
                        width="xs"
                    >
                        {(p) => (
                            <Input
                                {...p}
                                type="number"
                                inputMode="numeric"
                                min={MIN_LIMIT}
                                max={MAX_LIMIT}
                                step={1}
                                value={d.perWorkspace}
                                onChange={(e) => form.setDraft({ ...d, perWorkspace: e.target.value })}
                                className="tabular-nums"
                            />
                        )}
                    </Field>
                </FieldRow>
                <p className="text-xs text-muted-foreground" data-testid="limits-source">
                    {data.saved ? (
                        <>
                            Saved by {data.saved.by} on <time dateTime={data.saved.at}>{formatDateTime(data.saved.at)}</time>. Until then
                            the server's settings applied: {data.defaults.instance} on the instance, {data.defaults.perWorkspace} in one
                            workspace.
                        </>
                    ) : (
                        <>
                            These come from the server's settings (<code className="font-mono">REVIEW_CONCURRENCY</code> and{" "}
                            <code className="font-mono">REVIEW_CONCURRENCY_PER_WORKSPACE</code>). Saving here takes over from them.
                        </>
                    )}
                </p>
                <FieldError message={save.error ? errorMessage(save.error) : null} />
                <FormActions>
                    <Button type="submit" disabled={save.isPending || !form.dirty}>
                        {save.isPending ? "Saving…" : "Save limits"}
                    </Button>
                </FormActions>
            </form>
        </SettingsSection>
    );
}

function RunnersSection({ data }: { data: InstanceReviews }) {
    return (
        <FormSection
            plain
            title="Runners"
            description={
                <span data-testid="capacity-note">
                    {capacityNote(data.limits.instance, data.runners)} Now: {data.running} running, {data.queued} queued.
                </span>
            }
        >
            {data.runners.length > 0 && (
                <TableFrame>
                    <Table>
                        <caption className="sr-only">Connected runners</caption>
                        <TableHeader>
                            <TableRow>
                                <TableHead scope="col">Runner</TableHead>
                                <TableHead scope="col" className="hidden sm:table-cell">
                                    Version
                                </TableHead>
                                <TableHead scope="col" className="text-end">
                                    Slots in use
                                </TableHead>
                                <TableHead scope="col">Last seen</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {data.runners.map((r, i) => (
                                // Two runners can share a name (a host name, by default).
                                // biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole, and names needn't be unique
                                <TableRow key={`${r.name}:${i}`} data-testid={`runner-${r.name}`}>
                                    <TableCell className="font-medium break-all whitespace-normal">{r.name}</TableCell>
                                    <TableCell className="hidden sm:table-cell">{r.version ?? "Not reported"}</TableCell>
                                    <TableCell className="text-end tabular-nums">
                                        {r.busy} of {r.slots}
                                    </TableCell>
                                    <TableCell className="text-xs whitespace-normal text-muted-foreground">
                                        <time dateTime={r.lastSeenAt} title={formatDateTime(r.lastSeenAt)}>
                                            {timeAgo(r.lastSeenAt)}
                                        </time>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableFrame>
            )}
        </FormSection>
    );
}

export function InstanceReviewsSettings() {
    const me = useMe();
    const allowed = me.user.isInstanceAdmin;
    const query = useQuery({ ...instanceReviewsQuery, enabled: allowed });

    if (!allowed)
        return (
            <SettingsPage title="Reviews">
                <ReadOnlyNote>Only instance administrators can change how many reviews run at once.</ReadOnlyNote>
            </SettingsPage>
        );

    return (
        <SettingsPage
            title="Reviews"
            description="How many reviews run at once, and the runners that do them. A slot is one review a runner can work on at a time."
        >
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : !query.data ? (
                <LoadingRows rows={4} />
            ) : (
                <>
                    <LimitsSection data={query.data} />
                    <RunnersSection data={query.data} />
                </>
            )}
        </SettingsPage>
    );
}
