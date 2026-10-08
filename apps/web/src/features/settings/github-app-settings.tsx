// Instance → GitHub App: creating the instance's app with GitHub's manifest flow (GitHub hands back its
// keys, which are stored encrypted), what it is, the deliveries to its webhook, and removing it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmAction } from "@/components/confirm-action";
import { CopyButton } from "@/components/copy-button";
import { CheckField, ControlGroup, Field, FieldError } from "@/components/field";
import { FormActions } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Deliveries, Refused } from "@/features/runs/pull-requests-page";
import { api, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { githubAppQuery, keys } from "@/lib/queries";
import { safeHref } from "@/lib/safe-href";
import { useMe, useWorkspace } from "@/lib/session";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

export function GithubAppSettings() {
    const me = useMe();
    const { ws } = useWorkspace();
    const queryClient = useQueryClient();
    const created = useLocation({ select: (l) => Boolean((l.search as { created?: string }).created) });
    const status = useQuery({ ...githubAppQuery, enabled: me.user.isInstanceAdmin });
    const [name, setName] = useState("Triagent");
    const [org, setOrg] = useState("");
    const [isPublic, setPublic] = useState(false);
    const start = useMutation({
        mutationFn: () =>
            api.post<{ formUrl: string }>("/api/v1/instance/github-app/manifest", {
                name: name.trim(),
                public: isPublic,
                org: org.trim() || null,
                ws,
            }),
        onSuccess: (r) => window.location.assign(r.formUrl),
    });

    if (!me.user.isInstanceAdmin)
        return (
            <SettingsPage title="GitHub App">
                <ReadOnlyNote>Only instance administrators can set up the GitHub App.</ReadOnlyNote>
            </SettingsPage>
        );
    const data = status.data;
    const appUrl = safeHref(data?.app?.htmlUrl ?? null);
    return (
        <SettingsPage
            title="GitHub App"
            description="One app for the whole instance. Workspaces install it on their GitHub accounts, and each project picks a repository from their installations."
        >
            {status.isError ? (
                <LoadError error={status.error} onRetry={() => status.refetch()} />
            ) : !data ? (
                <LoadingRows rows={4} />
            ) : data.configured && data.app ? (
                <>
                    {created && (
                        <Alert>
                            <AlertTitle>The GitHub App is ready</AlertTitle>
                            <AlertDescription>
                                Its keys are stored encrypted. Workspaces can now install it from a project's GitHub settings.
                            </AlertDescription>
                        </Alert>
                    )}
                    <SettingsSection title="The app">
                        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                            <dt className="text-muted-foreground">Name</dt>
                            <dd>
                                {appUrl ? (
                                    <a href={appUrl} target="_blank" rel="noopener noreferrer" className="underline">
                                        {data.app.name}
                                        <span className="sr-only"> (opens in a new tab)</span>
                                    </a>
                                ) : (
                                    data.app.name
                                )}
                            </dd>
                            <dt className="text-muted-foreground">Owner</dt>
                            <dd>{data.app.owner ?? "your account"}</dd>
                            <dt className="text-muted-foreground">App id</dt>
                            <dd className="font-mono">{data.app.appId}</dd>
                            <dt className="text-muted-foreground">Created</dt>
                            <dd>
                                by {data.app.createdBy} on {formatDate(data.app.createdAt)}
                            </dd>
                        </dl>
                        <Field label="Webhook URL">
                            {(p) => (
                                <ControlGroup>
                                    <Input {...p} readOnly value={data.webhookUrl} className="font-mono text-xs" />
                                    <CopyButton value={data.webhookUrl} />
                                </ControlGroup>
                            )}
                        </Field>
                        <FormActions>
                            <ConfirmAction
                                trigger={<Button variant="outline">Remove the app</Button>}
                                title="Remove the GitHub App?"
                                description="Triagent forgets its keys, and every workspace's installations are unlinked: their projects stop reaching GitHub until it's set up again. Delete the app on GitHub too."
                                confirmLabel="Remove the app"
                                typeToConfirm={data.app.slug}
                                onConfirm={async () => {
                                    await api.delete("/api/v1/instance/github-app");
                                    await queryClient.invalidateQueries({ queryKey: keys.githubApp });
                                }}
                            />
                        </FormActions>
                    </SettingsSection>
                    <SettingsSection
                        title="Webhook deliveries"
                        description="Deliveries no project took, such as for installations not linked to a workspace. Those with a bad or missing signature are only counted."
                    >
                        <Refused refused={data.refused} />
                        <Deliveries items={data.deliveries} />
                    </SettingsSection>
                </>
            ) : (
                <SettingsSection
                    title="Create the GitHub App"
                    description={
                        <>
                            GitHub creates the app from a description Triagent sends (its permissions: read code, write pull request
                            comments and commit statuses), then hands its keys back here. You'll confirm on {new URL(data.githubUrl).host}.
                        </>
                    }
                >
                    <form
                        className="grid gap-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            start.mutate();
                        }}
                    >
                        <Field label="Name" hint="Shown on GitHub next to its comments and checks. It must be unique on GitHub.">
                            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={34} required />}
                        </Field>
                        <Field label="Organisation" hint="Leave empty to create it on your own GitHub account.">
                            {(p) => (
                                <Input {...p} value={org} onChange={(e) => setOrg(e.target.value)} spellCheck={false} autoComplete="off" />
                            )}
                        </Field>
                        <CheckField
                            label="Any GitHub account can install it"
                            hint="Needed if other people's workspaces use this instance. Otherwise only its owner's account can install it."
                        >
                            {(p) => <Checkbox {...p} checked={isPublic} onCheckedChange={(v) => setPublic(v === true)} />}
                        </CheckField>
                        <FieldError message={start.error ? errorMessage(start.error) : null} />
                        <FormActions>
                            <Button type="submit" disabled={start.isPending || name.trim().length < 3}>
                                Continue to GitHub…
                            </Button>
                        </FormActions>
                    </form>
                </SettingsSection>
            )}
        </SettingsPage>
    );
}
