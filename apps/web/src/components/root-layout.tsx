import { Outlet } from "@tanstack/react-router";
import { Announcer } from "@/components/announcer";
import { ReauthDialog } from "@/components/reauth-dialog";
import { Toaster } from "@/components/ui/sonner";

/** Present on every page from the start: the live region, the toast area (also a live region), and the "confirm it's you" dialog. */
export function RootLayout() {
    return (
        <>
            <Outlet />
            <Announcer />
            <ReauthDialog />
            <Toaster position="bottom-right" />
        </>
    );
}
