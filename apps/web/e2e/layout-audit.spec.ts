// Screenshots of every page, the sign-in pages and the main dialogs at desktop, tablet and phone widths,
// in light and dark mode, for reviewing the layout. Only runs with SCREENSHOT_DIR set:
//   SCREENSHOT_DIR=/tmp/shots pnpm --filter @triagent/web test:e2e layout-audit
// Each width and theme gets a folder of its own (1440-light, 390-dark, …).

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, signInPage, test, unique } from "./fixtures";
import { seedShowcase } from "./showcase";

const dir = process.env.SCREENSHOT_DIR;
const WIDTHS = [1440, 1024, 390] as const;

test.skip(!dir, "set SCREENSHOT_DIR to take screenshots");

async function settle(page: Page) {
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    await page.waitForTimeout(150);
}

for (const theme of ["light", "dark"] as const)
    for (const width of WIDTHS)
        test(`layout audit at ${width}px (${theme})`, async ({ page, admin, baseURL }) => {
            test.setTimeout(180_000);
            const out = path.join(dir as string, `${width}-${theme}`);
            mkdirSync(out, { recursive: true });
            const shot = async (name: string, fullPage = true) => {
                await settle(page);
                await page.screenshot({ path: path.join(out, `${name}.png`), fullPage });
            };
            await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
            await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);

            // Signed out: the front page, sign-in and invite-required.
            await page.goto("/");
            await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
            await page.emulateMedia({ reducedMotion: "reduce" });
            await shot("landing");
            await page.emulateMedia({ reducedMotion: null });
            await page.goto("/no-such-page");
            await expect(page.getByRole("heading").first()).toBeVisible();
            await shot("not-found");
            await page.goto("/sign-in");
            await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
            await shot("auth-sign-in");
            await page.goto("/invite-required");
            await expect(page.getByRole("heading", { name: "You need an invite" })).toBeVisible();
            await shot("auth-invite-required");

            // A new account must choose its own password first.
            const newbie = unique("newbie");
            const created = await admin.post("/api/v1/instance/users", { username: newbie });
            await signInPage(page, newbie, created.password);
            await page.goto("/change-password");
            await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
            await shot("auth-change-password");
            await page.context().clearCookies();

            const s = await seedShowcase(admin, baseURL as string);
            await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
            // A project with nothing in it yet: the first-use states.
            await admin.post(`/api/v1/w/${s.ws}/projects`, { slug: "empty", name: "Nothing yet" });
            const empty = `/w/${s.ws}/p/empty`;
            const pages: [string, string][] = [
                ["workspace-home", `/w/${s.ws}`],
                ["empty-overview", `${empty}/overview`],
                ["empty-issues", `${empty}/issues`],
                ["empty-tasks", `${empty}/tasks`],
                ["empty-files", `${empty}/files`],
                ["empty-branches", `${empty}/branches`],
                ["empty-runs", `${empty}/runs`],
                ["empty-pull-requests", `${empty}/pull-requests`],
                ["empty-activity", `${empty}/activity`],
                ["empty-start-review", `${empty}/start-review`],
                ["issues-no-results", `${s.base}/issues?q=zzzzzz`],
                ["overview", `${s.base}/overview`],
                ["issues", `${s.base}/issues`],
                ["issue-detail", `${s.base}/issues/${s.issueId}`],
                ["tasks", `${s.base}/tasks`],
                ["task-detail", `${s.base}/tasks/top-issues-1`],
                ["tasks-summary", `${s.base}/tasks?tab=summary`],
                ["files", `${s.base}/files`],
                ["branches", `${s.base}/branches`],
                ["compare", `${s.base}/compare?base=main&head=feature%2Fcheckout-redesign`],
                ["runs", `${s.base}/runs`],
                ["run-detail", `${s.base}/runs/${s.runId}`],
                ["pull-requests", `${s.base}/pull-requests`],
                ["analytics", `/w/${s.ws}/analytics`],
                ["activity", `${s.base}/activity`],
                ["agents", `/w/${s.ws}/agents`],
                ["settings-project-general", `${s.base}/settings/general`],
                ["settings-project-automation", `${s.base}/settings/automation`],
                ["settings-project-github", `${s.base}/settings/github`],
                ["settings-projects", `/w/${s.ws}/settings/projects`],
                ["settings-models", `/w/${s.ws}/settings/models`],
                ["settings-model-prices", `/w/${s.ws}/settings/model-prices`],
                ["settings-members", `/w/${s.ws}/settings/members`],
                ["settings-tokens", `/w/${s.ws}/settings/tokens`],
                ["settings-audit", `/w/${s.ws}/settings/audit`],
                ["settings-users", `/w/${s.ws}/settings/users`],
                ["settings-instance-model", `/w/${s.ws}/settings/instance-model`],
                ["settings-instance-workspaces", `/w/${s.ws}/settings/instance-workspaces`],
                ["settings-instance-reviews", `/w/${s.ws}/settings/instance-reviews`],
                ["settings-github-app", `/w/${s.ws}/settings/github-app`],
                ["settings-notifications", `/w/${s.ws}/settings/notifications`],
                ["settings-password", `/w/${s.ws}/settings/password`],
                ["settings-appearance", `/w/${s.ws}/settings/appearance`],
                ["settings-tutorial", `/w/${s.ws}/settings/tutorial`],
            ];
            for (const [name, url] of pages) {
                await page.goto(url);
                // On a phone, an open issue or task replaces the list and its h1.
                await expect(page.locator("main").getByRole("heading").first()).toBeVisible();
                await shot(name);
            }

            // The provider form's fields depend on the provider: an API, an AWS region and two keys, an endpoint, a URL.
            for (const [name, label] of [
                ["openai", "OpenAI"],
                ["bedrock", "Amazon Bedrock"],
                ["azure", "Azure OpenAI"],
                ["custom", "Custom (OpenAI-compatible)"],
            ]) {
                await page.goto(`/w/${s.ws}/settings/models`);
                await page.getByLabel("Add a provider").selectOption({ label });
                await page.getByRole("button", { name: "Add provider" }).click();
                await expect(page.getByTestId("provider-detail")).toBeVisible();
                await shot(`settings-models-${name}`);
            }

            // Dialogs and popovers, over the page that opens them (the viewport, as a phone's dialog is fixed).
            const dialog = async (name: string, open: () => Promise<void>, role: "dialog" | "alertdialog" = "dialog") => {
                await open();
                await expect(page.getByRole(role).first()).toBeVisible();
                await shot(name, false);
                await page.keyboard.press("Escape");
                await expect(page.getByRole(role)).toHaveCount(0);
            };
            await page.goto(`${s.base}/start-review`);
            await expect(page.getByRole("heading", { level: 1, name: "Start a review" })).toBeVisible();
            await shot("start-review");
            // The models, open: on Start a review, and a kind's own set in the project's settings.
            await page.getByRole("button", { name: "Change the models" }).click();
            await expect(page.getByRole("group", { name: "Models for this review" })).toBeVisible();
            await shot("start-review-models");
            await page.goto(`${s.base}/settings/automation`);
            await page.getByRole("switch", { name: "Use different models for pull requests" }).click();
            await expect(page.getByRole("group", { name: "Models for pull requests" })).toBeVisible();
            await shot("settings-project-automation-models");
            await page.goto(`${s.base}/branches`);
            await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
            await dialog("dialog-history", () => page.getByRole("button", { name: "History of main" }).click());
            await dialog("dialog-move-branch", () => page.getByRole("button", { name: "Move main" }).click());
            await dialog(
                "dialog-delete-branch",
                () => page.getByRole("button", { name: "Delete feature/checkout-redesign" }).click(),
                "alertdialog",
            );
            await page.goto(`${s.base}/issues/${s.issueId}`);
            await expect(page.getByTestId("issue-panel")).toBeVisible();
            await dialog("dialog-duplicate", () => page.getByRole("button", { name: "Mark as a duplicate…" }).click());
            if (width >= 1024) {
                await page.getByRole("button", { name: "File, assignee, flags" }).click();
                await expect(page.getByRole("dialog")).toBeVisible();
                await shot("popover-other-filters", false);
                await page.keyboard.press("Escape");
            }
            await page.goto(`${s.base}/settings/general`);
            await dialog("dialog-delete-project", () => page.getByRole("button", { name: "Delete project" }).click(), "alertdialog");
            await page.goto(`/w/${s.ws}/settings/models`);
            await dialog("dialog-model-picker", () => page.getByRole("button", { name: "Browse OpenRouter models" }).click());
            await page.goto(`${s.base}/overview`);
            await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
            if (width < 768) {
                // On a phone the rail is a sheet: the pickers are inside it.
                await page.getByRole("button", { name: "Show or hide the sidebar" }).click();
                await expect(page.getByRole("dialog")).toBeVisible();
                await shot("sidebar-mobile", false);
            }
            await page.getByRole("button", { name: /Workspace/ }).click();
            await page.getByRole("menuitem", { name: /Create an organisation/ }).click();
            await expect(page.getByRole("dialog", { name: "Create an organisation" })).toBeVisible();
            await shot("dialog-create-organisation", false);
        });
