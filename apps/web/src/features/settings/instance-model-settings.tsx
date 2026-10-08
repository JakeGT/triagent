// Settings → Instance → Instance model key: the key, provider and model that workspaces with an allowance
// use when they have no key of their own, and model prices for the whole instance. Instance admins only.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field, FieldError, NativeSelect } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { ModelPicker } from "@/components/model-picker";
import { PriceEditor } from "@/components/price-editor";
import { SecretField } from "@/components/secret-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { catalogueQuery, insightKeys, instanceModelQuery, instancePaths, instancePricesQuery } from "@/lib/insights-queries";
import type { InstanceModel } from "@/lib/insights-types";
import { safeHref } from "@/lib/safe-href";
import { useMe, useWorkspace } from "@/lib/session";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

export function InstanceModelSettings() {
    const me = useMe();
    const { ws } = useWorkspace();
    const allowed = me.user.isInstanceAdmin;
    const queryClient = useQueryClient();
    const query = useQuery({ ...instanceModelQuery, enabled: allowed });
    const prices = useQuery({ ...instancePricesQuery, enabled: allowed });
    const catalogue = useQuery({ ...catalogueQuery(ws), enabled: allowed });
    const data = query.data;
    const form = useDraft(data ? { provider: data.provider, model: data.model } : undefined);
    const refresh = () => queryClient.invalidateQueries({ queryKey: insightKeys.instanceModel });

    const save = useMutation({
        mutationFn: (v: { provider: string; model: string }) =>
            api.patch<InstanceModel>(instancePaths.model, { provider: v.provider, model: v.model.trim() }),
        onSuccess: (m) => {
            queryClient.setQueryData(insightKeys.instanceModel, m);
            form.saved({ provider: m.provider, model: m.model });
            toast.success("Instance model saved.");
        },
    });

    if (!allowed)
        return (
            <SettingsPage title="Instance model key">
                <ReadOnlyNote>Only instance administrators can manage the instance model key.</ReadOnlyNote>
            </SettingsPage>
        );

    const d = form.draft;
    return (
        <SettingsPage
            title="Instance model key"
            description="A model key for the whole instance. Workspaces you give an allowance (under Workspaces) use it when they have no key of their own, up to their monthly tokens."
        >
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : !data || !d ? (
                <LoadingRows rows={4} />
            ) : (
                <>
                    <p className="text-sm" data-testid="instance-model-status">
                        {data.ready
                            ? `Ready: workspaces with an allowance review with ${data.model} through ${data.providers.find((p) => p.id === data.provider)?.name ?? data.provider}.`
                            : "Not ready: the chosen provider has no instance key yet."}
                    </p>
                    <SettingsSection title="Provider and model">
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
                                        maxLength={150}
                                        spellCheck={false}
                                        className="font-mono"
                                    />
                                )}
                            </Field>
                            {d.provider === "openrouter" && (
                                <div>
                                    <ModelPicker ws={ws} current={d.model} onChoose={(m) => form.setDraft({ ...d, model: m.id })} />
                                </div>
                            )}
                            <FieldError message={save.error ? errorMessage(save.error) : null} />
                            <div>
                                <Button type="submit" disabled={save.isPending || !form.dirty}>
                                    {save.isPending ? "Saving…" : "Save model"}
                                </Button>
                            </div>
                        </form>
                    </SettingsSection>
                    <SettingsSection
                        title="Instance keys"
                        description="Stored encrypted, belonging to no workspace, and never shown again. Only instance administrators, in the browser, can set them."
                    >
                        {data.providers.map((p) => {
                            const keysUrl = safeHref(p.keysUrl);
                            return (
                                <div key={p.id} className="grid gap-1">
                                    <SecretField
                                        label={`${p.name} instance key`}
                                        secret={p.key}
                                        canEdit
                                        hint={`Sent to ${p.url}.`}
                                        onSave={async (key) => {
                                            await api.put(`${instancePaths.model}/keys/${encodeURIComponent(p.id)}`, { key });
                                            await refresh();
                                            toast.success(`${p.name} instance key saved.`);
                                        }}
                                        onClear={async () => {
                                            await api.delete(`${instancePaths.model}/keys/${encodeURIComponent(p.id)}`);
                                            await refresh();
                                            toast.success(`${p.name} instance key cleared.`);
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
                    <SettingsSection
                        title="Model prices for the whole instance"
                        description="US dollars per million tokens. Workspaces can set their own, which win over these; models priced nowhere use OpenRouter's listed price."
                    >
                        {prices.data ? (
                            <PriceEditor
                                title="instance prices"
                                prices={prices.data.prices}
                                canEdit
                                catalogue={catalogue.data?.models ?? []}
                                onSave={async (p) => {
                                    await api.put(instancePaths.prices, p);
                                    await queryClient.invalidateQueries({ queryKey: insightKeys.instancePrices });
                                    toast.success(`Instance price for ${p.model} saved.`);
                                }}
                                onRemove={async (model) => {
                                    await api.delete(instancePaths.prices, { model });
                                    await queryClient.invalidateQueries({ queryKey: insightKeys.instancePrices });
                                    toast.success(`Instance price for ${model} removed.`);
                                }}
                            />
                        ) : prices.isError ? (
                            <LoadError error={prices.error} onRetry={() => prices.refetch()} />
                        ) : (
                            <LoadingRows rows={2} />
                        )}
                    </SettingsSection>
                </>
            )}
        </SettingsPage>
    );
}
