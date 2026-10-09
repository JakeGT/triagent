// Every page and its URL. Pages are loaded on demand. Search parameters are plain strings in the URL
// (?severity=high,critical), not JSON, so links stay readable and shareable.

import type { QueryClient } from "@tanstack/react-query";
import {
    createRootRouteWithContext,
    createRoute,
    createRouter,
    lazyRouteComponent,
    notFound,
    type RouteComponent,
    redirect,
} from "@tanstack/react-router";
import { AuthedLayout } from "@/components/layout/authed-layout";
import { RouteError } from "@/components/load-state";
import { NotFoundPage } from "@/components/not-found";
import { RootLayout } from "@/components/root-layout";
import { parseAnalyticsSearch } from "@/features/analytics/search";
import type { SignInError } from "@/features/auth/sign-in-page";
import { parseIssueSearch } from "@/features/issues/search";
import { isApiError, setCsrfToken } from "@/lib/api";
import { PREF, prefs } from "@/lib/prefs";
import { meQuery } from "@/lib/queries";
import { parseSearch, stringifySearch } from "@/lib/search-params";
import type { Me } from "@/lib/types";

export interface RouterContext {
    queryClient: QueryClient;
}

declare module "@tanstack/react-router" {
    interface StaticDataRouteOption {
        /** Pages about one branch: the rail shows the branch picker. */
        branchScoped?: boolean;
    }
}

const SIGN_IN_ERRORS: readonly SignInError[] = ["expired", "denied", "failed", "unavailable"];

const str = (v: unknown, max = 200) => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, max) || undefined : undefined);

async function loadMe(queryClient: QueryClient, href: string): Promise<Me> {
    try {
        // Cached while fresh; fetched again once stale or invalidated (after a password change, a new organisation).
        const me = await queryClient.fetchQuery(meQuery);
        setCsrfToken(me.csrf);
        return me;
    } catch (err) {
        if (isApiError(err, 401)) throw redirect({ to: "/sign-in", search: { redirect: href } });
        throw err;
    }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: RootLayout,
    notFoundComponent: NotFoundPage,
    errorComponent: RouteError,
});

const signInRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sign-in",
    validateSearch: (s: Record<string, unknown>): { redirect?: string; error?: SignInError } => {
        const r = str(s.redirect, 2000);
        const error = SIGN_IN_ERRORS.find((e) => e === s.error);
        // Only paths on this site: never an absolute URL someone put in a link.
        return { ...(r?.startsWith("/") && !r.startsWith("//") ? { redirect: r } : {}), ...(error ? { error } : {}) };
    },
    component: lazyRouteComponent(() => import("@/features/auth/sign-in-page"), "SignInPage"),
});

/** Signed in at the identity provider, but no account here and no invite. */
const inviteRequiredRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/invite-required",
    component: lazyRouteComponent(() => import("@/features/auth/invite-required-page"), "InviteRequiredPage"),
});

/** The confirm-it's-you window comes back here (components/reauth-dialog.tsx). */
const reauthenticatedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/reauthenticated",
    component: lazyRouteComponent(() => import("@/features/auth/reauthenticated-page"), "ReauthenticatedPage"),
});

const changePasswordRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/change-password",
    beforeLoad: async ({ context, location }) => {
        const me = await loadMe(context.queryClient, location.href);
        if (!me.mustChangePassword) throw redirect({ to: "/" });
    },
    component: lazyRouteComponent(() => import("@/features/auth/change-password-page"), "ChangePasswordPage"),
});

/** Everything below needs a signed-in person who has set their own password. */
const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    beforeLoad: async ({ context, location }) => {
        const me = await loadMe(context.queryClient, location.href);
        if (me.mustChangePassword) throw redirect({ to: "/change-password" });
        return { me };
    },
    component: AuthedLayout,
});

const homeRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/",
    beforeLoad: ({ context }) => {
        const { workspaces } = context.me;
        const last = prefs.get(PREF.lastWorkspace);
        const target = workspaces.find((w) => w.slug === last) ?? workspaces.find((w) => w.kind === "personal") ?? workspaces[0];
        if (!target) throw notFound();
        throw redirect({ to: "/w/$ws", params: { ws: target.slug } });
    },
});

const wsRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/w/$ws",
    beforeLoad: ({ context, params }) => {
        const workspace = context.me.workspaces.find((w) => w.slug === params.ws);
        if (!workspace) throw notFound();
        prefs.set(PREF.lastWorkspace, workspace.slug);
        return { workspace };
    },
    component: lazyRouteComponent(() => import("@/components/layout/app-shell"), "AppShell"),
});

const wsIndexRoute = createRoute({
    getParentRoute: () => wsRoute,
    path: "/",
    component: lazyRouteComponent(() => import("@/features/projects/workspace-home"), "WorkspaceHome"),
});

const agentsRoute = createRoute({
    getParentRoute: () => wsRoute,
    path: "/agents",
    validateSearch: (s: Record<string, unknown>): { project?: string } => (str(s.project, 40) ? { project: str(s.project, 40) } : {}),
    component: lazyRouteComponent(() => import("@/features/agents/agents-page"), "AgentsPage"),
});

const analyticsRoute = createRoute({
    getParentRoute: () => wsRoute,
    path: "/analytics",
    validateSearch: parseAnalyticsSearch,
    component: lazyRouteComponent(() => import("@/features/analytics/analytics-page"), "AnalyticsPage"),
});

// ---- settings: workspace, instance and account ---------------------------------------------------

const wsSettingsRoute = createRoute({
    getParentRoute: () => wsRoute,
    path: "/settings",
    component: lazyRouteComponent(() => import("@/features/settings/settings-layout"), "SettingsLayout"),
});

function settingsPage<const P extends string>(path: P, component: RouteComponent) {
    return createRoute({ getParentRoute: () => wsSettingsRoute, path, component });
}

const wsSettingsIndexRoute = createRoute({
    getParentRoute: () => wsSettingsRoute,
    path: "/",
    beforeLoad: ({ params }) => {
        throw redirect({ to: "/w/$ws/settings/projects", params: { ws: params.ws } });
    },
});

const wsSettingsRoutes = [
    settingsPage(
        "/github-app",
        lazyRouteComponent(() => import("@/features/settings/github-app-settings"), "GithubAppSettings"),
    ),
    settingsPage(
        "/projects",
        lazyRouteComponent(() => import("@/features/settings/projects-settings"), "ProjectsSettings"),
    ),
    settingsPage(
        "/review-model",
        lazyRouteComponent(() => import("@/features/settings/review-model-settings"), "ReviewModelSettings"),
    ),
    settingsPage(
        "/model-prices",
        lazyRouteComponent(() => import("@/features/settings/model-prices-settings"), "ModelPricesSettings"),
    ),
    settingsPage(
        "/instance-model",
        lazyRouteComponent(() => import("@/features/settings/instance-model-settings"), "InstanceModelSettings"),
    ),
    settingsPage(
        "/instance-workspaces",
        lazyRouteComponent(() => import("@/features/settings/instance-workspaces-settings"), "InstanceWorkspacesSettings"),
    ),
    settingsPage(
        "/members",
        lazyRouteComponent(() => import("@/features/settings/members-settings"), "MembersSettings"),
    ),
    settingsPage(
        "/tokens",
        lazyRouteComponent(() => import("@/features/settings/tokens-settings"), "TokensSettings"),
    ),
    settingsPage(
        "/audit",
        lazyRouteComponent(() => import("@/features/settings/audit-settings"), "AuditSettings"),
    ),
    settingsPage(
        "/users",
        lazyRouteComponent(() => import("@/features/settings/users-settings"), "UsersSettings"),
    ),
    settingsPage(
        "/notifications",
        lazyRouteComponent(() => import("@/features/settings/notifications-settings"), "NotificationsSettings"),
    ),
    settingsPage(
        "/password",
        lazyRouteComponent(() => import("@/features/settings/password-settings"), "PasswordSettings"),
    ),
    settingsPage(
        "/tutorial",
        lazyRouteComponent(() => import("@/features/settings/tutorial-settings"), "TutorialSettings"),
    ),
    settingsPage(
        "/appearance",
        lazyRouteComponent(() => import("@/features/settings/appearance-settings"), "AppearanceSettings"),
    ),
];

// ---- one project ---------------------------------------------------------------------------------

const projectRoute = createRoute({
    getParentRoute: () => wsRoute,
    path: "/p/$project",
    validateSearch: (s: Record<string, unknown>): { branch?: string } => (str(s.branch) ? { branch: str(s.branch) } : {}),
    beforeLoad: ({ params }) => prefs.set(PREF.lastProject(params.ws), params.project),
    component: lazyRouteComponent(() => import("@/features/projects/project-layout"), "ProjectLayout"),
});

const projectIndexRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/",
    beforeLoad: ({ params, search }) => {
        throw redirect({ to: "/w/$ws/p/$project/overview", params, search });
    },
});

const overviewRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/overview",
    staticData: { branchScoped: true },
    component: lazyRouteComponent(() => import("@/features/overview/overview-page"), "OverviewPage"),
});

const issuesRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/issues",
    staticData: { branchScoped: true },
    validateSearch: parseIssueSearch,
    component: lazyRouteComponent(() => import("@/features/issues/issues-page"), "IssuesPage"),
});

const issueRoute = createRoute({
    getParentRoute: () => issuesRoute,
    path: "/$issueId",
    staticData: { branchScoped: true },
    // A fresh panel for each issue (and branch), so a half-typed note or edit never carries over to another.
    remountDeps: ({ params, search }) => `${params.issueId}\n${(search as { branch?: string }).branch ?? ""}`,
    component: lazyRouteComponent(() => import("@/features/issues/issue-panel"), "IssuePanel"),
});

const tasksRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/tasks",
    staticData: { branchScoped: true },
    validateSearch: (s: Record<string, unknown>): { tab?: "summary" } => (s.tab === "summary" ? { tab: "summary" } : {}),
    component: lazyRouteComponent(() => import("@/features/tasks/tasks-page"), "TasksPage"),
});

const taskRoute = createRoute({
    getParentRoute: () => tasksRoute,
    path: "/$taskId",
    staticData: { branchScoped: true },
    remountDeps: ({ params, search }) => `${params.taskId}\n${(search as { branch?: string }).branch ?? ""}`,
    component: lazyRouteComponent(() => import("@/features/tasks/task-panel"), "TaskPanel"),
});

const filesRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/files",
    staticData: { branchScoped: true },
    component: lazyRouteComponent(() => import("@/features/files/files-page"), "FilesPage"),
});

const branchesRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/branches",
    component: lazyRouteComponent(() => import("@/features/branches/branches-page"), "BranchesPage"),
});

const compareRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/compare",
    validateSearch: (s: Record<string, unknown>): { base?: string; head?: string } => ({
        ...(str(s.base) ? { base: str(s.base) } : {}),
        ...(str(s.head) ? { head: str(s.head) } : {}),
    }),
    component: lazyRouteComponent(() => import("@/features/compare/compare-page"), "ComparePage"),
});

const runsRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/runs",
    validateSearch: (s: Record<string, unknown>): { all?: "1" } => (s.all === "1" || s.all === 1 ? { all: "1" } : {}),
    component: lazyRouteComponent(() => import("@/features/runs/runs-page"), "RunsPage"),
});

const runRoute = createRoute({
    getParentRoute: () => runsRoute,
    path: "/$runId",
    component: lazyRouteComponent(() => import("@/features/runs/run-panel"), "RunPanel"),
});

/** What a link to Start a review can choose already: ?kind=pr&number=12, ?kind=changes&branch=x&base=main. */
type StartReviewSearch = { kind?: "pr" | "changes" | "full"; number?: number; branch?: string; base?: string };

const startReviewRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/start-review",
    validateSearch: (s: Record<string, unknown>): StartReviewSearch => {
        const kind = s.kind === "pr" || s.kind === "changes" || s.kind === "full" ? s.kind : undefined;
        const number = Number(s.number);
        return {
            ...(kind ? { kind } : {}),
            ...(Number.isInteger(number) && number > 0 ? { number } : {}),
            ...(str(s.branch) ? { branch: str(s.branch) } : {}),
            ...(str(s.base) ? { base: str(s.base) } : {}),
        };
    },
    component: lazyRouteComponent(() => import("@/features/runs/start-review-page"), "StartReviewPage"),
});

const pullRequestsRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/pull-requests",
    component: lazyRouteComponent(() => import("@/features/runs/pull-requests-page"), "PullRequestsPage"),
});

const activityRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/activity",
    component: lazyRouteComponent(() => import("@/features/activity/activity-page"), "ActivityPage"),
});

// ---- settings: one project -----------------------------------------------------------------------

const projectSettingsRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/settings",
    component: lazyRouteComponent(() => import("@/features/settings/settings-layout"), "SettingsLayout"),
});

const projectSettingsIndexRoute = createRoute({
    getParentRoute: () => projectSettingsRoute,
    path: "/",
    beforeLoad: ({ params }) => {
        throw redirect({ to: "/w/$ws/p/$project/settings/general", params });
    },
});

function projectSettingsPage<const P extends string>(path: P, component: RouteComponent) {
    return createRoute({ getParentRoute: () => projectSettingsRoute, path, component });
}

const projectSettingsRoutes = [
    projectSettingsPage(
        "/general",
        lazyRouteComponent(() => import("@/features/settings/project-general"), "ProjectGeneral"),
    ),
    projectSettingsPage(
        "/automation",
        lazyRouteComponent(() => import("@/features/settings/project-automation"), "ProjectAutomation"),
    ),
    projectSettingsPage(
        "/github",
        lazyRouteComponent(() => import("@/features/settings/project-github"), "ProjectGithub"),
    ),
];

const routeTree = rootRoute.addChildren([
    signInRoute,
    inviteRequiredRoute,
    reauthenticatedRoute,
    changePasswordRoute,
    authedRoute.addChildren([
        homeRoute,
        wsRoute.addChildren([
            wsIndexRoute,
            agentsRoute,
            analyticsRoute,
            wsSettingsRoute.addChildren([wsSettingsIndexRoute, ...wsSettingsRoutes]),
            projectRoute.addChildren([
                projectIndexRoute,
                overviewRoute,
                issuesRoute.addChildren([issueRoute]),
                tasksRoute.addChildren([taskRoute]),
                filesRoute,
                branchesRoute,
                compareRoute,
                activityRoute,
                runsRoute.addChildren([runRoute]),
                startReviewRoute,
                pullRequestsRoute,
                projectSettingsRoute.addChildren([projectSettingsIndexRoute, ...projectSettingsRoutes]),
            ]),
        ]),
    ]),
]);

export function createAppRouter(queryClient: QueryClient) {
    return createRouter({
        routeTree,
        context: { queryClient },
        parseSearch,
        stringifySearch,
        defaultPreload: "intent",
        defaultPreloadStaleTime: 0,
        scrollRestoration: true,
    });
}

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof createAppRouter>;
    }
}
