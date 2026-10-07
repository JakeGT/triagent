import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { Field, FieldError, NativeSelect } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { SecretField } from "@/components/secret-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage, paths } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
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
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.wsSettings(ws, "review-model") });

    const save = useMutation({
        mutationFn: (v: { provider: string; model: string }) =>
            api.patch<ReviewModel>(`${paths.workspace(ws)}/settings/review-model`, { provider: v.provider, model: v.model.trim() }),
        onSuccess: (m) => {
            queryClient.setQueryData(keys.wsSettings(ws, "review-model"), m);
            form.saved({ provider: m.provider, model: m.model ?? "" });
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
                    <p className="text-sm">
                        {data.ready
                            ? `Ready: reviews use ${data.model} through ${data.providers.find((p) => p.id === data.provider)?.name ?? data.provider}.`
                            : "Not ready: the chosen provider has no API key yet."}
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
