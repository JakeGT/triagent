import { Outlet } from "@tanstack/react-router";
import { Announcer } from "@/components/announcer";
import { Toaster } from "@/components/ui/sonner";

/** Present on every page from the start: the live region and the toast area (also a live region). */
export function RootLayout() {
    return (
        <>
            <Outlet />
            <Announcer />
            <Toaster position="bottom-right" />
        </>
    );
}
