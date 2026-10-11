import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { requestReauth } from "@/components/reauth-dialog";
import { ThemeProvider } from "@/context/theme-provider";
import { configureApi, isApiError } from "@/lib/api";
import { keys } from "@/lib/queries";
import { reportError, setReportingUser, startReporting } from "@/lib/reporting";
import { createAppRouter } from "@/router";
import "sonner/dist/styles.css";
import "@/styles/index.css";

// First: a fault while the app starts is the one most worth hearing about. Does nothing unless the instance asks for it.
void startReporting();

const queryClient = new QueryClient({
    // A load or a change that failed for a reason of the app's own (the server's refusals and faults aren't: lib/reporting.ts).
    queryCache: new QueryCache({ onError: (err) => reportError(err, "query") }),
    mutationCache: new MutationCache({ onError: (err) => reportError(err, "mutation") }),
    defaultOptions: {
        queries: {
            // Live updates say when data changes, so there's no need to refetch on every focus.
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (failures, error) => failures < 2 && !(isApiError(error) && error.status < 500),
        },
    },
});

const router = createAppRouter(queryClient);

configureApi({
    onSignedOut() {
        setReportingUser(null);
        queryClient.removeQueries({ queryKey: keys.me });
        const here = router.state.location.href;
        if (router.state.location.pathname !== "/sign-in") void router.navigate({ to: "/sign-in", search: { redirect: here } });
    },
    onPasswordChangeRequired() {
        void queryClient.invalidateQueries({ queryKey: keys.me });
        void router.navigate({ to: "/change-password" });
    },
    onReauthRequired: requestReauth,
});

const root = document.getElementById("root");
if (root)
    createRoot(root, {
        // What a page couldn't recover from, and what an error boundary caught: both still go to the console, as React does itself.
        onUncaughtError(error, info) {
            console.error(error, info.componentStack);
            reportError(error, "render");
        },
        onCaughtError(error, info) {
            console.error(error, info.componentStack);
            reportError(error, "boundary");
        },
    }).render(
        <StrictMode>
            <QueryClientProvider client={queryClient}>
                <ThemeProvider>
                    <RouterProvider router={router} />
                </ThemeProvider>
            </QueryClientProvider>
        </StrictMode>,
    );
