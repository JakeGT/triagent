import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { limitsLine } from "@/features/runs/runs-page";
import { ApiError } from "@/lib/api";
import type { InstanceReviews, InstanceWorkspace } from "@/lib/insights-types";
import { capacityNote, InstanceReviewsSettings, parseLimit } from "./instance-reviews-settings";
import { ReviewLimitForm } from "./instance-workspaces-settings";

const session = vi.hoisted(() => ({ admin: true }));
const calls = vi.hoisted(() => ({
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
    useMe: () => ({ user: { isInstanceAdmin: session.admin } }),
    useWorkspace: () => ({ ws: "acme", can: () => true }),
    useCan: () => () => true,
    useProject: () => ({ ws: "acme", slug: "app", project: { name: "App" } }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
    ...(await original<typeof import("@tanstack/react-router")>()),
    Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
        <a href={to} className={className}>
            {children}
        </a>
    ),
}));
vi.mock("@/lib/api", async (original) => ({
    ...(await original<typeof import("@/lib/api")>()),
    api: calls,
}));

const DATA: InstanceReviews = {
    limits: { instance: 4, perWorkspace: 1 },
    defaults: { instance: 4, perWorkspace: 1 },
    saved: null,
    runners: [
        { name: "runner-one", version: "0.1.0", slots: 2, busy: 1, lastSeenAt: new Date().toISOString() },
        { name: "runner-two", version: null, slots: 1, busy: 0, lastSeenAt: new Date().toISOString() },
    ],
    running: 1,
    queued: 3,
};

function show(ui: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
    session.admin = true;
    for (const f of Object.values(calls)) f.mockReset();
    calls.get.mockResolvedValue(DATA);
});

describe("parseLimit", () => {
    it("takes whole numbers from 1 to 100 and nothing else", () => {
        expect(["1", " 7 ", "100"].map(parseLimit)).toEqual([1, 7, 100]);
        expect(["", "0", "101", "2.5", "-1", "1e1", "four", "1000"].map(parseLimit)).toEqual(Array(8).fill(null));
    });
});

describe("capacityNote", () => {
    it("says what the runners can do beside the limit, and that reviews wait when the limit is higher", () => {
        expect(capacityNote(4, [])).toBe("No runner is connected, so no review can start. Start a runner (see the README).");
        expect(capacityNote(4, [{ slots: 2 }, { slots: 1 }])).toBe(
            "The connected runners can work on 3 reviews at once, fewer than this instance's limit of 4: reviews past 3 wait for a free runner slot.",
        );
        expect(capacityNote(2, [{ slots: 4 }])).toBe(
            "The connected runner can work on 4 reviews at once; this instance's limit keeps it to 2.",
        );
        expect(capacityNote(1, [{ slots: 1 }])).toBe(
            "The connected runner can work on 1 review at once, the same as this instance's limit.",
        );
    });
});

describe("the Runs page's line about limits", () => {
    it("says the instance's limit and this workspace's", () => {
        expect(limitsLine({ instance: 4, workspace: 2 })).toBe("At most 4 reviews at once on this instance, 2 in this workspace.");
        expect(limitsLine({ instance: 1, workspace: 1 })).toBe("At most 1 review at once on this instance, 1 in this workspace.");
    });
});

describe("Settings → Instance → Reviews", () => {
    it("shows the two limits, where they come from, and each runner with its slots in use", async () => {
        show(<InstanceReviewsSettings />);
        expect(await screen.findByLabelText("At once on this instance")).toHaveProperty("value", "4");
        expect(screen.getByLabelText("At once in one workspace")).toHaveProperty("value", "1");
        expect(screen.getByTestId("limits-source").textContent).toMatch(/REVIEW_CONCURRENCY and REVIEW_CONCURRENCY_PER_WORKSPACE/);
        expect(screen.getByTestId("capacity-note").textContent).toBe(
            "The connected runners can work on 3 reviews at once, fewer than this instance's limit of 4: reviews past 3 wait for a free runner slot. Now: 1 running, 3 queued.",
        );
        const one = within(screen.getByTestId("runner-runner-one"));
        expect(one.getByText("0.1.0")).toBeTruthy();
        expect(one.getByText("1 of 2")).toBeTruthy();
        const two = within(screen.getByTestId("runner-runner-two"));
        expect(two.getByText("Not reported")).toBeTruthy();
        expect(two.getByText("0 of 1")).toBeTruthy();
        // One filled button, and it's off until something changes.
        expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Save limits"]);
        expect(screen.getByRole("button", { name: "Save limits" })).toHaveProperty("disabled", true);
    });

    it("saves both limits with one button, and then says who saved them", async () => {
        const saved = { ...DATA, limits: { instance: 6, perWorkspace: 2 }, saved: { by: "Ada", at: "2026-10-10T09:00:00.000Z" } };
        calls.put.mockResolvedValue(saved);
        show(<InstanceReviewsSettings />);
        const instance = await screen.findByLabelText("At once on this instance");
        await userEvent.clear(instance);
        await userEvent.type(instance, "6");
        const perWorkspace = screen.getByLabelText("At once in one workspace");
        await userEvent.clear(perWorkspace);
        await userEvent.type(perWorkspace, "2");
        await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
        await waitFor(() => expect(calls.put).toHaveBeenCalledWith("/api/v1/instance/reviews", { instance: 6, perWorkspace: 2 }));
        await waitFor(() => expect(screen.getByTestId("limits-source").textContent).toMatch(/^Saved by Ada on /));
        expect(screen.getByTestId("limits-source").textContent).toMatch(/4 on the instance, 1 in one workspace/);
        expect(screen.getByRole("button", { name: "Save limits" })).toHaveProperty("disabled", true);
    });

    it("says what's wrong beside the field, keeps what was typed, and sends nothing", async () => {
        show(<InstanceReviewsSettings />);
        const instance = await screen.findByLabelText("At once on this instance");
        await userEvent.clear(instance);
        await userEvent.type(instance, "101");
        await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
        expect(screen.getByRole("alert").textContent).toBe("Give a whole number from 1 to 100.");
        expect(instance.getAttribute("aria-invalid")).toBe("true");
        expect(instance.getAttribute("aria-describedby")).toContain(screen.getByRole("alert").id);
        expect(instance).toHaveProperty("value", "101");
        expect(calls.put).not.toHaveBeenCalled();
    });

    it("shows the server's refusal and keeps what was typed", async () => {
        calls.put.mockRejectedValue(
            new ApiError(400, { error: "The number of reviews at once on this instance must be a whole number from 1 to 100." }),
        );
        show(<InstanceReviewsSettings />);
        const instance = await screen.findByLabelText("At once on this instance");
        await userEvent.clear(instance);
        await userEvent.type(instance, "9");
        await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
        expect((await screen.findByRole("alert")).textContent).toMatch(/must be a whole number from 1 to 100/);
        expect(instance).toHaveProperty("value", "9");
    });

    it("with no runner connected, says no review can start, and shows no empty table", async () => {
        calls.get.mockResolvedValue({ ...DATA, runners: [], running: 0, queued: 2 });
        show(<InstanceReviewsSettings />);
        expect((await screen.findByTestId("capacity-note")).textContent).toMatch(/^No runner is connected, so no review can start\./);
        expect(screen.queryByRole("table")).toBeNull();
    });

    it("is for instance administrators: anyone else is told so, and nothing is asked of the server", () => {
        session.admin = false;
        show(<InstanceReviewsSettings />);
        expect(screen.getByText("Only instance administrators can change how many reviews run at once.")).toBeTruthy();
        expect(calls.get).not.toHaveBeenCalled();
    });
});

describe("a workspace's own limit, on the Workspaces page", () => {
    const workspace = (reviewLimit: number | null): InstanceWorkspace => ({
        id: "w-1",
        slug: "acme",
        name: "Acme",
        kind: "org",
        grant: null,
        used: 0,
        remaining: null,
        reviewLimit,
    });
    const limits = { instance: 4, perWorkspace: 1 };

    it("is empty for the default, which the field names", () => {
        show(<ReviewLimitForm w={workspace(null)} limits={limits} />);
        const field = screen.getByLabelText("Reviews at once in Acme");
        expect(field).toHaveProperty("value", "");
        expect(field.getAttribute("placeholder")).toBe("Default (1)");
        expect(screen.getByRole("button").textContent).toBe("Set Acme's reviews at once");
    });

    it("saves a number as the workspace's own limit", async () => {
        calls.put.mockResolvedValue({ workspaceId: "w-1", reviewLimit: 3 });
        show(<ReviewLimitForm w={workspace(null)} limits={limits} />);
        await userEvent.type(screen.getByLabelText("Reviews at once in Acme"), "3");
        await userEvent.click(screen.getByRole("button"));
        await waitFor(() => expect(calls.put).toHaveBeenCalledWith("/api/v1/instance/workspaces/w-1/review-limit", { limit: 3 }));
    });

    it("emptied, goes back to the default", async () => {
        calls.delete.mockResolvedValue({ workspaceId: "w-1", reviewLimit: null });
        show(<ReviewLimitForm w={workspace(5)} limits={limits} />);
        const field = screen.getByLabelText("Reviews at once in Acme");
        expect(field).toHaveProperty("value", "5");
        expect(screen.getByRole("button").textContent).toBe("Change Acme's reviews at once");
        await userEvent.clear(field);
        await userEvent.click(screen.getByRole("button"));
        await waitFor(() => expect(calls.delete).toHaveBeenCalledWith("/api/v1/instance/workspaces/w-1/review-limit"));
        expect(calls.put).not.toHaveBeenCalled();
    });

    it("refuses what isn't a limit, beside the field, without losing it", async () => {
        show(<ReviewLimitForm w={workspace(null)} limits={limits} />);
        const field = screen.getByLabelText("Reviews at once in Acme");
        await userEvent.type(field, "lots");
        await userEvent.click(screen.getByRole("button"));
        expect(screen.getByRole("alert").textContent).toBe("Give a whole number from 1 to 100, or leave it empty for the default.");
        expect(field).toHaveProperty("value", "lots");
        expect(calls.put).not.toHaveBeenCalled();
        expect(calls.delete).not.toHaveBeenCalled();
    });
});
