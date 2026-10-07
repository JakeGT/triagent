import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider,
    useNavigate,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OneTimeReveal } from "./one-time-reveal";

/** A page that creates a token, like Settings → API tokens, plus a tick standing in for live updates. */
function TokensPage() {
    const [secret, setSecret] = useState<string | null>(null);
    const [tick, setTick] = useState(0);
    const navigate = useNavigate();
    const dismiss = useCallback(() => setSecret(null), []);
    return (
        <div>
            <button type="button" onClick={() => setSecret("tri_secret_value")}>
                Create token
            </button>
            <button type="button" onClick={() => setTick((t) => t + 1)}>
                Live update
            </button>
            <button type="button" onClick={() => void navigate({ to: "/other" as never })}>
                Go elsewhere
            </button>
            <span data-testid="tick">{tick}</span>
            {secret && <OneTimeReveal value={secret} label="New API token" onDismiss={dismiss} />}
        </div>
    );
}

async function renderApp() {
    const root = createRootRoute({ component: Outlet });
    const tokens = createRoute({ getParentRoute: () => root, path: "/", component: TokensPage });
    const other = createRoute({ getParentRoute: () => root, path: "/other", component: () => <p>Another page</p> });
    const router = createRouter({ routeTree: root.addChildren([tokens, other]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(<RouterProvider router={router} />);
    await screen.findByRole("button", { name: "Create token" });
    return router;
}

describe("OneTimeReveal", () => {
    it("shows the secret once, with a copy button, and focuses it", async () => {
        const user = userEvent.setup();
        await renderApp();
        await user.click(screen.getByRole("button", { name: "Create token" }));
        const input = screen.getByLabelText("New API token") as HTMLInputElement;
        expect(input.value).toBe("tri_secret_value");
        expect(input.readOnly).toBe(true);
        expect(screen.getByText("Copy it now: it won't be shown again.")).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByTestId("one-time-reveal"));

        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        await user.click(screen.getByRole("button", { name: "Copy" }));
        expect(writeText).toHaveBeenCalledWith("tri_secret_value");
        expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    });

    it("survives re-renders of the page around it (live updates)", async () => {
        const user = userEvent.setup();
        await renderApp();
        await user.click(screen.getByRole("button", { name: "Create token" }));
        await user.click(screen.getByRole("button", { name: "Live update" }));
        await user.click(screen.getByRole("button", { name: "Live update" }));
        expect(screen.getByTestId("tick").textContent).toBe("2");
        expect((screen.getByLabelText("New API token") as HTMLInputElement).value).toBe("tri_secret_value");
    });

    it("is cleared when the person navigates away", async () => {
        const user = userEvent.setup();
        const router = await renderApp();
        await user.click(screen.getByRole("button", { name: "Create token" }));
        await user.click(screen.getByRole("button", { name: "Go elsewhere" }));
        await screen.findByText("Another page");
        await act(() => router.history.back());
        await screen.findByRole("button", { name: "Create token" });
        expect(screen.queryByLabelText("New API token")).toBeNull();
    });

    it("is cleared when the URL changes without leaving the page", async () => {
        const user = userEvent.setup();
        const router = await renderApp();
        await user.click(screen.getByRole("button", { name: "Create token" }));
        await act(() => router.navigate({ to: "/", search: { tab: "2" } as never }));
        expect(screen.queryByLabelText("New API token")).toBeNull();
    });

    it("is cleared when the person says they've saved it", async () => {
        const user = userEvent.setup();
        await renderApp();
        await user.click(screen.getByRole("button", { name: "Create token" }));
        await user.click(screen.getByRole("button", { name: "I've saved it" }));
        expect(screen.queryByLabelText("New API token")).toBeNull();
    });
});
