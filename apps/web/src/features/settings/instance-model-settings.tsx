// Settings → Instance → Instance model key: the key, provider and model that workspaces with an allowance
// use when they have no key of their own, and model prices for the whole instance. Instance admins only.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { LoadError, LoadingRows } from "@/components/load-state";
import { PriceEditor } from "@/components/price-editor";
import { api } from "@/lib/api";
import { catalogueQuery, insightKeys, instanceModelQuery, instancePaths, instancePricesQuery } from "@/lib/insights-queries";
import { useMe, useWorkspace } from "@/lib/session";
import { ModelProviderForm } from "./model-provider-form";
import { ReadOnlyNote, SettingsPage, SettingsSection, StatusNote } from "./settings-page";

export function InstanceModelSettings() {
    const me = useMe();
    const { ws } = useWorkspace();
    const allowed = me.user.isInstanceAdmin;
    const queryClient = useQueryClient();
    const query = useQuery({ ...instanceModelQuery, enabled: allowed });
    const prices = useQuery({ ...instancePricesQuery, enabled: allowed });
    const catalogue = useQuery({ ...catalogueQuery(ws), enabled: allowed });
    const data = query.data;
    const refresh = () => queryClient.invalidateQueries({ queryKey: insightKeys.instanceModel });
    // Instance prices change this workspace's costs too.
    const refreshPrices = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: insightKeys.instancePrices }),
            queryClient.invalidateQueries({ queryKey: insightKeys.prices(ws) }),
            queryClient.invalidateQueries({ queryKey: ["ws", ws, "analytics"] }),
        ]);

    if (!allowed)
        return (
            <SettingsPage title="Instance model key">
                <ReadOnlyNote>Only instance administrators can manage the instance model key.</ReadOnlyNote>
            </SettingsPage>
        );

    return (
        <SettingsPage
            title="Instance model key"
            description="A model key for the whole instance. Workspaces you give an allowance (under Workspaces) use it when they have no key of their own, up to their monthly tokens."
        >
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : !data ? (
                <LoadingRows rows={4} />
            ) : (
                <>
                    <StatusNote data-testid="instance-model-status">
                        {data.ready
                            ? `Ready: workspaces with an allowance review with ${data.model} through ${data.providers.find((p) => p.id === data.provider)?.name ?? data.provider}.`
                            : `Not ready: add ${data.missing ?? "an instance key"}.`}
                    </StatusNote>
                    <ModelProviderForm
                        data={data}
                        base={instancePaths.model}
                        ws={ws}
                        queryKey={insightKeys.instanceModel}
                        scope="instance"
                        canConfigure
                        canSetSecrets
                        onSaved={(m) => queryClient.setQueryData(insightKeys.instanceModel, m)}
                        refresh={refresh}
                    />
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
                                suggest={data.favourites.map((f) => ({
                                    model: f.model,
                                    provider: f.provider,
                                    label: f.name ?? f.providerName,
                                }))}
                                onSave={async (p) => {
                                    await api.put(instancePaths.prices, p);
                                    await refreshPrices();
                                    toast.success(`Instance price for ${p.model} saved.`);
                                }}
                                onRemove={async (model) => {
                                    await api.delete(instancePaths.prices, { model });
                                    await refreshPrices();
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
