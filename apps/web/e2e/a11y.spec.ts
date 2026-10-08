// Automated accessibility checks (axe, WCAG 2.2 A and AA rules) on every page, in light and dark mode.
// Automated checks catch only part of WCAG; they guard against regressions in what they can see.

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, issuesOf, seedProject, signInPage, test } from "./fixtures";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

async function check(page: Page, what: string) {
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const problems = results.violations.map(
        (v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary}`).join("\n  ")}`,
    );
    expect(problems, `accessibility problems on ${what}`).toEqual([]);
}

test("sign-in page", async ({ page }) => {
    await page.goto("/sign-in");
    await check(page, "sign-in");
});

// One test per page: axe takes a second or two a page, and a loop over every page outgrew the timeout.
const PROJECT_PAGES = [
    "/overview",
    "/issues",
    "/issues/:issue",
    "/tasks",
    "/tasks/top-issues-1",
    "/tasks?tab=summary",
    "/files",
    "/branches",
    "/compare",
    "/activity",
];

for (const theme of ["light", "dark"] as const) {
    for (const path of PROJECT_PAGES) {
        test(`project page ${path} in ${theme} mode`, async ({ page, admin }) => {
            const { ws, project } = await seedProject(admin);
            const [issue] = await issuesOf(admin, ws, project);
            await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
            await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
            await page.goto(`/w/${ws}/p/${project}${path.replace(":issue", issue?.id ?? "")}`);
            await expect(page.locator("html")).toHaveClass(new RegExp(theme));
            await check(page, `${path} (${theme})`);
        });
    }
}

const SETTINGS_PAGES = [
    "/agents",
    "/p/:project/settings/general",
    "/p/:project/settings/automation",
    "/p/:project/settings/github",
    "/settings/projects",
    "/settings/review-model",
    "/settings/members",
    "/settings/tokens",
    "/settings/audit",
    "/settings/users",
    "/settings/notifications",
    "/settings/password",
    "/settings/appearance",
    "/settings/tutorial",
];

for (const path of SETTINGS_PAGES) {
    test(`agents and settings page ${path}`, async ({ page, admin }) => {
        const { ws, project } = await seedProject(admin);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.goto(`/w/${ws}${path.replace(":project", project)}`);
        await check(page, path);
    });
}
