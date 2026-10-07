import { Link } from "@tanstack/react-router";
import { Bell, ChevronsUpDown, KeyRound, LogOut, Monitor, Moon, Palette, Sun } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { type Theme, useTheme } from "@/context/theme-provider";
import { useSignOut } from "@/features/auth/use-sign-out";
import { useMe, useWorkspace } from "@/lib/session";
import { initials } from "@/lib/utils";

export function UserMenu() {
    const me = useMe();
    const { ws } = useWorkspace();
    const { isMobile } = useSidebar();
    const { theme, setTheme } = useTheme();
    const signOut = useSignOut();
    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton size="lg" tooltip={`Account: ${me.user.displayName}`} data-testid="user-menu">
                            <span
                                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
                                aria-hidden="true"
                            >
                                {initials(me.user.displayName)}
                            </span>
                            <span className="grid min-w-0 flex-1 text-start leading-tight">
                                <span className="truncate font-medium">{me.user.displayName}</span>
                                <span className="truncate text-xs text-muted-foreground">{me.user.username}</span>
                            </span>
                            <ChevronsUpDown className="ms-auto size-4 opacity-60" aria-hidden="true" />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end">
                        <DropdownMenuLabel className="font-normal">
                            Signed in as <strong className="font-medium">{me.user.username ?? me.user.displayName}</strong>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                            <Link to="/w/$ws/settings/notifications" params={{ ws }}>
                                <Bell /> Notifications
                            </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                            <Link to="/w/$ws/settings/password" params={{ ws }}>
                                <KeyRound /> Password
                            </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                            <Link to="/w/$ws/settings/appearance" params={{ ws }}>
                                <Palette /> Appearance
                            </Link>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
                        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
                            <DropdownMenuRadioItem value="light">
                                <Sun /> Light
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="dark">
                                <Moon /> Dark
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="system">
                                <Monitor /> Same as system
                            </DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => signOut.mutate()}>
                            <LogOut /> Sign out
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}
