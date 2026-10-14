// Settings → Workspace → GitHub: how this workspace's projects reach GitHub when they don't say otherwise
// (each picks a repository from the instance's GitHub App, or they share the workspace's token), and which
// GitHub that is: the instance's, or the workspace's own GitHub Enterprise Server. A project's own GitHub
// settings still win.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
    const editable = can("configure");
    const appBlocked = d.enterprise
        ? "The instance's GitHub App is on its own GitHub, so it can't reach a GitHub Enterprise server."
        : !data.appAvailable && data.server === null
          ? "This instance has no GitHub App. An instance admin can set one up."
          : null;
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
                save.mutate(d);
            }}
        >
            <SettingsSection
                title="Connection"
                description="A project with a repository from the app, or a token of its own, keeps using that."
            >
                <ChoiceField
                    legend="GitHub server"
                    name="github-server"
                    value={d.enterprise ? "enterprise" : "github"}
                    choices={servers}
                    onChange={(v) =>
                        form.setDraft({ ...d, enterprise: v === "enterprise", method: v === "enterprise" ? "token" : d.method })
                    }
                    disabled={!editable}
                />
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
                                disabled={!editable}
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
                    disabled={!editable}
                />
                <FieldError message={save.error ? errorMessage(save.error) : null} />
                {editable && (
                    <FormActions>
                        <Button type="submit" disabled={save.isPending || !form.dirty}>
                            {save.isPending ? "Saving…" : "Save connection"}
                        </Button>
                    </FormActions>
                )}
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
