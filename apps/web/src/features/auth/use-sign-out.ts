import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { request } from "@/lib/api";

export function useSignOut() {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    return useMutation({
        mutationFn: () => request("/auth/logout", { method: "POST", body: {}, quiet401: true }),
        // Signed out either way: forget everything this session loaded.
        onSettled: async () => {
            queryClient.clear();
            await navigate({ to: "/sign-in" });
        },
    });
}
