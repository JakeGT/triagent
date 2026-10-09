import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReauthDialog, reauthHref, requestReauth } from "./reauth-dialog";

function renderDialog() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <ReauthDialog />
        </QueryClientProvider>,
    );
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("ReauthDialog", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("takes the password, confirms it with the server, and lets the step go ahead", async () => {
        const user = userEvent.setup();
        let attempts = 0;
        const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
            if (url !== "/auth/reauth") return json(200, { mode: "local", providerName: null, inviteHint: null, signupMode: "invite" });
            return ++attempts > 1 ? json(200, { ok: true }) : json(400, { error: "That password is wrong." });
        });
        vi.stubGlobal("fetch", fetchMock);
        renderDialog();
        let answer: Promise<boolean> = Promise.resolve(false);
        act(() => {
            answer = requestReauth({ error: "Confirm it's you first.", code: "reauth_required", method: "password" });
        });
        expect(await screen.findByRole("dialog", { name: "Confirm it's you" })).toBeTruthy();
        await user.type(screen.getByLabelText("Password"), "not-it");
        await user.click(screen.getByRole("button", { name: "Confirm" }));
        expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That password is wrong.");
        await user.clear(screen.getByLabelText("Password"));
        await user.type(screen.getByLabelText("Password"), "the-right-one");
        await user.click(screen.getByRole("button", { name: "Confirm" }));
        await expect(answer).resolves.toBe(true);
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        const [, init] = fetchMock.mock.calls.filter(([url]) => url === "/auth/reauth")[1] as unknown as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toEqual({ password: "the-right-one" });
    });

    it("cancelling says no, and several steps asking at once share one dialog", async () => {
        const user = userEvent.setup();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => json(200, { mode: "oidc", providerName: "Example ID", inviteHint: null, signupMode: "invite" })),
        );
        renderDialog();
        const body = {
            error: "Confirm it's you first.",
            code: "reauth_required",
            method: "provider",
            reauthUrl: "/auth/login?prompt=login&max_age=60&next=%2F",
        };
        let first: Promise<boolean> = Promise.resolve(true);
        let second: Promise<boolean> = Promise.resolve(true);
        act(() => {
            first = requestReauth(body);
            second = requestReauth(body);
        });
        expect(await screen.findByRole("button", { name: "Sign in with Example ID" })).toBeTruthy();
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await expect(first).resolves.toBe(false);
        await expect(second).resolves.toBe(false);
    });

    it("sends people back to the page they were on, and only ever to this site's sign-in", () => {
        expect(reauthHref("/auth/login?prompt=login&max_age=60&next=%2F", "/w/acme/settings/review-model?x=1")).toBe(
            "/auth/login?prompt=login&max_age=60&next=%2Fw%2Facme%2Fsettings%2Freview-model%3Fx%3D1",
        );
        expect(reauthHref("https://evil.example/auth/login", "/w/acme")).toBe("/auth/login?prompt=login&max_age=60&next=%2Fw%2Facme");
        expect(reauthHref("/auth/login?prompt=login&max_age=60", "//evil.example")).toBe("/auth/login?prompt=login&max_age=60&next=%2F");
        expect(reauthHref("/auth/login?prompt=login&max_age=60", "/\\evil.example")).toBe("/auth/login?prompt=login&max_age=60&next=%2F");
        expect(reauthHref("/auth/login-phish?x=1", "/w/acme")).toBe("/auth/login?prompt=login&max_age=60&next=%2Fw%2Facme");
    });
});
