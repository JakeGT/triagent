// Settings → Models: the providers this workspace has connected, each with its own key and settings, and
// its favourite models, one of them the default that reviews use.

import { useQuery } from "@tanstack/react-query";
import { UsageBar } from "@/components/charts";
import { LoadError, LoadingRows } from "@/components/load-state";
import { count, utcDay } from "@/lib/insights-format";
import { allowanceQuery } from "@/lib/insights-queries";
import type { Allowance } from "@/lib/insights-types";
import { reviewModelQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import { ModelLibrary } from "./model-library";
import { SettingsPage, SettingsSection, StatusNote } from "./settings-page";

export function ModelsSettings() {
    const { ws, workspace } = useWorkspace();
    const query = useQuery(reviewModelQuery(ws));
    const data = query.data;
    const allowance = useQuery(allowanceQuery(ws));

    return (
        <SettingsPage
            title="Models"
            wide
            description={`The models Open Code Review uses for ${workspace.name}'s reviews, and the providers they come from, each with its own API key.`}
        >
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : !data ? (
                <LoadingRows rows={4} />
            ) : (
                <>
                    <StatusNote data-testid="review-model-status">
                        {data.ready
                            ? `Ready: reviews use ${data.model} through ${data.providers.find((p) => p.id === data.provider)?.name ?? data.provider}.`
                            : allowance.data?.now.ready
                              ? `Ready: reviews use ${allowance.data.now.model} through the instance's key.`
                              : `Not ready: ${allowance.data && !allowance.data.now.ready ? allowance.data.now.reason : `add ${data.missing ?? "an API key"}.`}`}
                    </StatusNote>
                    <ModelLibrary data={data} />
                    {allowance.data && <InstanceKeyStatus a={allowance.data} />}
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
                    <p>This workspace can't use the instance's key. Reviews need a provider's key of its own, above.</p>
                ) : (
                    <>
                        <p>
                            This workspace may use the instance's key ({a.instance.providerName},{" "}
                            <span className="font-mono">{a.instance.model}</span>) for up to {count(a.monthlyTokens)} tokens a month.{" "}
                            {!a.instance.keySet
                                ? "The instance administrator hasn't set the key up yet."
                                : usingIt
                                  ? "Reviews use it now, because this workspace's default model isn't ready."
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
