import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { SkipToMain } from "@/components/skip-to-main";
import { Separator } from "@/components/ui/separator";
import { SIDEBAR_PREF, SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { FinishSetupButton, SetupHost } from "@/features/setup/setup-host";
import { type LiveStatus, useLiveUpdates } from "@/lib/live";
import { prefs } from "@/lib/prefs";
import { keys } from "@/lib/queries";
import { useRunNotifications } from "@/lib/run-notify";
import { useWorkspace } from "@/lib/session";
import { cn } from "@/lib/utils";

const STATUS_TEXT: Record<LiveStatus, string> = {
    connecting: "Connecting…",
    live: "Live",
    reconnecting: "Reconnecting…",
    paused: "Live updates paused (too many open tabs)",
};

function LiveIndicator({ status }: { status: LiveStatus }) {
    return (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="live-status" data-status={status}>
            <span
                aria-hidden="true"
                className={cn(
                    "size-2 rounded-full",
                    status === "live" ? "bg-st-resolved" : status === "paused" ? "bg-sev-medium" : "animate-pulse bg-muted-foreground",
                )}
            />
            {STATUS_TEXT[status]}
        </span>
    );
}

/** The signed-in frame: the rail on the left, the page on the right, and the workspace's live updates. */
export function AppShell() {
    const { ws, workspace } = useWorkspace();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const router = useRouter();

    const onSessionEnded = useCallback(() => {
        queryClient.removeQueries({ queryKey: keys.me });
        void navigate({ to: "/sign-in", search: { redirect: router.state.location.href } });
    }, [queryClient, navigate, router]);
    const onLostAccess = useCallback(() => void navigate({ to: "/dashboard" }), [navigate]);
    const onEvent = useRunNotifications(ws);
    const status = useLiveUpdates(ws, onSessionEnded, onLostAccess, onEvent);

    return (
        <SidebarProvider defaultOpen={prefs.get(SIDEBAR_PREF) !== "false"}>
            <SkipToMain />
            <AppSidebar />
            <SidebarInset>
                <header className="sticky top-0 z-20 flex h-11 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur">
                    <SidebarTrigger />
                    <Separator orientation="vertical" className="h-5" />
                    <span className="truncate text-sm text-muted-foreground">{workspace.name}</span>
                    <span className="ms-auto flex items-center gap-3">
                        <FinishSetupButton />
                        <LiveIndicator status={status} />
                    </span>
                </header>
                <main id="content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
                    <Outlet />
                </main>
                <SetupHost />
            </SidebarInset>
        </SidebarProvider>
    );
}
