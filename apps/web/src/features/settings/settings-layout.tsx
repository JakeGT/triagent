// Settings, kept apart from day-to-day work, with their own navigation: the current project, the
// workspace, the instance (for its administrators) and your own account. Links only appear for what
// your role lets you see.

import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useParams } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
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
        wsLink("/models", "Models", "/w/$ws/settings/models"),
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
        wsLink("/tutorial", "Tutorial", "/w/$ws/settings/tutorial"),
    ];

    const here = [...projectItems, ...workspaceItems, ...instanceItems, ...accountItems].find((i) => i.href === pathname)?.label;
    return (
        <div className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] content-start gap-section p-4 md:p-6">
            <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-section md:grid-cols-[12rem_minmax(0,1fr)]">
                <SettingsNav current={here} pathname={pathname}>
                    <NavGroup title="Project" note={projectName} items={projectItems} pathname={pathname} />
                    <NavGroup title="Workspace" items={workspaceItems} pathname={pathname} />
                    <NavGroup title="Instance" items={instanceItems} pathname={pathname} />
                    <NavGroup title="Account" items={accountItems} pathname={pathname} />
                </SettingsNav>
                <div className="min-w-0">
                    <Outlet />
                </div>
            </div>
        </div>
    );
}

/** Beside the page on wider screens; on a phone, folded behind a button so the page comes first. */
function SettingsNav({ current, pathname, children }: { current?: string; pathname: string; children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const listId = useId();
    // Choosing a page folds it away again.
    // biome-ignore lint/correctness/useExhaustiveDependencies: close when the page changes
    useEffect(() => setOpen(false), [pathname]);
    return (
        <nav aria-label="Settings" className="grid content-start gap-2" data-tour="settings-nav">
            <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setOpen(!open)}
                className="flex h-9 items-center justify-between gap-2 rounded-md border bg-card px-3 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden"
            >
                <span className="truncate">
                    <span className="text-muted-foreground">Settings: </span>
                    {current ?? "All settings"}
                </span>
                <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden="true" />
            </button>
            <div id={listId} className={cn("content-start gap-4 md:grid", open ? "grid" : "hidden")}>
                {children}
            </div>
        </nav>
    );
}
