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

for (const theme of ["light", "dark"] as const) {
    test(`project pages in ${theme} mode`, async ({ page, admin }) => {
        // Axe takes a second or two a page; one test per page would sign in too often (sessions are capped).
        test.slow();
        const { ws, project } = await seedProject(admin);
        const [issue] = await issuesOf(admin, ws, project);
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        const base = `/w/${ws}/p/${project}`;
        for (const path of [
            "/overview",
            "/issues",
            `/issues/${issue?.id}`,
            "/tasks",
            "/tasks/top-issues-1",
            "/tasks?tab=summary",
            "/files",
            "/branches",
            "/compare",
            "/activity",
        ]) {
            await page.goto(base + path);
            await expect(page.locator("html")).toHaveClass(new RegExp(theme));
            await check(page, `${path} (${theme})`);
        }
    });
}

test("agents and settings pages", async ({ page, admin }) => {
    test.slow();
    const { ws, project } = await seedProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    for (const path of [
        "/agents",
        `/p/${project}/start-review`,
        `/p/${project}/settings/general`,
        `/p/${project}/settings/automation`,
        `/p/${project}/settings/github`,
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
    ]) {
        await page.goto(`/w/${ws}${path}`);
        await check(page, path);
    }
});
