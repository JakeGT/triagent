import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { request } from "@/lib/api";

export function useSignOut() {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    return useMutation({
        // `redirect`: the identity provider's sign-out page, which comes back here; null with passwords.
        mutationFn: () => request<{ ok: boolean; redirect: string | null }>("/auth/logout", { method: "POST", body: {}, quiet401: true }),
        // Signed out either way: forget everything this session loaded.
        onSettled: async (data) => {
            queryClient.clear();
            if (data?.redirect && /^https?:\/\//.test(data.redirect)) window.location.assign(data.redirect);
            else await navigate({ to: "/sign-in" });
        },
    });
}
