import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { CopyButton } from "@/components/copy-button";
import { FieldError } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { OneTimeReveal } from "@/components/one-time-reveal";
import { SecretField } from "@/components/secret-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage, paths } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { githubQuery, keys } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import { GithubAppConnection, TestConnection } from "./github-app-connection";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

export function ProjectGithub() {
    const { ws, slug, project } = useProject();
    const can = useCan();
    const queryClient = useQueryClient();
    const urlId = useId();
    const query = useQuery({ ...githubQuery(ws, slug), enabled: can("configure") });
    const [secret, setSecret] = useState<string | null>(null);
    const dismiss = useCallback(() => setSecret(null), []);
    const base = `${paths.project(ws, slug)}/settings/github`;
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.projectSettings(ws, slug, "github") });

    const generate = useMutation({
        mutationFn: () => api.post<{ webhookSecret: string; url: string }>(`${base}/webhook-secret`),
        onSuccess: (r) => {
            setSecret(r.webhookSecret);
            void refresh();
        },
    });

    if (!can("configure"))
        return (
            <SettingsPage title="GitHub">
                <ReadOnlyNote>Only admins of this workspace can see the GitHub connection.</ReadOnlyNote>
            </SettingsPage>
        );

    const data = query.data;
    const canSecrets = can("secrets");
    return (
        <SettingsPage
            title="GitHub"
            description={
                <>
                    How Triagent reaches {project.name}'s repository. The repository URL and default branch are set on{" "}
                    <Link to="/w/$ws/p/$project/settings/general" params={{ ws, project: slug }} className="underline">
                        General
                    </Link>
                    .
                </>
            }
        >
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : !data ? (
                <LoadingRows rows={4} />
            ) : (
                <>
                    {!canSecrets && <ReadOnlyNote>Only admins can set or clear secrets.</ReadOnlyNote>}
                    <GithubAppConnection data={data} />
                    <TestConnection data={data} />
                    <SettingsSection
                        title={data.app.available ? "Access token (instead of the app)" : "Access token"}
                        description={
                            <>
                                A fine-grained personal access token limited to{" "}
                                {data.repoUrl ? <span className="font-mono">{data.repoUrl}</span> : "the repository"}, with read access to
                                contents and read and write access to pull requests and commit statuses. It's stored encrypted and never
                                shown again.
                            </>
                        }
                    >
                        <SecretField
                            label="GitHub token"
                            secret={data.connection.token}
                            canEdit={canSecrets}
                            onSave={async (token) => {
                                await api.put(`${base}/token`, { token });
                                await refresh();
                                toast.success("GitHub token saved.");
                            }}
                            onClear={async () => {
                                await api.delete(`${base}/token`);
                                await refresh();
                                toast.success("GitHub token cleared.");
                            }}
                        />
                    </SettingsSection>

                    <SettingsSection
                        title={data.app.available ? "Webhook for the token" : "Webhook"}
                        description={
                            data.app.available
                                ? "Only needed with an access token: the GitHub App has its own webhook. Lets GitHub tell Triagent about new pull requests and pushes straight away."
                                : "Lets GitHub tell Triagent about new pull requests and pushes straight away, instead of Triagent checking every few minutes."
                        }
                    >
                        <div className="grid gap-1.5">
                            <Label htmlFor={urlId}>Payload URL</Label>
                            <div className="flex flex-wrap gap-2">
                                <Input id={urlId} readOnly value={data.webhook.url} className="min-w-0 flex-1 font-mono text-xs" />
                                <CopyButton value={data.webhook.url} />
                            </div>
                        </div>
                        <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
                            <li>In the repository on GitHub, open Settings → Webhooks → Add webhook.</li>
                            <li>Paste the payload URL above, and set the content type to application/json.</li>
                            <li>Generate a secret here and paste it into the Secret box.</li>
                            <li>
                                Choose “Let me select individual events” and tick Pull requests, Pushes, and Branch or tag creation and
                                deletion.
                            </li>
                        </ol>
                        <p className="text-sm">
                            Secret:{" "}
                            {data.webhook.secretSet
                                ? `set${data.webhook.setBy ? ` by ${data.webhook.setBy}` : ""}${data.webhook.setAt ? ` on ${formatDate(data.webhook.setAt)}` : ""}`
                                : "not set (the webhook is off)"}
                        </p>
                        {secret && (
                            <OneTimeReveal
                                value={secret}
                                label="Webhook secret"
                                hint="Paste it into the Secret box of the webhook's settings on GitHub."
                                onDismiss={dismiss}
                            />
                        )}
                        {canSecrets && (
                            <div className="flex flex-wrap gap-2">
                                {data.webhook.secretSet ? (
                                    <ConfirmAction
                                        trigger={<Button variant="outline">Generate a new secret</Button>}
                                        title="Replace the webhook secret?"
                                        description="The current secret stops working at once. GitHub's deliveries fail until you paste the new one into the webhook's settings."
                                        confirmLabel="Generate a new secret"
                                        destructive={false}
                                        onConfirm={() => generate.mutateAsync()}
                                    />
                                ) : (
                                    <Button variant="outline" onClick={() => generate.mutate()} disabled={generate.isPending}>
                                        Generate a secret
                                    </Button>
                                )}
                                {data.webhook.secretSet && (
                                    <ConfirmAction
                                        trigger={<Button variant="ghost">Turn the webhook off</Button>}
                                        title="Turn the webhook off?"
                                        description="The secret is deleted and deliveries from GitHub are refused. Triagent goes back to checking for pull requests on a timer."
                                        confirmLabel="Turn off"
                                        onConfirm={async () => {
                                            await api.delete(`${base}/webhook-secret`);
                                            setSecret(null);
                                            await refresh();
                                            toast.success("Webhook turned off.");
                                        }}
                                    />
                                )}
                            </div>
                        )}
                        <FieldError message={generate.error ? errorMessage(generate.error) : null} />
                    </SettingsSection>
                </>
            )}
        </SettingsPage>
    );
}
