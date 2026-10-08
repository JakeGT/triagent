// The GitHub App part of a project's GitHub settings: installing the app on a GitHub account (linked to
// this workspace once GitHub confirms you can see it), picking one of its repositories, and checking the
// connection works.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { FieldError, NativeSelect } from "@/components/field";
import { LoadingRows } from "@/components/load-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api, errorMessage, paths } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { installationsQuery, keys } from "@/lib/queries";
import { useCan, useMe, useProject } from "@/lib/session";
import type { GithubSettings } from "@/lib/types";
import { SettingsSection } from "./settings-page";

/** What came back from GitHub after installing the app (?github=…). */
const OUTCOMES: Record<string, { ok: boolean; text: string }> = {
    linked: { ok: true, text: "The installation is linked to this workspace. Choose a repository below." },
    "not-yours": {
        ok: false,
        text: "GitHub says your account can't see that installation, so it wasn't linked. Install the app from an account that owns or administers it.",
    },
    "not-admin": {
        ok: false,
        text: "Only an owner of the GitHub organisation can link its installation, so it wasn't linked. Ask one of them to install the app from here.",
    },
    "not-account": {
        ok: false,
        text: "That installation is on someone else's personal GitHub account, so it wasn't linked. Ask them to install the app from here.",
    },
    "members-permission": {
        ok: false,
        text: "The GitHub App can't check who owns the organisation. An instance admin needs to give it the Organization members (read) permission in its settings on GitHub. Then try again.",
    },
    "not-you": { ok: false, text: "That link was started by someone else. Start the installation again from here." },
    "not-allowed": { ok: false, text: "You're no longer allowed to manage this workspace's secrets, so nothing was linked." },
    "no-authorization": {
        ok: false,
        text: "GitHub didn't send your authorization back, so the installation couldn't be checked. Try again.",
    },
    taken: { ok: false, text: "That installation is already linked to another workspace. Unlink it there first." },
    failed: { ok: false, text: "GitHub couldn't confirm the installation. Try again in a moment." },
};

export function GithubAppConnection({ data }: { data: GithubSettings }) {
    const { ws, slug } = useProject();
    const can = useCan();
    const me = useMe();
    const queryClient = useQueryClient();
    const selectId = useId();
    const outcome = useLocation({ select: (l) => (l.search as { github?: string }).github });
    const installations = useQuery({ ...installationsQuery(ws), enabled: data.app.available && data.installations.length > 0 });
    const [choice, setChoice] = useState("");
    const base = `${paths.project(ws, slug)}/settings/github`;
    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: keys.projectSettings(ws, slug, "github") });
        void queryClient.invalidateQueries({ queryKey: keys.installations(ws) });
        void queryClient.invalidateQueries({ queryKey: keys.pullRequests(ws, slug) });
    };

    const install = useMutation({
        mutationFn: () => api.post<{ url: string }>(`${paths.workspace(ws)}/github/installations`, { project: slug }),
        onSuccess: (r) => window.location.assign(r.url),
    });
    const pick = useMutation({
        mutationFn: (v: { installationId: number; repositoryId: number }) => api.put(`${base}/repository`, v),
        onSuccess: () => {
            toast.success("Repository saved.");
            setChoice("");
            refresh();
        },
    });

    if (!data.app.available)
        return (
            <SettingsSection title="GitHub App">
                <p className="text-sm text-muted-foreground">
                    This instance has no GitHub App yet, so this project uses an access token (below).{" "}
                    {me.user.isInstanceAdmin ? (
                        <Link to="/w/$ws/settings/github-app" params={{ ws }} className="underline">
                            Set up the GitHub App
                        </Link>
                    ) : (
                        "An instance administrator can set one up."
                    )}
                </p>
            </SettingsSection>
        );

    const repos = (installations.data ?? []).flatMap((i) =>
        i.repositories.map((r) => ({ ...r, installationId: i.id, account: i.account })),
    );
    const shown = outcome ? OUTCOMES[outcome] : undefined;
    return (
        <SettingsSection
            title="GitHub App"
            description={
                <>
                    Triagent reaches the repository as the instance's app, <span className="font-medium">{data.app.name}</span>, with
                    short-lived tokens for this repository only. Its webhook tells Triagent about pull requests straight away.
                </>
            }
        >
            {shown && (
                <Alert variant={shown.ok ? "default" : "destructive"} data-testid="install-outcome">
                    <AlertTitle>{shown.ok ? "Installed" : "Not linked"}</AlertTitle>
                    <AlertDescription>{shown.text}</AlertDescription>
                </Alert>
            )}
            <p className="text-sm" data-testid="github-mode">
                {data.repository
                    ? `Connected to ${data.repository.fullName} through the GitHub App.`
                    : data.mode === "token"
                      ? "Not using the app: this project uses its access token."
                      : "Not connected yet."}
            </p>
            <div className="grid gap-2">
                <h4 className="text-sm font-medium">Installations in this workspace</h4>
                {data.installations.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        None yet. Install the app on the GitHub account or organisation that has the repository.
                    </p>
                ) : (
                    <ul className="grid gap-1 text-sm">
                        {data.installations.map((i) => (
                            <li key={i.id}>
                                <span className="font-medium">{i.account}</span> (
                                {i.repositorySelection === "all" ? "all repositories" : "chosen repositories"}
                                {i.suspended ? ", suspended" : ""}), linked by {i.linkedBy} on {formatDate(i.linkedAt)}
                            </li>
                        ))}
                    </ul>
                )}
                {can("secrets") && (
                    <div>
                        <Button variant="outline" onClick={() => install.mutate()} disabled={install.isPending}>
                            Install on GitHub…
                        </Button>
                        <FieldError message={install.error ? errorMessage(install.error) : null} />
                    </div>
                )}
            </div>
            {data.installations.length > 0 && can("configure") && (
                <form
                    className="grid gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        const r = repos.find((x) => `${x.installationId}:${x.id}` === choice);
                        if (r) pick.mutate({ installationId: r.installationId, repositoryId: r.id });
                    }}
                >
                    <Label htmlFor={selectId}>Repository</Label>
                    {installations.isPending ? (
                        <LoadingRows rows={1} />
                    ) : (
                        <div className="flex flex-wrap gap-2">
                            <NativeSelect id={selectId} value={choice} onChange={(e) => setChoice(e.target.value)} className="w-80">
                                <option value="">
                                    {data.repository ? `${data.repository.fullName} (current)` : "Choose a repository…"}
                                </option>
                                {repos.map((r) => (
                                    <option key={`${r.installationId}:${r.id}`} value={`${r.installationId}:${r.id}`}>
                                        {r.fullName}
                                    </option>
                                ))}
                            </NativeSelect>
                            <Button type="submit" disabled={!choice || pick.isPending}>
                                Use this repository
                            </Button>
                        </div>
                    )}
                    {(installations.data ?? []).some((i) => i.error) && (
                        <p className="text-sm text-destructive">{installations.data?.find((i) => i.error)?.error}</p>
                    )}
                    <FieldError message={pick.error ? errorMessage(pick.error) : null} />
                </form>
            )}
            {data.repository && can("configure") && (
                <div>
                    <ConfirmAction
                        trigger={<Button variant="ghost">Stop using the app</Button>}
                        title="Stop using the GitHub App for this project?"
                        description="The project goes back to its access token, if it has one; otherwise reviews can't reach the repository."
                        confirmLabel="Stop using the app"
                        onConfirm={async () => {
                            await api.delete(`${base}/repository`);
                            refresh();
                        }}
                    />
                </div>
            )}
        </SettingsSection>
    );
}

/** Read the repository and its pull requests with whatever the project uses, to show it works. */
export function TestConnection({ data }: { data: GithubSettings }) {
    const { ws, slug } = useProject();
    const test = useMutation({
        mutationFn: () =>
            api.post<{ note: string; repository: { fullName: string }; openPulls: number }>(
                `${paths.project(ws, slug)}/settings/github/test`,
            ),
    });
    if (data.mode === "none") return null;
    return (
        <SettingsSection title="Check the connection">
            <div>
                <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
                    {test.isPending ? "Checking…" : "Test the connection"}
                </Button>
            </div>
            {test.data && (
                <p className="text-sm" role="status">
                    {test.data.note} {test.data.repository.fullName} has {test.data.openPulls} open pull request
                    {test.data.openPulls === 1 ? "" : "s"}.
                </p>
            )}
            <FieldError message={test.error ? errorMessage(test.error) : null} />
        </SettingsSection>
    );
}
