// The guided setups' steps: what a new account, workspace and project need, in order. Each step is the
// same form as in Settings, and it's done when the setting is (a workspace's model is ready, a project
// reaches GitHub), so the setup can be left and picked up again without losing track.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CheckField, Field, FieldError, NativeSelect } from "@/components/field";
import { FormActions } from "@/components/form";
import { CreateOrganisationForm } from "@/components/layout/pickers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AppearanceSections } from "@/features/settings/appearance-settings";
import { GithubAppConnection, TestConnection } from "@/features/settings/github-app-connection";
import { AddPeople } from "@/features/settings/members-settings";
import { ModelLibrary } from "@/features/settings/model-library";
import { NotificationsForm } from "@/features/settings/notifications-settings";
import { GithubTokenSection, WebhookSection } from "@/features/settings/project-github";
import { CreateProjectForm } from "@/features/settings/projects-settings";
import { StatusNote } from "@/features/settings/settings-page";
import { api, errorMessage, paths } from "@/lib/api";
import { allowanceQuery } from "@/lib/insights-queries";
import type { Allowance } from "@/lib/insights-types";
import { automationQuery, githubQuery, keys, membersQuery, meQuery, projectsQuery, reviewModelQuery } from "@/lib/queries";
import { useMe, useProject, useWorkspace } from "@/lib/session";
import { isExample, tutorialApi } from "@/lib/tutorial";
import type { Automation, Project, ReviewModel } from "@/lib/types";
import type { SetupFlow, SetupStep } from "./setup-dialog";
import { closeSetup, openSetup } from "./setup-store";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

// ---- account ----------------------------------------------------------------------------------

export function useAccountFlow(): SetupFlow {
    const me = useMe();
    const { ws, workspace, can } = useWorkspace();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const finish = async () => {
        await tutorialApi.update({ setup: "done" });
        await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    };
    const steps: SetupStep[] = [
        {
            id: "notifications",
            title: "Notifications",
            need: "recommended",
            done: null,
            body: (
                <>
                    <p className="text-sm">
                        Which finished reviews you hear about. You can change this any time in Settings → Notifications.
                    </p>
                    <NotificationsForm />
                </>
            ),
        },
        {
            id: "appearance",
            title: "Appearance",
            need: "optional",
            done: null,
            body: <AppearanceSections />,
        },
        {
            id: "workspace",
            title: "Your workspace",
            need: "recommended",
            done: null,
            body: (
                <div className="grid gap-form">
                    <p className="text-sm">
                        Reviews happen in a workspace: its projects, its model key, its people. You have{" "}
                        {workspace.kind === "personal" ? "a personal one" : <strong>{workspace.name}</strong>} already.
                    </p>
                    {can("configure") && (
                        <div>
                            <Button
                                type="button"
                                onClick={async () => {
                                    await finish();
                                    openSetup({ kind: "workspace", ws });
                                }}
                            >
                                Set up {workspace.kind === "personal" ? "my personal workspace" : workspace.name}
                            </Button>
                        </div>
                    )}
                    <div className="grid gap-2 rounded-lg border p-inset">
                        <h4 className="text-sm font-medium">Or create an organisation</h4>
                        <p className="text-xs text-muted-foreground">A workspace to share with others: you'll be its owner.</p>
                        <CreateOrganisationForm
                            onCreated={async (w) => {
                                await finish();
                                await navigate({ to: "/w/$ws", params: { ws: w.slug } });
                                openSetup({ kind: "workspace", ws: w.slug });
                            }}
                        />
                    </div>
                </div>
            ),
        },
    ];
    return {
        title: `Welcome to Triagent, ${me.user.displayName}`,
        description: "A few choices for your account, then your workspace. Each is saved as you go; you can come back to them in Settings.",
        steps,
        loading: false,
        finishLabel: "Finish",
        onFinish: finish,
    };
}

/** Whether reviews can run with the workspace's models as they are, in a sentence. */
function modelStatus(model: ReviewModel, allowance: Allowance | undefined): string {
    if (model.ready) {
        const provider = model.providers.find((p) => p.id === model.provider)?.name ?? model.provider;
        return `Ready: reviews use ${model.model} through ${provider}.`;
    }
    if (allowance?.now.ready) return `Ready: reviews use ${allowance.now.model} through the instance's key.`;
    if (model.favourites.length) return `Not ready yet: add ${model.missing ?? "an API key"}.`;
    return "Not ready yet: connect a provider and choose a model.";
}

// ---- workspace --------------------------------------------------------------------------------

export function useWorkspaceFlow(): SetupFlow {
    const me = useMe();
    const { ws, workspace, can } = useWorkspace();
    const navigate = useNavigate();
    const model = useQuery(reviewModelQuery(ws));
    const allowance = useQuery(allowanceQuery(ws));
    const projects = useQuery(projectsQuery(ws));
    const personal = workspace.kind === "personal";
    const members = useQuery({ ...membersQuery(ws), enabled: !personal && can("members") });
    const modelReady = Boolean(model.data?.ready || allowance.data?.now.ready);
    const own = (projects.data ?? []).filter((p) => !isExample(me, ws, p.slug));

    const steps: SetupStep[] = [
        {
            id: "model",
            title: "Models",
            need: "required",
            done: modelReady,
            body: model.data ? (
                <>
                    <p className="text-sm">
                        Open Code Review asks a model to review the code. Connect a provider with its API key (stored encrypted and never
                        shown again), then choose one of its models: the first is the default that reviews use. More models, from any
                        provider, can be added now or later in Settings → Models.
                    </p>
                    <StatusNote data-testid="setup-model-status">{modelStatus(model.data, allowance.data)}</StatusNote>
                    <ModelLibrary data={model.data} setup />
                </>
            ) : (
                <p className="text-sm text-muted-foreground">Loading…</p>
            ),
        },
        ...(!personal && can("members")
            ? [
                  {
                      id: "people",
                      title: "People",
                      need: "recommended" as const,
                      done: (members.data?.length ?? 0) > 1,
                      body: (
                          <>
                              <p className="text-sm">
                                  Who else works in {workspace.name}. Admins can change settings and start reviews; editors triage; viewers
                                  read.
                              </p>
                              <AddPeople />
                          </>
                      ),
                  },
              ]
            : []),
        {
            id: "project",
            title: "First project",
            need: "required",
            done: own.length > 0,
            body: (
                <>
                    <p className="text-sm">One project per codebase: its repository, reviews and findings. Setting it up comes next.</p>
                    {own.length > 0 && (
                        <ul className="grid gap-1 text-sm">
                            {own.map((p) => (
                                <li key={p.slug} className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium">{p.name}</span>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={async () => {
                                            await navigate({ to: "/w/$ws/p/$project/overview", params: { ws, project: p.slug } });
                                            openSetup({ kind: "project", ws, project: p.slug });
                                        }}
                                    >
                                        Set up {p.name}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <CreateProjectForm
                        onCreated={async (p: Project) => {
                            await navigate({ to: "/w/$ws/p/$project/overview", params: { ws, project: p.slug } });
                            openSetup({ kind: "project", ws, project: p.slug });
                        }}
                    />
                </>
            ),
        },
    ];
    return {
        title: `Set up ${workspace.name}`,
        description: "What this workspace needs before reviews can run. Each step is saved as you go; it's all in Settings too.",
        steps,
        loading: model.isPending || projects.isPending || allowance.isPending,
    };
}

// ---- project ----------------------------------------------------------------------------------

/** The repository and default branch: all a project needs to know where its code is. */
function RepositoryForm({ project }: { project: Project }) {
    const { ws, slug } = useProject();
    const queryClient = useQueryClient();
    const [repoUrl, setRepoUrl] = useState(project.repoUrl ?? "");
    const [branch, setBranch] = useState(project.defaultBranch);
    const save = useMutation({
        mutationFn: () =>
            api.patch<Project>(`${paths.project(ws, slug)}/settings/general`, {
                repoUrl: repoUrl.trim() || null,
                defaultBranch: branch.trim(),
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: keys.project(ws, slug) });
            void queryClient.invalidateQueries({ queryKey: keys.projectSettings(ws, slug, "general") });
            void queryClient.invalidateQueries({ queryKey: keys.projectSettings(ws, slug, "github") });
            toast.success("Repository saved.");
        },
    });
    const changed = repoUrl.trim() !== (project.repoUrl ?? "") || branch.trim() !== project.defaultBranch;
    return (
        <form
            className="grid gap-form"
            onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
            }}
        >
            <Field label="Repository URL" hint="The GitHub repository, e.g. https://github.com/acme/app.">
                {(p) => <Input {...p} type="url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} maxLength={300} />}
            </Field>
            <Field label="Default branch" hint="Pages open on this branch, and other branches are compared with it." width="md">
                {(p) => (
                    <Input
                        {...p}
                        value={branch}
                        onChange={(e) => setBranch(e.target.value)}
                        maxLength={200}
                        className="font-mono"
                        required
                    />
                )}
            </Field>
            <FieldError message={save.error ? errorMessage(save.error) : null} />
            <FormActions>
                <Button type="submit" disabled={save.isPending || !changed || !branch.trim()}>
                    {save.isPending ? "Saving…" : "Save"}
                </Button>
            </FormActions>
        </form>
    );
}

/** The automatic-review settings worth deciding at the start; the rest stay in Automation settings. */
function AutomationEssentials({ automation }: { automation: Automation }) {
    const { ws, slug } = useProject();
    const queryClient = useQueryClient();
    const [d, setD] = useState({
        enabled: automation.enabled,
        failOnCritical: automation.failOnCritical,
        nightlyHourUtc: automation.nightlyHourUtc === null ? "" : String(automation.nightlyHourUtc),
    });
    const save = useMutation({
        mutationFn: () =>
            api.patch<Automation>(`${paths.project(ws, slug)}/settings/automation`, {
                enabled: d.enabled,
                failOnCritical: d.failOnCritical,
                nightlyHourUtc: d.nightlyHourUtc === "" ? null : Number(d.nightlyHourUtc),
            }),
        onSuccess: (a) => {
            queryClient.setQueryData(keys.projectSettings(ws, slug, "automation"), a);
            toast.success("Automatic reviews saved.");
        },
    });
    const changed =
        d.enabled !== automation.enabled ||
        d.failOnCritical !== automation.failOnCritical ||
        d.nightlyHourUtc !== (automation.nightlyHourUtc === null ? "" : String(automation.nightlyHourUtc));
    return (
        <form
            className="grid gap-form"
            onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
            }}
        >
            <CheckField
                label="Review pull requests automatically"
                hint="New pull requests, and new pushes to them, are reviewed and summarised in a comment."
            >
                {(p) => <Switch {...p} checked={d.enabled} onCheckedChange={(enabled) => setD({ ...d, enabled })} />}
            </CheckField>
            <CheckField
                label="Fail the check when a review finds something critical"
                hint="The pull request's commit status fails, so branch protection can block the merge."
            >
                {(p) => <Switch {...p} checked={d.failOnCritical} onCheckedChange={(failOnCritical) => setD({ ...d, failOnCritical })} />}
            </CheckField>
            <Field
                label="Nightly full scan of the default branch"
                hint="The hour it starts, in UTC. A whole-branch review uses more of the model."
                width="sm"
            >
                {(p) => (
                    <NativeSelect {...p} value={d.nightlyHourUtc} onChange={(e) => setD({ ...d, nightlyHourUtc: e.target.value })}>
                        <option value="">None</option>
                        {HOURS.map((h) => (
                            <option key={h} value={String(h)}>
                                {`${String(h).padStart(2, "0")}:00 UTC`}
                            </option>
                        ))}
                    </NativeSelect>
                )}
            </Field>
            <FieldError message={save.error ? errorMessage(save.error) : null} />
            <FormActions>
                <Button type="submit" disabled={save.isPending || !changed}>
                    {save.isPending ? "Saving…" : "Save"}
                </Button>
            </FormActions>
        </form>
    );
}

export function useProjectFlow(): SetupFlow {
    const { ws, slug, project } = useProject();
    const { workspace } = useWorkspace();
    const github = useQuery(githubQuery(ws, slug));
    const model = useQuery(reviewModelQuery(ws));
    const allowance = useQuery(allowanceQuery(ws));
    const modelReady = Boolean(model.data?.ready || allowance.data?.now.ready);
    const automation = useQuery(automationQuery(ws, slug));
    const g = github.data;
    const connected = Boolean(g && g.mode !== "none");
    const app = g?.app.available === true;

    const steps: SetupStep[] = [
        {
            id: "repository",
            title: "Repository",
            need: "required",
            done: Boolean(project.repoUrl),
            body: (
                <>
                    <p className="text-sm">
                        Where {project.name}'s code is.
                        {app && " With the GitHub App, choosing the repository in the next step fills this in."}
                    </p>
                    <RepositoryForm key={`${project.repoUrl}|${project.defaultBranch}`} project={project} />
                </>
            ),
        },
        {
            id: "github",
            title: "Connect GitHub",
            need: "required",
            done: connected,
            body: g ? (
                <>
                    <p className="text-sm">
                        Reviews fetch the code from GitHub, and post their results on pull requests.{" "}
                        {app
                            ? `Install the ${g.app.available ? g.app.name : "GitHub"} app on the repository's account and choose the repository, or use a fine-grained access token instead.`
                            : "Give Triagent a fine-grained access token for the repository."}
                    </p>
                    {app ? (
                        <>
                            <GithubAppConnection data={g} setup />
                            <details className="rounded-lg border">
                                <summary className="cursor-pointer px-inset py-2 text-sm font-medium">Use an access token instead</summary>
                                <div className="grid gap-form p-inset pt-0">
                                    <GithubTokenSection data={g} />
                                </div>
                            </details>
                        </>
                    ) : (
                        <GithubTokenSection data={g} />
                    )}
                    {connected && <TestConnection data={g} />}
                </>
            ) : (
                <p className="text-sm text-muted-foreground">Loading…</p>
            ),
        },
        // The GitHub App has its own webhook; a token needs one set up by hand.
        ...(g && g.mode !== "app"
            ? [
                  {
                      id: "webhook",
                      title: "GitHub webhook",
                      need: "recommended" as const,
                      done: g.webhook.secretSet,
                      body: (
                          <>
                              <p className="text-sm">
                                  Without one, Triagent checks GitHub for new pull requests every few minutes; with one, GitHub tells it
                                  straight away.
                              </p>
                              <WebhookSection data={g} />
                          </>
                      ),
                  },
              ]
            : []),
        {
            id: "automation",
            title: "Automatic reviews",
            need: "recommended",
            done: automation.data ? automation.data.enabled : false,
            body: automation.data ? (
                <>
                    <p className="text-sm">
                        When reviews run without anyone starting them. Time limits, token budgets and reviewing with several models are in{" "}
                        <Link
                            to="/w/$ws/p/$project/settings/automation"
                            params={{ ws, project: slug }}
                            className="underline"
                            onClick={() => closeSetup()}
                        >
                            Automation settings
                        </Link>
                        .
                    </p>
                    <AutomationEssentials key={JSON.stringify(automation.data)} automation={automation.data} />
                </>
            ) : (
                <p className="text-sm text-muted-foreground">Loading…</p>
            ),
        },
        {
            id: "ready",
            title: "First review",
            need: "optional",
            done: null,
            body: (
                <>
                    <p className="text-sm">
                        {connected
                            ? `${project.name} is ready. Start a review to see its findings here, or wait for the next pull request.`
                            : `${project.name} needs GitHub before reviews can run. You can still upload a report Open Code Review wrote elsewhere, on Branches & reports.`}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {connected && (
                            <Button asChild>
                                <Link to="/w/$ws/p/$project/start-review" params={{ ws, project: slug }} onClick={() => closeSetup()}>
                                    <Play /> Start your first review
                                </Link>
                            </Button>
                        )}
                        <Button asChild variant="outline">
                            <Link to="/w/$ws/p/$project/branches" params={{ ws, project: slug }} onClick={() => closeSetup()}>
                                Upload a report
                            </Link>
                        </Button>
                    </div>
                    {model.data && !modelReady && (
                        <div className="grid gap-2 rounded-lg border p-inset">
                            <p className="text-sm">
                                Reviews also need a model key for {workspace.name}, which it doesn't have yet. It's part of the workspace's
                                setup.
                            </p>
                            <div>
                                <Button type="button" variant="outline" onClick={() => openSetup({ kind: "workspace", ws }, "model")}>
                                    Set up {workspace.name}'s model
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            ),
        },
    ];
    return {
        title: `Set up ${project.name}`,
        description: "Where its code is, how Triagent reaches GitHub, and when reviews run. Each step is saved as you go.",
        steps,
        loading: github.isPending || automation.isPending,
    };
}
