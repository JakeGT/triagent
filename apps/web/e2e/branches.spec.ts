// More than one branch: the branch picker, comparing branches, and moving and deleting a branch.

import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, REPORT, seedProject, signInPage, test } from "./fixtures";

test("switch branch, compare it with the default, then move and delete it", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    // The feature branch fixed the first two findings and has one new one.
    const feature = {
        ...REPORT,
        comments: [
            ...REPORT.comments.slice(2),
            { path: "src/api/login.ts", content: "The login form has no rate limit.", severity: "high", category: "security" },
        ],
    };
    await admin.post(`/api/v1/w/${ws}/p/${project}/reports`, { branch: "feature/login", fileName: "code_review.json", report: feature });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);

    await page.goto(`/w/${ws}/p/${project}/issues`);
    await expect(page.getByTestId("issues-summary")).toHaveText(/^10 issues/);
    await page.getByRole("button", { name: /^Branch/ }).click();
    await page.getByRole("menuitem", { name: /feature\/login/ }).click();
    await expect(page).toHaveURL(/branch=feature%2Flogin/);
    await expect(page.getByTestId("issues-summary")).toHaveText(/^9 issues/);
    await expect(page.getByRole("link", { name: /The login form has no rate limit/ })).toBeVisible();

    await page.getByRole("link", { name: "Compare" }).click();
    await page.getByLabel("Compare with").selectOption("main");
    await page.getByLabel("Branch", { exact: true }).selectOption("feature/login");
    // Choosing branches changes nothing until asked.
    await expect(page).not.toHaveURL(/head=/);
    await page.getByRole("button", { name: "Compare" }).click();
    await expect(page).toHaveURL(/head=feature%2Flogin/);
    await expect(page.getByRole("heading", { name: /New on feature\/login/ })).toContainText("1 finding");
    await expect(page.getByRole("heading", { name: /No longer on feature\/login/ })).toContainText("2 findings");

    await page.getByRole("link", { name: "Branches & reports" }).click();
    const row = page.getByTestId("branch-feature/login");
    await row.getByRole("button", { name: /^Move/ }).click();
    const move = page.getByRole("dialog");
    await move.getByLabel("New branch name").fill("feature/sign-in");
    await move.getByRole("button", { name: /^Move/ }).click();
    const moved = page.getByTestId("branch-feature/sign-in");
    await expect(moved).toBeVisible();

    await moved.getByRole("button", { name: /^Delete/ }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByRole("button", { name: /^Delete/ })).toBeDisabled();
    await confirm.getByRole("textbox").fill("feature/sign-in");
    await confirm.getByRole("button", { name: /^Delete/ }).click();
    await expect(page.getByTestId("branch-feature/sign-in")).toHaveCount(0);
    await expect(page.getByTestId("branch-main")).toBeVisible();
});
