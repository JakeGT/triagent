// Settings → Workspace → GitHub: how this workspace's projects reach GitHub when they don't say otherwise
// (each picks a repository from the instance's GitHub App, or they share the workspace's token), and which
// GitHub that is: the instance's, or the workspace's own GitHub Enterprise Server. A project's own GitHub
// settings still win.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { type Choice, ChoiceField, Field, FieldError } from "@/components/field";
import { FormActions } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { SecretField } from "@/components/secret-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage, paths } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { keys, workspaceGithubQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import type { GithubMethod, WorkspaceGithub } from "@/lib/types";
import { ReadOnlyNote, SettingsPage, SettingsSection, StatusNote } from "./settings-page";

const KIND: Record<NonNullable<WorkspaceGithub["token"]["kind"]>, string> = {
    "fine-grained": "Fine-grained token",
    classic: "Classic token",
    oauth: "OAuth token",
};

interface Draft {
    method: GithubMethod;
    enterprise: boolean;
    server: string;
}

/** Why the app can't be chosen with this draft, or null. */
function whyNoApp(d: Draft, data: WorkspaceGithub): string | null {
    if (d.enterprise) return "The instance's GitHub App is on its own GitHub, so it can't reach a GitHub Enterprise server.";
    if (!data.instanceApp) return "This instance has no GitHub App. An instance admin can set one up.";
    return null;
}

const draftOf = (d: WorkspaceGithub): Draft => ({ method: d.method, enterprise: d.server !== null, server: d.server ?? "" });

export function WorkspaceGithubSettings() {
    const { ws, can } = useWorkspace();
    const query = useQuery({ ...workspaceGithubQuery(ws), enabled: can("configure") });

    if (!can("configure"))
        return (
            <SettingsPage title="GitHub">
                <ReadOnlyNote>Only admins of this workspace can see its GitHub settings.</ReadOnlyNote>
            </SettingsPage>
        );

    return (
        <SettingsPage
            title="GitHub"
            description="How this workspace's projects reach GitHub, unless a project's own GitHub settings say otherwise."
        >
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : !query.data ? (
                <LoadingRows rows={4} />
            ) : (
                <>
                    <Status data={query.data} />
                    <Connection data={query.data} />
                    <Token data={query.data} />
                </>
            )}
        </SettingsPage>
    );
}

function Status({ data }: { data: WorkspaceGithub }) {
    const where = data.server ?? data.defaultServer;
    if (data.method === "app")
        return (
            <StatusNote data-testid="workspace-github-status">
                Each project picks its repository from the GitHub App in its own GitHub settings.
            </StatusNote>
        );
    return (
        <StatusNote data-testid="workspace-github-status">
            {data.token.set
                ? `Projects without a connection of their own use the workspace's token${data.token.owner ? ` (${data.token.owner})` : ""} on ${where}.`
                : `Not ready: add the workspace's token below. Until then, projects need a connection of their own.`}
        </StatusNote>
    );
}

function Connection({ data }: { data: WorkspaceGithub }) {
    const { ws, can } = useWorkspace();
    const queryClient = useQueryClient();
    const form = useDraft<Draft>(draftOf(data));
    const [missing, setMissing] = useState<string | null>(null);
    const save = useMutation({
        mutationFn: (d: Draft) =>
            api.put<WorkspaceGithub>(`${paths.workspace(ws)}/settings/github`, {
                method: d.method,
                server: d.enterprise ? d.server.trim() : null,
            }),
        onSuccess: async (saved) => {
            form.saved(draftOf(saved));
            queryClient.setQueryData(keys.wsSettings(ws, "github"), saved);
            await queryClient.invalidateQueries({ queryKey: keys.ws(ws) });
            toast.success("GitHub settings saved.");
        },
    });
    if (form.draft === undefined) return null;
    const d = form.draft;
    const appBlocked = whyNoApp(d, data);
    // Moving server sends every token in the workspace there: it takes the secrets permission, and forgets the workspace's token.
    const savedEnterprise = data.server !== null;
    const moving = d.enterprise !== savedEnterprise || (d.enterprise && d.server.trim() !== (data.server ?? ""));
    const methods: Choice<GithubMethod>[] = [
        {
            value: "app",
            label: "The GitHub App",
            hint:
                appBlocked ?? "Each project picks one of the repositories the app is installed on. Comments and checks come from the app.",
            disabled: appBlocked !== null,
        },
        {
            value: "token",
            label: "A token for the whole workspace",
            hint: "A personal access token, fine-grained or classic, used for every project's repository address. Comments and checks come from the token's owner.",
        },
    ];
    const servers: Choice<"github" | "enterprise">[] = [
        { value: "github", label: data.defaultServer.replace(/^https:\/\//, ""), hint: "The GitHub this instance is set up for." },
        {
            value: "enterprise",
            label: "GitHub Enterprise Server",
            hint: "Your own GitHub server. Projects reach it with tokens; their repository addresses should be on it.",
        },
    ];

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                setMissing(d.enterprise && !d.server.trim() ? "Enter the GitHub Enterprise server's address." : null);
                if (d.enterprise && !d.server.trim()) return;
                save.mutate(d);
            }}
        >
            <SettingsSection
                title="Connection"
                description="A project with a repository from the app, or a token of its own, keeps using that."
            >
                <ChangedElsewhere show={form.changedElsewhere} onReload={form.reload} what="These settings" />
                <ChoiceField
                    legend="GitHub server"
                    name="github-server"
                    value={d.enterprise ? "enterprise" : "github"}
                    choices={servers}
                    onChange={(v) =>
                        // Enterprise needs a token; back on the instance's GitHub, the method saved for it returns.
                        form.setDraft({
                            ...d,
                            enterprise: v === "enterprise",
                            method: v === "enterprise" || savedEnterprise ? "token" : data.method,
                        })
                    }
                    disabled={!can("secrets")}
                />
                {!can("secrets") && <p className="text-sm text-muted-foreground">Only admins who manage secrets can change the server.</p>}
                {d.enterprise && (
                    <Field label="Server address">
                        {(p) => (
                            <Input
                                {...p}
                                type="url"
                                inputMode="url"
                                spellCheck={false}
                                autoComplete="off"
                                className="font-mono"
                                placeholder="https://github.example.com"
                                value={d.server}
                                onChange={(e) => form.setDraft({ ...d, server: e.target.value })}
                                disabled={!can("secrets")}
                            />
                        )}
                    </Field>
                )}
                <ChoiceField
                    legend="How projects connect"
                    name="github-method"
                    value={d.method}
                    choices={methods}
                    onChange={(v) => form.setDraft({ ...d, method: v })}
                />
                {moving && data.token.set && (
                    <p className="text-sm text-muted-foreground" data-testid="server-move-note">
                        Saving forgets the workspace's token: a token for one GitHub is no use on another. Add one for the new server
                        afterwards.
                    </p>
                )}
                <FieldError message={missing ?? (save.error ? errorMessage(save.error) : null)} />
                <FormActions>
                    <Button type="submit" disabled={save.isPending || !form.dirty}>
                        {save.isPending ? "Saving…" : "Save connection"}
                    </Button>
                </FormActions>
            </SettingsSection>
        </form>
    );
}

function Token({ data }: { data: WorkspaceGithub }) {
    const { ws, can } = useWorkspace();
    const queryClient = useQueryClient();
    if (data.method !== "token" && !data.token.set) return null;
    const url = `${paths.workspace(ws)}/settings/github/token`;
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.ws(ws) });
    const where = data.server ?? data.defaultServer;
    return (
        <SettingsSection
            title="Workspace token"
            description={
                <>
                    A fine-grained token (on {where.replace(/^https:\/\//, "")}, under Settings → Developer settings) limited to your
                    projects' repositories, with read access to contents and read and write access to pull requests and commit statuses; or
                    a classic token with the <span className="font-mono">repo</span> scope. It's checked with GitHub, stored encrypted and
                    never shown again.
                </>
            }
        >
            {data.method !== "token" && (
                <p className="text-sm text-muted-foreground">Kept, but not used while projects connect through the GitHub App.</p>
            )}
            <SecretField
                label="GitHub token"
                secret={data.token}
                hint={
                    data.token.set && data.token.kind
                        ? `${KIND[data.token.kind]}, belongs to ${data.token.owner ?? "someone GitHub didn't name"}.`
                        : undefined
                }
                canEdit={can("secrets")}
                onSave={async (token) => {
                    await api.put(url, { token });
                    await refresh();
                    toast.success("Workspace token saved.");
                }}
                onClear={async () => {
                    await api.delete(url);
                    await refresh();
                    toast.success("Workspace token cleared.");
                }}
            />
        </SettingsSection>
    );
}
