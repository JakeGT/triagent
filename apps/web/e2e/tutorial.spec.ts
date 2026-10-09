// The first-run tutorial, on a server of its own where new accounts start it (TUTORIAL_AUTO_START is on;
// the other servers turn it off so it never gets in their way). Every step must find its part of the
// page (data-tour="…"), so moving one fails here. With SCREENSHOT_DIR set, it saves a few steps.

import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { PASSWORD } from "./constants";
import { Api, expect, signInPage, test, unique } from "./fixtures";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const dir = process.env.SCREENSHOT_DIR;

const card = (page: Page) => page.locator("[data-tour-card]");

async function at(page: Page, step: string) {
    await expect(card(page)).toHaveAttribute("data-tour-step", step, { timeout: 10_000 });
}

/** A step anchored to its part of the page must find it: the card is beside it, not in the middle. */
async function expectPlaced(page: Page) {
    const anchor = await card(page).getAttribute("data-tour-anchor");
    if (anchor) {
        await expect(card(page), `the step's part of the page, [data-tour="${anchor}"]`).toHaveAttribute("data-tour-mode", "anchored");
        await expect(page.locator(`[data-tour="${anchor}"]`)).toBeVisible();
    } else await expect(card(page)).toHaveAttribute("data-tour-mode", "centred");
    // Focus moves into the step, so its name is read out.
    await expect(page.locator("[data-tour-dialog]")).toBeFocused();
}

async function axe(page: Page, what: string) {
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const problems = results.violations.map(
        (v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary}`).join("\n  ")}`,
    );
    expect(problems, `accessibility problems on ${what}`).toEqual([]);
}

async function shot(page: Page, name: string) {
    if (!dir) return;
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(dir, `tutorial-${name}.png`) });
}

/** A new account that has chosen its own password, its tutorial not started. */
async function newcomer(admin: Api, baseURL: string) {
    const username = unique("newcomer");
    const created = await admin.post("/api/v1/instance/users", { username });
    const api = await Api.signIn(baseURL, username, created.password);
    await api.post("/api/v1/me/password", { current: created.password, password: PASSWORD });
    await api.ctx.dispose();
    return username;
}

async function tutorialOf(page: Page) {
    return (await (await page.request.get("/api/v1/me/tutorial")).json()) as {
        status: string;
        step: number;
        example: unknown;
        setup: string;
    };
}

test("the first sign-in starts the tour, after the new password, and every step finds its part of the page", async ({ page, admin }) => {
    test.setTimeout(90_000);
    const username = unique("first");
    const created = await admin.post("/api/v1/instance/users", { username });
    await page.goto("/sign-in");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(created.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    // The forced password change comes first, with no tour over it.
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await page.getByLabel("Current password").fill(created.password);
    await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("New password again").fill(PASSWORD);
    await page.getByRole("button", { name: "Save and continue" }).click();

    await at(page, "welcome");
    await expectPlaced(page);
    await expect(page.getByRole("dialog", { name: /Step 1 of \d+ Welcome to Triagent/ })).toBeVisible();
    await axe(page, "the welcome step");
    await shot(page, "1-welcome");
    await page.getByRole("button", { name: "Start the tour" }).click();

    // Back and Next.
    await at(page, "pickers");
    await expectPlaced(page);
    await expect(page.getByTestId("example-badge").first()).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await at(page, "welcome");
    await page.getByRole("button", { name: "Start the tour" }).click();
    await at(page, "pickers");

    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
        const step = (await card(page).getAttribute("data-tour-step")) as string;
        seen.push(step);
        await expectPlaced(page);
        if (step === "overview") {
            await axe(page, "an anchored step");
            await shot(page, "2-overview");
        }
        if (step === "triage") await shot(page, "3-triage");
        if (step === "try-it") {
            // Next waits until the person has done it.
            await expect(page.locator("[data-tour-next]")).toBeDisabled();
            await shot(page, "4-try-it");
            await page.getByTestId("triage").getByRole("button", { name: "Resolved", exact: true }).click();
            await expect(page.locator("[data-tour-next]")).toBeEnabled();
        }
        if (step === "compare") await shot(page, "5-compare");
        if (step === "finish") break;
        await page.locator("[data-tour-next]").click();
        await expect(card(page)).not.toHaveAttribute("data-tour-step", step);
    }
    expect(seen).toEqual([
        "pickers",
        "overview",
        "issues",
        "issue",
        "triage",
        "try-it",
        "tasks",
        "branches",
        "compare",
        "runs",
        "analytics",
        "activity",
        "agents",
        "settings",
        "finish",
    ]);
    await shot(page, "6-finish");
    await page.getByRole("button", { name: "Keep the example" }).click();
    await expect(card(page)).toHaveCount(0);
    const state = await tutorialOf(page);
    expect(state.status).toBe("completed");
    expect(state.example).not.toBeNull();
});

test("closing the browser mid-tour picks it up at the same step", async ({ page, admin, baseURL }) => {
    const username = await newcomer(admin, baseURL as string);
    await signInPage(page, username, PASSWORD);
    await page.goto("/");
    await at(page, "welcome");
    await page.getByRole("button", { name: "Start the tour" }).click();
    await at(page, "pickers");
    await page.locator("[data-tour-next]").click();
    await at(page, "overview");
    await expect.poll(async () => (await tutorialOf(page)).step).toBe(2);

    await page.context().clearCookies();
    await signInPage(page, username, PASSWORD);
    await page.goto("/");
    await at(page, "overview");
    await expectPlaced(page);
});

test("skipping (or Escape) closes the tour for good, and Settings can show it again", async ({ page, admin, baseURL }) => {
    const username = await newcomer(admin, baseURL as string);
    await signInPage(page, username, PASSWORD);
    await page.goto("/");
    await at(page, "welcome");
    await page.getByRole("button", { name: "Start the tour" }).click();
    await at(page, "pickers");
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expect.poll(async () => (await tutorialOf(page)).status).toBe("dismissed");
    // Account setup follows the tour; closing it counts as done.
    const setup = page.getByTestId("setup-dialog");
    await expect(setup.getByRole("heading", { name: /^Welcome to Triagent/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(setup).toHaveCount(0);
    await expect.poll(async () => (await tutorialOf(page)).setup).toBe("done");

    // The next sign-in doesn't nag.
    await page.context().clearCookies();
    await signInPage(page, username, PASSWORD);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByTestId("setup-dialog")).toHaveCount(0);

    // Settings → Tutorial: remove the example, then show the tour again, which makes a new one.
    await page.goto(`/w/${username}/settings/tutorial`);
    await expect(page.getByText("You skipped the tour.")).toBeVisible();
    await axe(page, "Settings → Tutorial");
    await page.getByRole("button", { name: "Remove the example project" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove the example" }).click();
    await expect(page.getByText("You have no example project.")).toBeVisible();
    expect((await tutorialOf(page)).example).toBeNull();
    await page.getByRole("button", { name: "Show the tutorial again" }).click();
    await at(page, "welcome");
    await expect.poll(async () => (await tutorialOf(page)).example).not.toBeNull();
    await page.getByRole("button", { name: "Skip tour" }).click();
    await expect(card(page)).toHaveCount(0);
});

test("the try-it step can be skipped, and the example can be removed at the end", async ({ page, admin, baseURL }) => {
    const username = await newcomer(admin, baseURL as string);
    await signInPage(page, username, PASSWORD);
    await page.goto("/");
    await at(page, "welcome");
    // Straight to the try-it step, as if picked up there.
    await page.request.patch("/api/v1/me/tutorial", {
        data: { step: 6 },
        headers: { "x-csrf-token": (await (await page.request.get("/api/v1/me")).json()).csrf },
    });
    await page.reload();
    await at(page, "try-it");
    await page.getByRole("button", { name: "Skip this step" }).click();
    await at(page, "tasks");
    // Jump to the end.
    await page.request.patch("/api/v1/me/tutorial", {
        data: { step: 15 },
        headers: { "x-csrf-token": (await (await page.request.get("/api/v1/me")).json()).csrf },
    });
    await page.reload();
    await at(page, "finish");
    await page.getByRole("button", { name: "Remove the example" }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/w/${username}$`));
    const state = await tutorialOf(page);
    expect(state.status).toBe("completed");
    expect(state.example).toBeNull();
});

test("on a phone, steps whose part of the page is folded away show in the middle of the screen", async ({ page, admin, baseURL }) => {
    const username = await newcomer(admin, baseURL as string);
    await page.setViewportSize({ width: 390, height: 844 });
    await signInPage(page, username, PASSWORD);
    await page.goto("/");
    await at(page, "welcome");
    await page.getByRole("button", { name: "Start the tour" }).click();
    // The pickers are in the folded rail.
    await at(page, "pickers");
    await expect(card(page)).toHaveAttribute("data-tour-mode", "centred");
    await expect(page.locator("[data-tour-dialog]")).toBeFocused();
    await axe(page, "a centred step on a phone");
    await page.locator("[data-tour-next]").click();
    await at(page, "overview");
    await expect(card(page)).toHaveAttribute("data-tour-mode", "anchored");
    await expect(page.locator("[data-tour-dialog]")).toBeInViewport();
    const wide = await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
            .filter((e) => e.getBoundingClientRect().right > 391)
            .filter((e) => {
                for (let p = e.parentElement; p && p !== document.body; p = p.parentElement)
                    if (getComputedStyle(p).overflowX !== "visible") return false;
                return true;
            })
            .slice(0, 5)
            .map((e) => `${e.tagName}.${e.className}`.slice(0, 160)),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth), wide.join("\n")).toBeLessThanOrEqual(390);
    await shot(page, "7-phone");
});

test("after the tour, account setup: notifications, appearance, then the workspace's own setup", async ({ page, admin, baseURL }) => {
    const username = await newcomer(admin, baseURL as string);
    await signInPage(page, username, PASSWORD);
    await page.goto("/");
    await at(page, "welcome");
    await page.getByRole("button", { name: "Skip tour" }).click();

    const setup = page.getByTestId("setup-dialog");
    await expect(setup.getByRole("heading", { name: `Welcome to Triagent, ${username}` })).toBeVisible();
    await axe(page, "account setup");
    await expect(setup.getByRole("heading", { name: "Notifications", level: 3 })).toBeVisible();
    await setup.getByLabel("Every review in my workspaces").check();
    await setup.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => (await (await page.request.get("/api/v1/me")).json()).notify.scope).toBe("all");
    await setup.getByRole("button", { name: "Next" }).click();
    await expect(setup.getByRole("heading", { name: "Appearance", level: 3 })).toBeVisible();
    await setup.getByLabel("Dark").check();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await setup.getByRole("button", { name: "Next" }).click();
    await setup.getByRole("button", { name: "Set up my personal workspace" }).click();
    await expect.poll(async () => (await tutorialOf(page)).setup).toBe("done");

    // On to the workspace's setup, at its model key; the example project doesn't count as a project.
    await expect(setup.getByRole("heading", { name: "Review model & key", level: 3 })).toBeVisible();
    await expect(setup.getByRole("button", { name: /First project\s*Required/ })).toBeVisible();
    await axe(page, "workspace setup");
});
