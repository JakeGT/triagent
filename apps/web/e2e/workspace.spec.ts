// From nothing to triage: create an organisation and a project, then upload a report with a preview.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, signInPage, test, unique } from "./fixtures";

test("create an organisation and a project, then upload a report after previewing it", async ({ page }) => {
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto("/dashboard");

    const slug = unique("acme");
    await page.getByRole("button", { name: /Workspace/ }).click();
    await page.getByRole("menuitem", { name: /Create an organisation/ }).click();
    const dialog = page.getByRole("dialog", { name: "Create an organisation" });
    await dialog.getByLabel("Name").fill("Acme");
    await dialog.getByLabel("Id").fill(slug);
    await dialog.getByRole("button", { name: "Create organisation" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));

    // The new workspace's guided setup opens, at what it needs first: a model to review with.
    const setup = page.getByTestId("setup-dialog");
    await expect(setup.getByRole("heading", { name: "Set up Acme" })).toBeVisible();
    await expect(setup.getByRole("heading", { name: "Models", level: 3 })).toBeVisible();
    await expect(setup.getByTestId("setup-progress")).toHaveText("0 of 2 required steps done.");
    await setup.getByRole("button", { name: "Do this later" }).click();
    await expect(setup.getByRole("heading", { name: "People", level: 3 })).toBeVisible();
    await setup.getByRole("button", { name: "Skip" }).click();

    // Its first project, whose own setup follows.
    await setup.getByLabel("Name").fill("Web app");
    await setup.getByLabel("Project id").fill("web");
    await setup.getByLabel("Repository URL").fill("https://github.com/acme/web");
    await setup.getByRole("button", { name: "Create project" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/p/web/overview`));
    await expect(setup.getByRole("heading", { name: "Set up Web app" })).toBeVisible();
    // The repository is known already, so it starts at connecting GitHub.
    await expect(setup.getByRole("heading", { name: "Connect GitHub", level: 3 })).toBeVisible();
    await expect(setup.getByRole("button", { name: /Repository\s*Done/ })).toBeVisible();
    await setup.getByRole("button", { name: "Finish later" }).click();
    await expect(setup).toHaveCount(0);

    // Finish setup, at the top, brings it back while something required is left.
    const finish = page.getByTestId("finish-setup");
    await expect(finish).toContainText("2");
    await finish.click();
    await expect(setup.getByRole("heading", { name: "Connect GitHub", level: 3 })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(setup).toHaveCount(0);

    await page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Branches & reports" }).click();
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

test("the workspace setup's Models step: connect a provider, and its model is the default; more can be added", async ({ page }) => {
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto("/dashboard");
    const slug = unique("models");
    await page.getByRole("button", { name: /Workspace/ }).click();
    await page.getByRole("menuitem", { name: /Create an organisation/ }).click();
    const dialog = page.getByRole("dialog", { name: "Create an organisation" });
    await dialog.getByLabel("Name").fill("Models Inc");
    await dialog.getByLabel("Id").fill(slug);
    await dialog.getByRole("button", { name: "Create organisation" }).click();

    const setup = page.getByTestId("setup-dialog");
    await expect(setup.getByRole("heading", { name: "Models", level: 3 })).toBeVisible();
    await expect(setup.getByTestId("setup-model-status")).toHaveText("Not ready yet: connect a provider and choose a model.");
    await expect(setup.getByText("Connect a provider above first")).toBeVisible();

    // Connecting OpenRouter (its catalogue is off here, so nothing is fetched): its usual model is the default.
    await setup.getByLabel("Add a provider").selectOption({ label: "OpenRouter" });
    await setup.getByRole("button", { name: "Add provider" }).click();
    const field = setup.getByTestId("provider-detail").getByTestId("secret-field");
    await field.getByLabel("OpenRouter API key").fill(`sk-or-v1-${randomBytes(20).toString("hex")}`);
    await field.getByRole("button", { name: "Save" }).click();
    await expect(setup.getByTestId("setup-model-status")).toContainText("Ready: reviews use");
    await expect(setup.getByTestId("setup-progress")).toHaveText("1 of 2 required steps done.");
    await expect(setup.getByTestId("favourites").getByRole("row")).toHaveCount(2);

    // Another model is offered, not required.
    await expect(setup.getByRole("heading", { name: "Add another model" })).toBeVisible();
    const add = setup.getByTestId("add-favourite");
    await add.getByLabel("Model", { exact: true }).fill("fake/extra");
    await add.getByRole("button", { name: "Add favourite" }).click();
    await expect(setup.getByTestId("favourites").getByRole("row")).toHaveCount(3);
    await expect(setup.getByTestId("setup-progress")).toHaveText("1 of 2 required steps done.");
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
