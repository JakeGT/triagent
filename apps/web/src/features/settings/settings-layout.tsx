// Settings, kept apart from day-to-day work, with their own navigation: the current project, the
// workspace, the instance (for its administrators) and your own account. Links only appear for what
// your role lets you see.

import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PREF, prefs } from "@/lib/prefs";
import { projectsQuery } from "@/lib/queries";
import { useMe, useWorkspace } from "@/lib/session";
import { cn } from "@/lib/utils";

interface Item {
    label: string;
    href: string;
    link: ReactNode;
}

function NavGroup({ title, note, items, pathname }: { title: string; note?: string; items: Item[]; pathname: string }) {
    if (!items.length) return null;
    return (
        <div className="grid gap-1">
            <h2 className="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
            {note && <p className="truncate px-2 text-xs text-muted-foreground">{note}</p>}
            <ul className="grid gap-0.5">
                {items.map((item) => (
                    <li
                        key={item.href}
                        className={cn(
                            "rounded-md text-sm [&>a]:block [&>a]:px-2 [&>a]:py-1.5 [&>a]:hover:bg-accent",
                            pathname === item.href && "bg-accent font-medium [&>a]:hover:bg-accent",
                        )}
                    >
                        {item.link}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function SettingsLayout() {
    const me = useMe();
    const { ws, can } = useWorkspace();
    const params = useParams({ strict: false }) as { project?: string };
    const { pathname } = useLocation();
    const projects = useQuery(projectsQuery(ws));
    const list = projects.data ?? [];
    const last = prefs.get(PREF.lastProject(ws));
    const project = params.project ?? list.find((p) => p.slug === last)?.slug ?? list[0]?.slug;
    const projectName = list.find((p) => p.slug === project)?.name ?? project;
    const current = (href: string) => (pathname === href ? ("page" as const) : undefined);

    const projectItems: Item[] = [];
    if (project) {
        const base = `/w/${ws}/p/${project}/settings`;
        const p = { ws, project };
        projectItems.push(
            {
                label: "General",
                href: `${base}/general`,
                link: (
                    <Link to="/w/$ws/p/$project/settings/general" params={p} aria-current={current(`${base}/general`)}>
                        General
                    </Link>
                ),
            },
            {
                label: "Automation",
                href: `${base}/automation`,
                link: (
                    <Link to="/w/$ws/p/$project/settings/automation" params={p} aria-current={current(`${base}/automation`)}>
                        Automation
                    </Link>
                ),
            },
        );
        if (can("configure"))
            projectItems.push({
                label: "GitHub",
                href: `${base}/github`,
                link: (
                    <Link to="/w/$ws/p/$project/settings/github" params={p} aria-current={current(`${base}/github`)}>
                        GitHub
                    </Link>
                ),
            });
    }

    const wsBase = `/w/${ws}/settings`;
    const wsLink = (path: string, label: string, to: Parameters<typeof Link>[0]["to"]): Item => ({
        label,
        href: `${wsBase}${path}`,
        link: (
            <Link to={to} params={{ ws } as never} aria-current={current(`${wsBase}${path}`)}>
                {label}
            </Link>
        ),
    });
    const workspaceItems: Item[] = [
        wsLink("/projects", "Projects", "/w/$ws/settings/projects"),
        wsLink("/review-model", "Review model & keys", "/w/$ws/settings/review-model"),
        wsLink("/model-prices", "Model prices", "/w/$ws/settings/model-prices"),
        wsLink("/members", "Members", "/w/$ws/settings/members"),
        ...(can("tokens") ? [wsLink("/tokens", "API tokens", "/w/$ws/settings/tokens")] : []),
        ...(can("members") ? [wsLink("/audit", "Audit log", "/w/$ws/settings/audit")] : []),
    ];
    const instanceItems: Item[] = me.user.isInstanceAdmin
        ? [
              wsLink("/users", "Users", "/w/$ws/settings/users"),
              wsLink("/instance-model", "Instance model key", "/w/$ws/settings/instance-model"),
              wsLink("/instance-workspaces", "Workspaces", "/w/$ws/settings/instance-workspaces"),
              wsLink("/github-app", "GitHub App", "/w/$ws/settings/github-app"),
          ]
        : [];
    const accountItems: Item[] = [
        wsLink("/notifications", "Notifications", "/w/$ws/settings/notifications"),
        // With an identity provider, it looks after passwords.
        ...(me.authMode === "local" ? [wsLink("/password", "Password", "/w/$ws/settings/password")] : []),
        wsLink("/appearance", "Appearance", "/w/$ws/settings/appearance"),
    ];

    return (
        <div className="mx-auto grid w-full max-w-6xl gap-5 p-4 md:p-6">
            <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            <div className="grid gap-6 md:grid-cols-[12rem_minmax(0,1fr)]">
                <nav aria-label="Settings" className="grid content-start gap-4">
                    <NavGroup title="Project" note={projectName} items={projectItems} pathname={pathname} />
                    <NavGroup title="Workspace" items={workspaceItems} pathname={pathname} />
                    <NavGroup title="Instance" items={instanceItems} pathname={pathname} />
                    <NavGroup title="Account" items={accountItems} pathname={pathname} />
                </nav>
                <div className="min-w-0">
                    <Outlet />
                </div>
            </div>
        </div>
    );
}
