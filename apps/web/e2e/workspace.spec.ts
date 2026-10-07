// From nothing to triage: create an organisation and a project, then upload a report with a preview.

import path from "node:path";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, signInPage, test, unique } from "./fixtures";

test("create an organisation and a project, then upload a report after previewing it", async ({ page }) => {
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto("/");

    const slug = unique("acme");
    await page.getByRole("button", { name: /Workspace/ }).click();
    await page.getByRole("menuitem", { name: /Create an organisation/ }).click();
    const dialog = page.getByRole("dialog", { name: "Create an organisation" });
    await dialog.getByLabel("Name").fill("Acme");
    await dialog.getByLabel("Id").fill(slug);
    await dialog.getByRole("button", { name: "Create organisation" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));
    await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();

    await page.getByRole("link", { name: "Create a project" }).first().click();
    await page.getByLabel("Name").fill("Web app");
    await page.getByLabel("Project id").fill("web");
    await page.getByLabel("Repository URL").fill("https://github.com/acme/web");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/p/web/branches`));

    // Upload: preview first, nothing changes until confirmed.
    await page.getByLabel("Report file").setInputFiles(path.join(import.meta.dirname, "fixtures/report.json"));
    await page.getByRole("button", { name: "Preview upload" }).click();
    await expect(page.getByText(/10 findings|10 issues/).first()).toBeVisible();
    await page.getByRole("button", { name: "Confirm upload" }).click();
    await expect(page.getByRole("cell", { name: /main/ }).first()).toBeVisible();

    await page.getByRole("link", { name: /^Issues/ }).click();
    await expect(page.getByTestId("issues-summary")).toHaveText(/^10 issues/);
    await expect(page.getByRole("link", { name: /Issues\s*10/ })).toBeVisible();
});

test("a file that isn't a report is refused before anything changes", async ({ page, admin }) => {
    const ws = unique("org");
    await admin.post("/api/v1/workspaces", { slug: ws });
    await admin.post(`/api/v1/w/${ws}/projects`, { slug: "app" });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/p/app/branches`);
    await page
        .getByLabel("Report file")
        .setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from('{"hello": 1}') });
    await page.getByRole("button", { name: "Preview upload" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /comments/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm upload" })).toHaveCount(0);
});
