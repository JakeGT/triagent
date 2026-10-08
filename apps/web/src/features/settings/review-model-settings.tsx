import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { UsageBar } from "@/components/charts";
import { Field, FieldError, NativeSelect } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { ModelPicker } from "@/components/model-picker";
import { SecretField } from "@/components/secret-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage, paths } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { count, utcDay } from "@/lib/insights-format";
import { allowanceQuery, insightKeys } from "@/lib/insights-queries";
import type { Allowance } from "@/lib/insights-types";
import { keys, reviewModelQuery } from "@/lib/queries";
import { safeHref } from "@/lib/safe-href";
import { useWorkspace } from "@/lib/session";
import type { ReviewModel } from "@/lib/types";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

export function ReviewModelSettings() {
    const { ws, workspace, can } = useWorkspace();
    const editable = can("configure");
    const queryClient = useQueryClient();
    const query = useQuery(reviewModelQuery(ws));
    const data = query.data;
    const form = useDraft(data ? { provider: data.provider, model: data.model ?? "" } : undefined);
    const allowance = useQuery(allowanceQuery(ws));
    const refresh = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: keys.wsSettings(ws, "review-model") }),
            queryClient.invalidateQueries({ queryKey: insightKeys.allowance(ws) }),
        ]);

    const save = useMutation({
        mutationFn: (v: { provider: string; model: string }) =>
            api.patch<ReviewModel>(`${paths.workspace(ws)}/settings/review-model`, { provider: v.provider, model: v.model.trim() }),
        onSuccess: (m) => {
            queryClient.setQueryData(keys.wsSettings(ws, "review-model"), m);
            form.saved({ provider: m.provider, model: m.model ?? "" });
            void queryClient.invalidateQueries({ queryKey: insightKeys.allowance(ws) });
            toast.success("Review model saved.");
        },
    });

    const d = form.draft;
    return (
        <SettingsPage
            title="Review model & keys"
            description={`The model Open Code Review uses for ${workspace.name}'s reviews, and the API keys for its providers.`}
        >
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : !data || !d ? (
                <LoadingRows rows={4} />
            ) : (
                <>
                    <p className="text-sm" data-testid="review-model-status">
                        {data.ready
                            ? `Ready: reviews use ${data.model} through ${data.providers.find((p) => p.id === data.provider)?.name ?? data.provider}.`
                            : allowance.data?.now.ready
                              ? `Ready: reviews use ${allowance.data.now.model} through the instance's key.`
                              : `Not ready: ${allowance.data && !allowance.data.now.ready ? allowance.data.now.reason : "the chosen provider has no API key yet."}`}
                    </p>
                    <SettingsSection title="Model">
                        {!editable && <ReadOnlyNote />}
                        <ChangedElsewhere show={form.changedElsewhere} onReload={form.reload} what="The review model" />
                        <form
                            className="grid gap-4"
                            onSubmit={(e) => {
                                e.preventDefault();
                                save.mutate(d);
                            }}
                        >
                            <Field label="Provider">
                                {(p) => (
                                    <NativeSelect
                                        {...p}
                                        value={d.provider}
                                        disabled={!editable}
                                        className="w-64"
                                        onChange={(e) =>
                                            form.setDraft({
                                                provider: e.target.value,
                                                model: data.providers.find((x) => x.id === e.target.value)?.model ?? "",
                                            })
                                        }
                                    >
                                        {data.providers.map((p) => (
                                            <option key={p.id} value={p.id}>
                                                {p.name}
                                            </option>
                                        ))}
                                    </NativeSelect>
                                )}
                            </Field>
                            <Field label="Model" hint="The provider's name for the model, e.g. anthropic/claude-sonnet-4.5.">
                                {(p) => (
                                    <Input
                                        {...p}
                                        value={d.model}
                                        onChange={(e) => form.setDraft({ ...d, model: e.target.value })}
                                        disabled={!editable}
                                        maxLength={150}
                                        spellCheck={false}
                                        className="font-mono"
                                    />
                                )}
                            </Field>
                            {editable && d.provider === "openrouter" && (
                                <div>
                                    <ModelPicker ws={ws} current={d.model} onChoose={(m) => form.setDraft({ ...d, model: m.id })} />
                                </div>
                            )}
                            <FieldError message={save.error ? errorMessage(save.error) : null} />
                            {editable && (
                                <div>
                                    <Button type="submit" disabled={save.isPending || !form.dirty}>
                                        {save.isPending ? "Saving…" : "Save model"}
                                    </Button>
                                </div>
                            )}
                        </form>
                    </SettingsSection>
                    {allowance.data && <InstanceKeyStatus a={allowance.data} />}
                    <SettingsSection
                        title="API keys"
                        description="Stored encrypted for this workspace and never shown again. API tokens and agents can't set or read them."
                    >
                        {!can("secrets") && <ReadOnlyNote>Only admins can set or clear keys.</ReadOnlyNote>}
                        {data.providers.map((p) => {
                            const keysUrl = safeHref(p.keysUrl);
                            return (
                                <div key={p.id} className="grid gap-1">
                                    <SecretField
                                        label={`${p.name} API key`}
                                        secret={p.key}
                                        canEdit={can("secrets")}
                                        hint={`Sent to ${p.url}.`}
                                        onSave={async (key) => {
                                            await api.put(`${paths.workspace(ws)}/settings/review-model/keys/${encodeURIComponent(p.id)}`, {
                                                key,
                                            });
                                            await refresh();
                                            toast.success(`${p.name} key saved.`);
                                        }}
                                        onClear={async () => {
                                            await api.delete(
                                                `${paths.workspace(ws)}/settings/review-model/keys/${encodeURIComponent(p.id)}`,
                                            );
                                            await refresh();
                                            toast.success(`${p.name} key cleared.`);
                                        }}
                                    />
                                    {keysUrl && (
                                        <a href={keysUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline">
                                            Get a {p.name} key<span className="sr-only"> (opens in a new tab)</span>
                                        </a>
                                    )}
                                </div>
                            );
                        })}
                    </SettingsSection>
                </>
            )}
        </SettingsPage>
    );
}

/** Whether this workspace may use the instance's key, and how much of this month's allowance is left. */
function InstanceKeyStatus({ a }: { a: Allowance }) {
    const usingIt = a.now.ready && a.now.keySource === "instance";
    return (
        <SettingsSection
            title="Use the instance key"
            description="The instance administrator can let a workspace use the instance's own model key, up to a number of tokens each month."
        >
            <div className="grid gap-2 text-sm" data-testid="instance-key-status">
                {!a.granted || a.monthlyTokens === null ? (
                    <p>This workspace can't use the instance's key. Reviews need one of the API keys below.</p>
                ) : (
                    <>
                        <p>
                            This workspace may use the instance's key ({a.instance.providerName},{" "}
                            <span className="font-mono">{a.instance.model}</span>) for up to {count(a.monthlyTokens)} tokens a month.{" "}
                            {!a.instance.keySet
                                ? "The instance administrator hasn't set the key up yet."
                                : usingIt
                                  ? "Reviews use it now, because this workspace has no key of its own for its provider."
                                  : a.now.ready
                                    ? "Reviews use this workspace's own key, so the allowance isn't used."
                                    : ""}
                        </p>
                        <UsageBar used={a.used} total={a.monthlyTokens} label="Instance key allowance used this month" />
                        <p className="text-muted-foreground">
                            {count(a.used)} of {count(a.monthlyTokens)} tokens used this month ({count(a.remaining ?? 0)} left). It resets
                            on {utcDay(a.resetsAt)}.
                        </p>
                    </>
                )}
            </div>
        </SettingsSection>
    );
}
