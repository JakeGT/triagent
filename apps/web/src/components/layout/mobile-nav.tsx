// On a phone the rail is a sheet, so the places people go most would be hidden behind its button. This
// bar keeps four of them in view at the bottom of the screen, and "Menu" opens the rail with the rest by
// name. From the `md` breakpoint up the rail itself is visible and this isn't shown.

import { Link, useLocation } from "@tanstack/react-router";
import { BarChart3, Bot, Bug, LayoutDashboard, ListChecks, Menu, ScanSearch, Settings } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { useWorkspace } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useRailProject } from "./app-sidebar";

const ITEM =
    "flex min-h-12 w-full flex-col items-center justify-center gap-0.5 border-t-2 border-transparent px-1 pt-1 pb-1.5 text-xs text-muted-foreground outline-none focus-visible:bg-accent focus-visible:text-foreground [&_svg]:size-5";
/** The current place: its own top edge, weight and colour, so it isn't told by colour alone. */
const CURRENT = "border-primary font-semibold text-primary";

function Item({
    label,
    icon,
    current,
    children,
}: {
    label: string;
    icon: ReactNode;
    current: boolean;
    /** A Link: its contents and classes are filled in here. */
    children: (props: { className: string; "aria-current": "page" | undefined; children: ReactNode }) => ReactElement;
}) {
    return (
        <li className="min-w-0">
            {children({
                className: cn(ITEM, current && CURRENT),
                "aria-current": current ? "page" : undefined,
                children: (
                    <>
                        {icon}
                        <span className="max-w-full truncate">{label}</span>
                    </>
                ),
            })}
        </li>
    );
}

export function MobileNav() {
    const { ws } = useWorkspace();
    const project = useRailProject(ws);
    const { pathname } = useLocation();
    const { branch } = useLocation({ select: (l) => l.search as { branch?: string } });
    const { openMobile, setOpenMobile } = useSidebar();

    const base = project ? `/w/${ws}/p/${project}` : "";
    const at = (path: string) => Boolean(base) && (pathname === `${base}${path}` || pathname.startsWith(`${base}${path}/`));
    const params = { ws, project: project ?? "" };
    const search = branch ? { branch } : {};

    return (
        <nav
            aria-label="Main"
            data-mobile-nav=""
            className="fixed inset-x-0 bottom-0 z-30 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
        >
            <ul className="grid grid-cols-5 ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]">
                {project ? (
                    <>
                        <Item label="Overview" icon={<LayoutDashboard aria-hidden="true" />} current={at("/overview")}>
                            {(p) => <Link to="/w/$ws/p/$project/overview" params={params} search={search} {...p} />}
                        </Item>
                        <Item label="Issues" icon={<Bug aria-hidden="true" />} current={at("/issues")}>
                            {(p) => <Link to="/w/$ws/p/$project/issues" params={params} search={search} {...p} />}
                        </Item>
                        <Item label="Tasks" icon={<ListChecks aria-hidden="true" />} current={at("/tasks")}>
                            {(p) => <Link to="/w/$ws/p/$project/tasks" params={params} search={search} {...p} />}
                        </Item>
                        <Item label="Runs" icon={<ScanSearch aria-hidden="true" />} current={at("/runs") || at("/comparisons")}>
                            {(p) => <Link to="/w/$ws/p/$project/runs" params={params} {...p} />}
                        </Item>
                    </>
                ) : (
                    // A workspace with no project yet: the places that don't need one.
                    <>
                        <Item
                            label="Analytics"
                            icon={<BarChart3 aria-hidden="true" />}
                            current={pathname === `/w/${ws}/analytics` || pathname.startsWith(`/w/${ws}/analytics/`)}
                        >
                            {(p) => <Link to="/w/$ws/analytics" params={{ ws }} {...p} />}
                        </Item>
                        <Item label="Agents & API" icon={<Bot aria-hidden="true" />} current={pathname.startsWith(`/w/${ws}/agents`)}>
                            {(p) => <Link to="/w/$ws/agents" params={{ ws }} {...p} />}
                        </Item>
                        <Item label="Settings" icon={<Settings aria-hidden="true" />} current={pathname.includes("/settings")}>
                            {(p) => <Link to="/w/$ws/settings" params={{ ws }} {...p} />}
                        </Item>
                    </>
                )}
                <li className={cn("min-w-0", !project && "col-start-5")}>
                    <button
                        type="button"
                        className={ITEM}
                        aria-haspopup="dialog"
                        aria-expanded={openMobile}
                        onClick={() => setOpenMobile(true)}
                    >
                        <Menu aria-hidden="true" />
                        <span>Menu</span>
                    </button>
                </li>
            </ul>
        </nav>
    );
}
