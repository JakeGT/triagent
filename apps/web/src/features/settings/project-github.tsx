import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PowerOff } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { CopyButton } from "@/components/copy-button";
import { ControlGroup, Field, FieldError } from "@/components/field";
import { FormActions } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { OneTimeReveal } from "@/components/one-time-reveal";
import { SecretField } from "@/components/secret-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage, paths } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { githubQuery, keys } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import type { GithubSettings } from "@/lib/types";
import { GithubAppConnection, TestConnection } from "./github-app-connection";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

export function ProjectGithub() {
    const { ws, slug, project } = useProject();
    const can = useCan();
    const query = useQuery({ ...githubQuery(ws, slug), enabled: can("configure") });

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
                    <Link to="/w/$ws/p/$project/settings/general" params={{ ws, project: slug }} className="link">
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
                    {/* Keyed by project, so a one-time secret or a pending result never shows on another project's page. */}
                    {/* The instance's app is on its own GitHub: no use to a workspace on a GitHub Enterprise server. */}
                    {!(data.workspace.ownServer && !data.repository) && <GithubAppConnection key={`app-${slug}`} data={data} />}
                    <ChecksNote data={data} />
                    <TestConnection key={`test-${slug}`} data={data} />
                    <GithubTokenSection key={`token-${slug}`} data={data} />
                    <WebhookSection key={`webhook-${slug}`} data={data} />
                </>
            )}
        </SettingsPage>
    );
}

/**
 * GitHub has refused to show this connection a commit's check runs, so a pull request's first review
 * can't wait for them: what to change on GitHub.
 */
export function ChecksNote({ data }: { data: GithubSettings }) {
    // With nothing connected, what an earlier connection was refused says nothing about the next one.
    if (data.checksReadable !== false || data.mode === "none") return null;
    return (
        <Alert data-testid="checks-note">
            <AlertTitle>Triagent can't see this repository's checks</AlertTitle>
            <AlertDescription>
                <p>
                    A pull request's first review is meant to wait until its checks have passed. Until Triagent can read them, pull requests
                    are reviewed as soon as they're ready instead.
                </p>
                {data.mode === "app" && data.app.available ? (
                    <>
                        <p>
                            The GitHub App needs the repository permission <span className="font-medium">Checks: Read-only</span>, and the
                            events <span className="font-medium">Check suite</span>, <span className="font-medium">Check run</span>, and{" "}
                            <span className="font-medium">Status</span>. Whoever owns the app can add them on GitHub: open{" "}
                            <a href={data.app.htmlUrl} target="_blank" rel="noopener noreferrer" className="link">
                                the app's page<span className="sr-only"> (opens in a new tab)</span>
                            </a>{" "}
                            and choose App settings, or go to Settings → Developer settings → GitHub Apps → {data.app.name}, then
                            Permissions & events.
                        </p>
                        <p>
                            GitHub then asks an owner of each account the app is installed on to accept the new permission; it only takes
                            effect on an installation once that's done.
                        </p>
                    </>
                ) : (
                    <p>
                        GitHub doesn't let this access token read check runs (fine-grained tokens can't); commit statuses are still read.
                        Connect through the GitHub App to wait for checks.
                    </p>
                )}
            </AlertDescription>
        </Alert>
    );
}

/** What the project's own token is instead of: the workspace's token, or the app where it could be used. */
export function tokenTitle(data: GithubSettings): string {
    if (data.workspace.token && data.workspace.method === "token") return "Access token (instead of the workspace's)";
    // The instance's app can't reach a workspace's own GitHub Enterprise server.
    if (data.app.available && !data.workspace.ownServer) return "Access token (instead of the app)";
    return "Access token";
}

/** The project's own token: instead of the GitHub App or the workspace's token, or where there's neither. */
export function GithubTokenSection({ data }: { data: GithubSettings }) {
    const { ws, slug } = useProject();
    const can = useCan();
    const canSecrets = can("secrets");
    const queryClient = useQueryClient();
    const base = `${paths.project(ws, slug)}/settings/github`;
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.projectSettings(ws, slug, "github") });
    return (
        <SettingsSection
            title={tokenTitle(data)}
            description={
                <>
                    {data.tokenFrom === "workspace" && (
                        <span className="mb-2 block" data-testid="workspace-token-note">
                            This project uses the workspace's token
                            {data.workspace.token?.owner ? ` (${data.workspace.token.owner})` : ""}, set in the workspace's{" "}
                            <Link to="/w/$ws/settings/github" params={{ ws }} className="link">
                                GitHub settings
                            </Link>
                            . A token here is used instead.
                        </span>
                    )}
                    A fine-grained personal access token{data.workspace.ownServer ? ` on ${data.workspace.server}` : ""} limited to{" "}
                    {data.repoUrl ? <span className="font-mono">{data.repoUrl}</span> : "the repository"}, with read access to contents and
                    read and write access to pull requests and commit statuses. It's stored encrypted and never shown again.
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
    );
}

/** GitHub's webhook for a project connected with a token (the app has its own). */
export function WebhookSection({ data }: { data: GithubSettings }) {
    const { ws, slug } = useProject();
    const can = useCan();
    const canSecrets = can("secrets");
    const queryClient = useQueryClient();
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
    return (
        <SettingsSection
            title={data.app.available ? "Webhook for the token" : "Webhook"}
            description={
                data.app.available
                    ? "Only needed with an access token: the GitHub App has its own webhook. Lets GitHub tell Triagent about new pull requests and pushes straight away."
                    : "Lets GitHub tell Triagent about new pull requests and pushes straight away, instead of Triagent checking every few minutes."
            }
        >
            <Field label="Payload URL">
                {(p) => (
                    <ControlGroup>
                        <Input {...p} readOnly value={data.webhook.url} className="font-mono text-xs" />
                        <CopyButton value={data.webhook.url} />
                    </ControlGroup>
                )}
            </Field>
            <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
                <li>In the repository on GitHub, open Settings → Webhooks → Add webhook.</li>
                <li>Paste the payload URL above, and set the content type to application/json.</li>
                <li>Generate a secret here and paste it into the Secret box.</li>
                <li>
                    Choose “Let me select individual events” and tick Pull requests, Pushes, Branch or tag creation and deletion, Check
                    runs, Check suites, Statuses and Issue comments.
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
                <FormActions>
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
                            trigger={
                                <Button variant="danger" className="ms-3">
                                    <PowerOff /> Turn the webhook off
                                </Button>
                            }
                            title="Turn the webhook off?"
                            description="The secret is deleted and deliveries from GitHub are refused. Triagent goes back to checking for pull requests on a timer. To turn it on again, generate a new secret."
                            confirmLabel="Turn the webhook off"
                            onConfirm={async () => {
                                await api.delete(`${base}/webhook-secret`);
                                setSecret(null);
                                await refresh();
                                toast.success("Webhook turned off.");
                            }}
                        />
                    )}
                </FormActions>
            )}
            <FieldError message={generate.error ? errorMessage(generate.error) : null} />
        </SettingsSection>
    );
}
