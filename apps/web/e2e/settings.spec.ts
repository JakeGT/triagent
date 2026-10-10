// Settings: API tokens shown once, write-only secrets, and what a viewer can and can't do.

import { randomBytes } from "node:crypto";
import { ADMIN_PASSWORD, ADMIN_USER, PASSWORD } from "./constants";
import { Api, addMember, createUser, expect, issuesOf, seedProject, signInPage, test, unique } from "./fixtures";

test("a new API token is shown once, works, and is gone after navigating away", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/tokens`);
    await page.getByLabel("Name").fill("CI uploads");
    await page.getByRole("radio", { name: /\(upload\)$/ }).check();
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
    // A favourite model, so the project's review models have something to choose from.
    await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/openrouter`, { key: `sk-or-v1-${randomBytes(20).toString("hex")}` });
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
    await expect(page.getByRole("group", { name: "For every review" }).getByRole("checkbox").first()).toBeDisabled();
    await expect(page.getByRole("switch", { name: "Use different models for pull requests" })).toBeDisabled();
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
    await expect(page.getByRole("radio", { name: /\(manage\)$/ })).toBeEnabled();
    await page.getByLabel("Acts for").selectOption({ label: `${username} · viewer` });
    await expect(page.getByRole("radio", { name: /\(read\)$/ })).toBeChecked();
    for (const scope of ["write", "upload", "full", "manage"])
        await expect(page.getByRole("radio", { name: new RegExp(`\\(${scope}\\)$`) })).toBeDisabled();
    await expect(page.getByText(`More than ${username} has as viewer.`).first()).toBeVisible();
    await expect(page.getByRole("option", { name: "Nobody" })).toHaveCount(0);
    await page.getByLabel("Name").fill("viewer bot");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByTestId("one-time-reveal")).toBeVisible();
    await expect(page.getByRole("cell", { name: /^viewer bot/ })).toBeVisible();
});

test("time limits are switches: off means no limit, on shows the minutes", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/p/${project}/settings/automation`);
    const review = page.getByRole("switch", { name: "Limit how long a pull request review can run" });
    const scan = page.getByRole("switch", { name: "Limit how long a full scan can run" });
    const stall = page.getByRole("switch", { name: "Limit how long a review can go without output" });
    // A new project: no time limits, and stalled reviews stopped after 30 minutes.
    await expect(review).not.toBeChecked();
    await expect(scan).not.toBeChecked();
    await expect(stall).toBeChecked();
    await expect(page.getByLabel("Review time limit (minutes)")).toHaveCount(0);
    await expect(page.getByLabel("Full scan time limit (minutes)")).toHaveCount(0);
    await expect(page.getByLabel("Minutes without output")).toHaveValue("30");

    await review.click();
    await expect(page.getByLabel("Review time limit (minutes)")).toHaveValue("45");
    await page.getByLabel("Review time limit (minutes)").fill("1000");
    await stall.click();
    await expect(page.getByLabel("Minutes without output")).toHaveCount(0);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Automation settings saved.")).toBeVisible();
    const saved = await admin.get(`/api/v1/w/${ws}/p/${project}/settings/automation`);
    expect([saved.reviewTimeoutMinutes, saved.fullScanTimeoutMinutes, saved.stallMinutes]).toEqual([1000, null, null]);

    await page.reload();
    await expect(review).toBeChecked();
    await expect(page.getByLabel("Review time limit (minutes)")).toHaveValue("1000");
    await expect(stall).not.toBeChecked();
});

test("deleting a project keeps its past reviews in Analytics unless asked to remove them", async ({ page, admin }) => {
    const ws = unique("del");
    await admin.post("/api/v1/workspaces", { slug: ws });
    await seedProject(admin, { ws, project: "kept" });
    await seedProject(admin, { ws, project: "purged" });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    const reviews = async () => (await admin.get(`/api/v1/w/${ws}/analytics`)).reviews.total;
    expect(await reviews()).toBe(2);

    const remove = async (slug: string, purge: boolean) => {
        await page.goto(`/w/${ws}/p/${slug}/settings/general`);
        await page.getByRole("button", { name: "Delete project" }).click();
        const dialog = page.getByRole("alertdialog");
        const also = dialog.getByRole("checkbox", { name: "Also remove this project's past reviews and activity from Analytics" });
        await expect(also).not.toBeChecked();
        if (purge) await also.click();
        await dialog.getByLabel(/to confirm/).fill(slug);
        await dialog.getByRole("button", { name: "Delete project" }).click();
        await expect(page.getByText(/^Project .* deleted\.$/)).toBeVisible();
    };
    await remove("kept", false);
    expect(await reviews()).toBe(2);
    await remove("purged", true);
    expect(await reviews()).toBe(1);
});
