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
            {/* On a phone, clear of the bottom bar. */}
            <Toaster position="bottom-right" mobileOffset={{ bottom: "4.5rem", left: "1rem", right: "1rem" }} />
        </>
    );
}
