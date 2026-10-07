// Query keys and query options for every read. Keys nest workspace → project → branch, so a live
// update can invalidate exactly the part of the cache it touches.

import { queryOptions } from "@tanstack/react-query";
import { api, paths } from "./api";
import type {
    ActivityRow,
    ApiToken,
    AuditRow,
    Automation,
    Branches,
    Comparison,
    FileList,
    GithubSettings,
    History,
    InstanceUser,
    IssueDetail,
    IssueList,
    Me,
    Member,
    Overview,
    Project,
    ProjectListItem,
    ReviewModel,
    Summary,
    TaskDetail,
    TaskList,
    WorkspaceDetail,
} from "./types";

export const keys = {
    me: ["me"] as const,
    instanceUsers: ["instance", "users"] as const,
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
};

export const meQuery = queryOptions({
    queryKey: keys.me,
    queryFn: ({ signal }) => api.get<Me>(paths.me, undefined, { signal, quiet401: true }),
    staleTime: 60_000,
    retry: false,
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

export const activityQuery = (ws: string, p: string, branch: string) =>
    queryOptions({
        queryKey: keys.activity(ws, p, branch),
        queryFn: ({ signal }) => api.get<{ items: ActivityRow[] }>(`${paths.project(ws, p)}/activity`, { branch, limit: 100 }, { signal }),
        select: (d) => d.items,
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
