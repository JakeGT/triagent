import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/context/theme-provider";
import { configureApi, isApiError } from "@/lib/api";
import { keys } from "@/lib/queries";
import { createAppRouter } from "@/router";
import "sonner/dist/styles.css";
import "@/styles/index.css";

const queryClient = new QueryClient({
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
        queryClient.removeQueries({ queryKey: keys.me });
        const here = router.state.location.href;
        if (router.state.location.pathname !== "/sign-in") void router.navigate({ to: "/sign-in", search: { redirect: here } });
    },
    onPasswordChangeRequired() {
        void queryClient.invalidateQueries({ queryKey: keys.me });
        void router.navigate({ to: "/change-password" });
    },
});

const root = document.getElementById("root");
if (root)
    createRoot(root).render(
        <StrictMode>
            <QueryClientProvider client={queryClient}>
                <ThemeProvider>
                    <RouterProvider router={router} />
                </ThemeProvider>
            </QueryClientProvider>
        </StrictMode>,
    );
