// Query keys and query options for every read. Keys nest workspace → project → branch, so a live
// update can invalidate exactly the part of the cache it touches.

import { queryOptions } from "@tanstack/react-query";
import { api, paths } from "./api";
import type {
    ApiToken,
    AuditRow,
    AuthConfig,
    Automation,
    Branches,
    Comparison,
    FileList,
    GithubAppStatus,
    GithubSettings,
    History,
    InstallationWithRepos,
    InstanceUser,
    IssueDetail,
    IssueList,
    Me,
    Member,
    ModelChoices,
    ModelComparison,
    Overview,
    Project,
    ProjectListItem,
    PullRequests,
    ReviewModel,
    RunList,
    Summary,
    TaskDetail,
    TaskList,
    WorkspaceDetail,
    WorkspaceGithub,
} from "./types";

export const keys = {
    me: ["me"] as const,
    authConfig: ["auth-config"] as const,
    instanceUsers: ["instance", "users"] as const,
    instanceInvites: ["instance", "invites"] as const,
    ws: (ws: string) => ["ws", ws] as const,
    projects: (ws: string) => ["ws", ws, "projects"] as const,
    wsSettings: (ws: string, what: string) => ["ws", ws, "settings", what] as const,
    project: (ws: string, p: string) => ["ws", ws, "p", p] as const,
    branches: (ws: string, p: string) => ["ws", ws, "p", p, "branches"] as const,
    projectSettings: (ws: string, p: string, what: string) => ["ws", ws, "p", p, "settings", what] as const,
    activity: (ws: string, p: string, branch: string) => ["ws", ws, "p", p, "activity", branch] as const,
    compare: (ws: string, p: string, base: string, head: string) => ["ws", ws, "p", p, "compare", base, head] as const,
    history: (ws: string, p: string, branch: string) => ["ws", ws, "p", p, "history", branch] as const,
    branch: (ws: string, p: string, branch: string) => ["ws", ws, "p", p, "b", branch] as const,
    issues: (ws: string, p: string, branch: string, filters: object) => ["ws", ws, "p", p, "b", branch, "issues", filters] as const,
    issue: (ws: string, p: string, branch: string, id: string) => ["ws", ws, "p", p, "b", branch, "issue", id] as const,
    overview: (ws: string, p: string, branch: string) => ["ws", ws, "p", p, "b", branch, "overview"] as const,
    tasks: (ws: string, p: string, branch: string) => ["ws", ws, "p", p, "b", branch, "tasks"] as const,
    task: (ws: string, p: string, branch: string, id: string) => ["ws", ws, "p", p, "b", branch, "task", id] as const,
    files: (ws: string, p: string, branch: string) => ["ws", ws, "p", p, "b", branch, "files"] as const,
    summary: (ws: string, p: string, branch: string) => ["ws", ws, "p", p, "b", branch, "summary"] as const,
    /** Every run query in a workspace: live run notices invalidate only these (and pull requests). */
    runs: (ws: string) => ["ws", ws, "runs"] as const,
    runList: (ws: string, project: string | null) => ["ws", ws, "runs", "list", project ?? ""] as const,
    run: (ws: string, id: string) => ["ws", ws, "runs", "one", id] as const,
    pullRequests: (ws: string, p: string) => ["ws", ws, "p", p, "pull-requests"] as const,
    /** What reviews can run with, for the workspace and for each project: favourites and projects' settings both change it. */
    models: (ws: string) => ["ws", ws, "models"] as const,
    modelChoices: (ws: string, p: string | null) => ["ws", ws, "models", p ?? ""] as const,
    installations: (ws: string) => ["ws", ws, "settings", "github-installations"] as const,
    githubApp: ["instance", "github-app"] as const,
    instanceReviews: ["instance", "reviews"] as const,
};

export const meQuery = queryOptions({
    queryKey: keys.me,
    queryFn: ({ signal }) => api.get<Me>(paths.me, undefined, { signal, quiet401: true }),
    staleTime: 60_000,
    retry: false,
});

/** How people sign in: public, and fixed while the server runs. */
export const authConfigQuery = queryOptions({
    queryKey: keys.authConfig,
    queryFn: ({ signal }) => api.get<AuthConfig>(paths.authConfig, undefined, { signal, quiet401: true }),
    staleTime: Number.POSITIVE_INFINITY,
});

export const workspaceQuery = (ws: string) =>
    queryOptions({ queryKey: keys.ws(ws), queryFn: ({ signal }) => api.get<WorkspaceDetail>(paths.workspace(ws), undefined, { signal }) });

export const projectsQuery = (ws: string) =>
    queryOptions({
        queryKey: keys.projects(ws),
        queryFn: ({ signal }) => api.get<{ items: ProjectListItem[] }>(`${paths.workspace(ws)}/projects`, undefined, { signal }),
        select: (d) => d.items,
    });

export const projectQuery = (ws: string, p: string) =>
    queryOptions({ queryKey: keys.project(ws, p), queryFn: ({ signal }) => api.get<Project>(paths.project(ws, p), undefined, { signal }) });

export const branchesQuery = (ws: string, p: string) =>
    queryOptions({
        queryKey: keys.branches(ws, p),
        queryFn: ({ signal }) => api.get<Branches>(`${paths.project(ws, p)}/branches`, undefined, { signal }),
    });

export const overviewQuery = (ws: string, p: string, branch: string) =>
    queryOptions({
        queryKey: keys.overview(ws, p, branch),
        queryFn: ({ signal }) => api.get<Overview>(`${paths.project(ws, p)}/overview`, { branch }, { signal }),
    });

export const issuesQuery = (ws: string, p: string, branch: string, query: Record<string, string | undefined>) =>
    queryOptions({
        queryKey: keys.issues(ws, p, branch, query),
        queryFn: ({ signal }) => api.get<IssueList>(`${paths.project(ws, p)}/issues`, { branch, ...query }, { signal }),
        placeholderData: (previous) => previous,
    });

export const issueQuery = (ws: string, p: string, branch: string, id: string) =>
    queryOptions({
        queryKey: keys.issue(ws, p, branch, id),
        queryFn: ({ signal }) => api.get<IssueDetail>(`${paths.project(ws, p)}/issues/${encodeURIComponent(id)}`, { branch }, { signal }),
    });

export const tasksQuery = (ws: string, p: string, branch: string) =>
    queryOptions({
        queryKey: keys.tasks(ws, p, branch),
        queryFn: ({ signal }) => api.get<TaskList>(`${paths.project(ws, p)}/tasks`, { branch }, { signal }),
    });

export const taskQuery = (ws: string, p: string, branch: string, id: string) =>
    queryOptions({
        queryKey: keys.task(ws, p, branch, id),
        queryFn: ({ signal }) => api.get<TaskDetail>(`${paths.project(ws, p)}/tasks/${encodeURIComponent(id)}`, { branch }, { signal }),
    });

export const filesQuery = (ws: string, p: string, branch: string) =>
    queryOptions({
        queryKey: keys.files(ws, p, branch),
        queryFn: ({ signal }) => api.get<FileList>(`${paths.project(ws, p)}/files`, { branch }, { signal }),
    });

export const summaryQuery = (ws: string, p: string, branch: string) =>
    queryOptions({
        queryKey: keys.summary(ws, p, branch),
        queryFn: ({ signal }) => api.get<Summary>(`${paths.project(ws, p)}/summary`, { branch }, { signal }),
    });

export const historyQuery = (ws: string, p: string, branch: string) =>
    queryOptions({
        queryKey: keys.history(ws, p, branch),
        queryFn: ({ signal }) => api.get<History>(`${paths.project(ws, p)}/reports`, { branch }, { signal }),
    });

export const compareQuery = (ws: string, p: string, base: string, head: string) =>
    queryOptions({
        queryKey: keys.compare(ws, p, base, head),
        queryFn: ({ signal }) => api.get<Comparison>(`${paths.project(ws, p)}/compare`, { base, head }, { signal }),
    });

export const generalQuery = (ws: string, p: string) =>
    queryOptions({
        queryKey: keys.projectSettings(ws, p, "general"),
        queryFn: ({ signal }) => api.get<Project>(`${paths.project(ws, p)}/settings/general`, undefined, { signal }),
    });

export const automationQuery = (ws: string, p: string) =>
    queryOptions({
        queryKey: keys.projectSettings(ws, p, "automation"),
        queryFn: ({ signal }) => api.get<Automation>(`${paths.project(ws, p)}/settings/automation`, undefined, { signal }),
    });

export const githubQuery = (ws: string, p: string) =>
    queryOptions({
        queryKey: keys.projectSettings(ws, p, "github"),
        queryFn: ({ signal }) => api.get<GithubSettings>(`${paths.project(ws, p)}/settings/github`, undefined, { signal }),
    });

export const membersQuery = (ws: string) =>
    queryOptions({
        queryKey: keys.wsSettings(ws, "members"),
        queryFn: ({ signal }) => api.get<{ items: Member[] }>(`${paths.workspace(ws)}/settings/members`, undefined, { signal }),
        select: (d) => d.items,
    });

export const tokensQuery = (ws: string) =>
    queryOptions({
        queryKey: keys.wsSettings(ws, "tokens"),
        queryFn: ({ signal }) => api.get<{ items: ApiToken[] }>(`${paths.workspace(ws)}/settings/tokens`, undefined, { signal }),
        select: (d) => d.items,
    });

export const reviewModelQuery = (ws: string) =>
    queryOptions({
        queryKey: keys.wsSettings(ws, "review-model"),
        queryFn: ({ signal }) => api.get<ReviewModel>(`${paths.workspace(ws)}/settings/review-model`, undefined, { signal }),
    });

/** The models reviews can use, and (for a project) what each kind of review uses when a run doesn't choose. */
export const modelsQuery = (ws: string, p: string | null = null) =>
    queryOptions({
        queryKey: keys.modelChoices(ws, p),
        queryFn: ({ signal }) => api.get<ModelChoices>(`${paths.workspace(ws)}/models`, { project: p ?? undefined }, { signal }),
    });

/** The workspace's GitHub settings: how projects connect, and which GitHub server. */
export const workspaceGithubQuery = (ws: string) =>
    queryOptions({
        queryKey: keys.wsSettings(ws, "github"),
        queryFn: ({ signal }) => api.get<WorkspaceGithub>(`${paths.workspace(ws)}/settings/github`, undefined, { signal }),
    });

export const auditQuery = (ws: string) =>
    queryOptions({
        queryKey: keys.wsSettings(ws, "audit"),
        queryFn: ({ signal }) => api.get<{ items: AuditRow[] }>(`${paths.workspace(ws)}/settings/audit`, { limit: 200 }, { signal }),
        select: (d) => d.items,
    });

export const instanceUsersQuery = queryOptions({
    queryKey: keys.instanceUsers,
    queryFn: ({ signal }) => api.get<{ items: InstanceUser[] }>(paths.instanceUsers, undefined, { signal }),
    select: (d) => d.items,
});

export const runListQuery = (ws: string, project: string | null) =>
    queryOptions({
        queryKey: keys.runList(ws, project),
        queryFn: ({ signal }) => api.get<RunList>(`${paths.workspace(ws)}/runs`, { project: project ?? undefined }, { signal }),
    });

/** A comparison of models: under the run's own key, so it's fetched again when the run moves on. */
export const modelComparisonQuery = (ws: string, id: string) =>
    queryOptions({
        queryKey: [...keys.run(ws, id), "comparison"] as const,
        queryFn: ({ signal }) =>
            api.get<ModelComparison>(`${paths.workspace(ws)}/runs/${encodeURIComponent(id)}/comparison`, {}, { signal }),
        retry: false,
    });

export const pullRequestsQuery = (ws: string, p: string) =>
    queryOptions({
        queryKey: keys.pullRequests(ws, p),
        queryFn: ({ signal }) => api.get<PullRequests>(`${paths.project(ws, p)}/pull-requests`, undefined, { signal }),
    });

export const installationsQuery = (ws: string) =>
    queryOptions({
        queryKey: keys.installations(ws),
        queryFn: ({ signal }) =>
            api.get<{ items: InstallationWithRepos[] }>(`${paths.workspace(ws)}/github/installations`, undefined, { signal }),
        select: (d) => d.items,
    });

export const githubAppQuery = queryOptions({
    queryKey: keys.githubApp,
    queryFn: ({ signal }) => api.get<GithubAppStatus>("/api/v1/instance/github-app", undefined, { signal }),
});
