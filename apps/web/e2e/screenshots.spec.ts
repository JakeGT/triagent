// Screenshots of the main pages for reviews of the design. Only runs with SCREENSHOT_DIR set:
//   SCREENSHOT_DIR=/tmp/shots pnpm --filter @triagent/web test:e2e screenshots

import path from "node:path";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, issuesOf, seedProject, signInPage, test } from "./fixtures";

const dir = process.env.SCREENSHOT_DIR;

test.skip(!dir, "set SCREENSHOT_DIR to take screenshots");

for (const theme of ["light", "dark"] as const) {
    test(`screenshots (${theme})`, async ({ page, admin }) => {
        const { ws, project } = await seedProject(admin);
        const issues = await issuesOf(admin, ws, project);
        // Some triage, so the pages have something to show.
        const [first, second, third] = issues;
        await admin.patch(`/api/v1/w/${ws}/p/${project}/issues/${first?.id}?branch=main`, {
            status: "in_progress",
            assignee: "admin",
            note: "Switching to a parameterised query.",
        });
        await admin.patch(`/api/v1/w/${ws}/p/${project}/issues/${second?.id}?branch=main`, { severity: "medium" });
        await admin.patch(`/api/v1/w/${ws}/p/${project}/issues/${third?.id}?branch=main`, { status: "resolved" });
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);

        const shot = async (name: string) => {
            await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
            await page.waitForTimeout(300);
            await page.screenshot({ path: path.join(dir as string, `${name}-${theme}.png`) });
        };
        const base = `/w/${ws}/p/${project}`;
        await page.goto(`${base}/issues`);
        await expect(page.getByTestId("issues-summary")).toHaveText(/^10 issues/);
        await shot("issues");
        await page.goto(`${base}/issues/${first?.id}`);
        await expect(page.getByTestId("issue-panel")).toBeVisible();
        await shot("issue-detail");
        await page.goto(`${base}/overview`);
        await shot("overview");
        await page.goto(`${base}/tasks/top-issues-1`);
        await shot("tasks");
        await page.goto(`${base}/branches`);
        await shot("branches");
        await page.goto(`/w/${ws}/settings/tokens`);
        await shot("settings-tokens");
        await page.goto(`${base}/settings/github`);
        await shot("settings-github");
        await page.goto(`/w/${ws}/agents`);
        await shot("agents");

        // A phone: the rail becomes a menu, and an open issue replaces the list.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${base}/issues`);
        await expect(page.getByTestId("issues-summary")).toHaveText(/^10 issues/);
        await shot("mobile-issues");
        await page.goto(`${base}/issues/${first?.id}`);
        await shot("mobile-issue-detail");
    });
}
