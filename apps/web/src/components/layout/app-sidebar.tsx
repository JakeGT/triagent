// The rail: workspace, project and branch pickers at the top, the pages of the current project grouped
// by what they're for, and Agents & API, Settings and your account at the bottom.

import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useMatches, useParams } from "@tanstack/react-router";
import {
    Activity,
    BarChart3,
    Bot,
    Bug,
    FileCode,
    FolderGit2,
    GitCompare,
    GitPullRequest,
    LayoutDashboard,
    ListChecks,
    Plus,
    ScanSearch,
    Settings,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { BranchPicker, ProjectPicker, WorkspaceSwitcher } from "@/components/layout/pickers";
import { UserMenu } from "@/components/layout/user-menu";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
    useSidebar,
} from "@/components/ui/sidebar";
import { PREF, prefs } from "@/lib/prefs";
import { overviewQuery, projectQuery, projectsQuery, runListQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";

function NavItem({
    label,
    icon,
    count,
    countLabel,
    active,
    children,
}: {
    label: string;
    icon: ReactNode;
    count?: number;
    /** Read out instead of the bare count. */
    countLabel?: string;
    active: boolean;
    /** A Link: its contents are filled in here. */
    children: (content: ReactNode) => ReactElement;
}) {
    const { setOpenMobile } = useSidebar();
    return (
        <SidebarMenuItem onClick={() => setOpenMobile(false)}>
            <SidebarMenuButton asChild isActive={active} tooltip={label}>
                {children(
                    <>
                        {icon}
                        <span>{label}</span>
                        {count !== undefined && (
                            <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                                {countLabel ? (
                                    <>
                                        <span aria-hidden="true">{count.toLocaleString("en-GB")}</span>
                                        <span className="sr-only">{countLabel}</span>
                                    </>
                                ) : (
                                    count.toLocaleString("en-GB")
                                )}
                            </span>
                        )}
                    </>,
                )}
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
    return (
        <SidebarGroup>
            <SidebarGroupLabel>{title}</SidebarGroupLabel>
            <SidebarMenu>{children}</SidebarMenu>
        </SidebarGroup>
    );
}

/** The project the rail is about: the one in the URL, or the last one used in this workspace. */
function useRailProject(ws: string): string | undefined {
    const params = useParams({ strict: false }) as { project?: string };
    const projects = useQuery(projectsQuery(ws));
    if (params.project) return params.project;
    const last = prefs.get(PREF.lastProject(ws));
    const list = projects.data ?? [];
    return list.find((p) => p.slug === last)?.slug ?? list[0]?.slug;
}

export function AppSidebar() {
    const { ws, can } = useWorkspace();
    const project = useRailProject(ws);
    const { pathname } = useLocation();
    const { branch } = useLocation({ select: (l) => l.search as { branch?: string } });
    const branchScoped = useMatches({ select: (ms) => ms.some((m) => m.staticData?.branchScoped) });

    const projectData = useQuery({ ...projectQuery(ws, project ?? ""), enabled: Boolean(project) });
    const effectiveBranch = branch ?? projectData.data?.defaultBranch;
    const overview = useQuery({
        ...overviewQuery(ws, project ?? "", effectiveBranch ?? ""),
        enabled: Boolean(project && effectiveBranch),
    });
    const totals = overview.data?.totals;
    const runs = useQuery({ ...runListQuery(ws, project ?? null), enabled: Boolean(project) });
    const active = runs.data ? runs.data.counts.running + runs.data.counts.queued : undefined;

    const base = project ? `/w/${ws}/p/${project}` : "";
    const active_ = (path: string) => Boolean(base) && (pathname === `${base}${path}` || pathname.startsWith(`${base}${path}/`));
    const params = { ws, project: project ?? "" };
    const search = branch ? { branch } : {};

    return (
        <Sidebar collapsible="icon">
            <SidebarHeader className="gap-1" data-tour="pickers">
                <WorkspaceSwitcher />
                <ProjectPicker current={project} />
                {project && branchScoped && <BranchPicker project={project} />}
            </SidebarHeader>
            <SidebarContent>
                <nav aria-label="Project">
                    {project ? (
                        <>
                            <Group title="Work">
                                <NavItem label="Overview" icon={<LayoutDashboard />} active={active_("/overview")}>
                                    {(c) => (
                                        <Link to="/w/$ws/p/$project/overview" params={params} search={search}>
                                            {c}
                                        </Link>
                                    )}
                                </NavItem>
                                <NavItem label="Issues" icon={<Bug />} count={totals?.issues} active={active_("/issues")}>
                                    {(c) => (
                                        <Link to="/w/$ws/p/$project/issues" params={params} search={search}>
                                            {c}
                                        </Link>
                                    )}
                                </NavItem>
                                <NavItem label="Tasks" icon={<ListChecks />} count={totals?.tasks} active={active_("/tasks")}>
                                    {(c) => (
                                        <Link to="/w/$ws/p/$project/tasks" params={params} search={search}>
                                            {c}
                                        </Link>
                                    )}
                                </NavItem>
                                <NavItem label="Files" icon={<FileCode />} count={totals?.files} active={active_("/files")}>
                                    {(c) => (
                                        <Link to="/w/$ws/p/$project/files" params={params} search={search}>
                                            {c}
                                        </Link>
                                    )}
                                </NavItem>
                            </Group>
                            <Group title="Reviews">
                                <NavItem
                                    label="Runs"
                                    icon={<ScanSearch />}
                                    count={active || undefined}
                                    countLabel={
                                        runs.data && active
                                            ? `${runs.data.counts.running} running, ${runs.data.counts.queued} queued`
                                            : undefined
                                    }
                                    active={active_("/runs")}
                                >
                                    {(c) => (
                                        <Link to="/w/$ws/p/$project/runs" params={params}>
                                            {c}
                                        </Link>
                                    )}
                                </NavItem>
                                <NavItem label="Pull requests" icon={<GitPullRequest />} active={active_("/pull-requests")}>
                                    {(c) => (
                                        <Link to="/w/$ws/p/$project/pull-requests" params={params}>
                                            {c}
                                        </Link>
                                    )}
                                </NavItem>
                                <NavItem label="Branches & reports" icon={<FolderGit2 />} active={active_("/branches")}>
                                    {(c) => (
                                        <Link to="/w/$ws/p/$project/branches" params={params}>
                                            {c}
                                        </Link>
                                    )}
                                </NavItem>
                                <NavItem label="Compare" icon={<GitCompare />} active={active_("/compare")}>
                                    {(c) => (
                                        <Link to="/w/$ws/p/$project/compare" params={params}>
                                            {c}
                                        </Link>
                                    )}
                                </NavItem>
                            </Group>
                            <Group title="Insights">
                                <NavItem label="Analytics" icon={<BarChart3 />} active={pathname === `/w/${ws}/analytics`}>
                                    {(c) => (
                                        <Link to="/w/$ws/analytics" params={{ ws }}>
                                            {c}
                                        </Link>
                                    )}
                                </NavItem>
                                <NavItem label="Activity" icon={<Activity />} active={active_("/activity")}>
                                    {(c) => (
                                        <Link to="/w/$ws/p/$project/activity" params={params}>
                                            {c}
                                        </Link>
                                    )}
                                </NavItem>
                            </Group>
                        </>
                    ) : (
                        <Group title="Get started">
                            {can("configure") ? (
                                <NavItem label="Create a project" icon={<Plus />} active={false}>
                                    {(c) => (
                                        <Link to="/w/$ws/settings/projects" params={{ ws }}>
                                            {c}
                                        </Link>
                                    )}
                                </NavItem>
                            ) : (
                                <p className="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                                    No projects yet. Ask an admin of this workspace to create one.
                                </p>
                            )}
                        </Group>
                    )}
                </nav>
            </SidebarContent>
            <SidebarFooter>
                <nav aria-label="Workspace">
                    <SidebarMenu>
                        <NavItem label="Agents & API" icon={<Bot />} active={pathname.startsWith(`/w/${ws}/agents`)}>
                            {(c) => (
                                <Link to="/w/$ws/agents" params={{ ws }} search={project ? { project } : {}}>
                                    {c}
                                </Link>
                            )}
                        </NavItem>
                        <NavItem label="Settings" icon={<Settings />} active={pathname.includes("/settings")}>
                            {(c) =>
                                project ? (
                                    <Link to="/w/$ws/p/$project/settings" params={params}>
                                        {c}
                                    </Link>
                                ) : (
                                    <Link to="/w/$ws/settings" params={{ ws }}>
                                        {c}
                                    </Link>
                                )
                            }
                        </NavItem>
                    </SidebarMenu>
                </nav>
                <UserMenu />
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    );
}
