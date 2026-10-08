// Everything a signed-in person sees, plus the first-run tutorial when it has something to do: it's
// loaded only then, so most page loads never fetch it.

import { useQuery } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { meQuery } from "@/lib/queries";
import { useTourRequests } from "@/lib/tutorial";

const TutorialHost = lazy(() => import("@/features/tutorial/tutorial-host").then((m) => ({ default: m.TutorialHost })));

export function AuthedLayout() {
    const me = useQuery(meQuery).data;
    const requests = useTourRequests();
    const wanted = requests > 0 || me?.tutorial.status === "pending" || me?.tutorial.status === "in_progress";
    return (
        <>
            <Outlet />
            {wanted && (
                <Suspense fallback={null}>
                    <TutorialHost />
                </Suspense>
            )}
        </>
    );
}
