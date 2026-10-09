// Settings: API tokens shown once, write-only secrets, and what a viewer can and can't do.

import { ADMIN_PASSWORD, ADMIN_USER, PASSWORD } from "./constants";
import { Api, addMember, createUser, expect, issuesOf, seedProject, signInPage, test, unique } from "./fixtures";

test("a new API token is shown once, works, and is gone after navigating away", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/tokens`);
    await page.getByLabel("Name").fill("CI uploads");
    await page.getByRole("radio", { name: /^upload/ }).check();
    await page.getByRole("button", { name: "Create token" }).click();

    const reveal = page.getByTestId("one-time-reveal");
    await expect(reveal).toBeVisible();
    await expect(reveal).toContainText("it won't be shown again");
    const token = await reveal.getByLabel("New API token").inputValue();
    expect(token).toMatch(/^tri_/);

    // A live update (another person's change) doesn't redraw or drop it.
    const [issue] = await issuesOf(admin, ws, project);
    await admin.patch(`/api/v1/w/${ws}/p/${project}/issues/${issue?.id}?branch=main`, { status: "in_progress" });
    await page.waitForTimeout(500);
    await expect(reveal.getByLabel("New API token")).toHaveValue(token);

    // It works, with the access it was given.
    const res = await page.request.get(`/api/v1/w/${ws}/projects`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status()).toBe(200);
    await expect(page.getByRole("cell", { name: /^CI uploads/ })).toBeVisible();

    await page.getByRole("link", { name: "Members" }).click();
    await page.goBack();
    await expect(page.getByRole("button", { name: "Create token" })).toBeVisible();
    await expect(page.getByTestId("one-time-reveal")).toHaveCount(0);
    await expect(page.locator(`input[value="${token}"]`)).toHaveCount(0);
});

test("the GitHub token is write-only, and a webhook secret is shown once", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/p/${project}/settings/github`);
    const field = page.getByTestId("secret-field");
    await expect(field).toContainText("Not set");
    await field.getByLabel("GitHub token").fill(`github_pat_${"a1".repeat(20)}wxyz`);
    await field.getByRole("button", { name: "Save" }).click();
    await expect(field).toContainText(/Set by admin on .+, ends …wxyz/);
    // Never shown again, not even in a placeholder.
    await expect(field.locator("input")).toHaveCount(0);
    expect(await page.content()).not.toContain("a1a1a1a1");

    await page.getByRole("button", { name: /Generate/ }).click();
    const reveal = page.getByTestId("one-time-reveal");
    await expect(reveal).toBeVisible();
    expect((await reveal.locator("input").inputValue()).length).toBeGreaterThan(20);
});

test("a viewer sees settings and issues but can't change them", async ({ page, admin, baseURL }) => {
    const { ws, project } = await seedProject(admin);
    const viewer = await addMember(admin, baseURL as string, ws, "viewer");
    await viewer.api.ctx.dispose();
    await signInPage(page, viewer.username, PASSWORD);

    // Issues: no selection, no triage controls, no note box.
    const [issue] = await issuesOf(admin, ws, project);
    await page.goto(`/w/${ws}/p/${project}/issues/${issue?.id}`);
    await expect(page.getByTestId("issue-panel")).toBeVisible();
    await expect(page.getByTestId("triage")).toHaveCount(0);
    await expect(page.getByLabel("Add a note")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Select all issues on this page" })).toHaveCount(0);

    // Settings: values shown, editing disabled, admin-only pages not offered.
    await page.goto(`/w/${ws}/p/${project}/settings/general`);
    await expect(page.getByLabel("Name")).toHaveValue("App");
    await expect(page.getByLabel("Name")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete project" })).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Settings" });
    await expect(nav.getByRole("link", { name: "General" })).toBeVisible();
    for (const hidden of ["GitHub", "API tokens", "Audit log", "Users"])
        await expect(nav.getByRole("link", { name: hidden })).toHaveCount(0);

    await page.goto(`/w/${ws}/p/${project}/settings/automation`);
    await expect(page.getByRole("heading", { name: "Review models" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review with several models" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Save/ })).toHaveCount(0);

    await page.goto(`/w/${ws}/settings/members`);
    await expect(page.getByRole("cell", { name: viewer.username }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Add member/ })).toHaveCount(0);

    // Branches: no upload, move or delete.
    await page.goto(`/w/${ws}/p/${project}/branches`);
    await expect(page.getByRole("heading", { level: 1, name: "Branches & reports" })).toBeVisible();
    await expect(page.getByLabel("Report file")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Move/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);

    // The server agrees.
    const direct = await Api.signIn(baseURL as string, viewer.username, PASSWORD);
    await expect(direct.patch(`/api/v1/w/${ws}/p/${project}/issues/${issue?.id}?branch=main`, { status: "resolved" })).rejects.toThrow(
        /403/,
    );
    await direct.ctx.dispose();
});

test("a token can only have the access of the member it acts for", async ({ page, admin, baseURL }) => {
    const ws = unique("tok");
    await admin.post("/api/v1/workspaces", { slug: ws });
    const username = unique("viewer");
    await createUser(admin, baseURL as string, username);
    await admin.post(`/api/v1/w/${ws}/settings/members`, { username, role: "viewer" });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/tokens`);

    // Acting for you (an owner), every scope; for a viewer, read only.
    await expect(page.getByRole("radio", { name: /^manage/ })).toBeEnabled();
    await page.getByLabel("Acts for").selectOption({ label: `${username} · viewer` });
    await expect(page.getByRole("radio", { name: /^read/ })).toBeChecked();
    for (const scope of ["write", "upload", "full", "manage"])
        await expect(page.getByRole("radio", { name: new RegExp(`^${scope}`) })).toBeDisabled();
    await expect(page.getByText(`More than ${username} has as viewer.`).first()).toBeVisible();
    await expect(page.getByRole("option", { name: "Nobody" })).toHaveCount(0);
    await page.getByLabel("Name").fill("viewer bot");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByTestId("one-time-reveal")).toBeVisible();
    await expect(page.getByRole("cell", { name: /^viewer bot/ })).toBeVisible();
});
