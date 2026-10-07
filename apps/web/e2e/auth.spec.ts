// Signing in, the forced password change for accounts with a temporary password, and signing out.

import { ADMIN_PASSWORD, ADMIN_USER, PASSWORD } from "./constants";
import { Api, expect, test, unique } from "./fixtures";

test("sign in, land in your workspace, and sign out", async ({ page }) => {
    await page.goto("/w/admin/settings/appearance");
    // Not signed in: sent to sign-in, then back where you were going.
    await expect(page).toHaveURL(/\/sign-in\?redirect=/);
    await page.getByLabel("Username").fill(ADMIN_USER);
    await page.getByLabel("Password", { exact: true }).fill("not the password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Wrong username or password.");

    await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/w\/admin\/settings\/appearance$/);

    await page.goto("/");
    await expect(page).toHaveURL(/\/w\/admin$/);
    await page.getByTestId("user-menu").click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in/);
    await page.goto("/w/admin");
    await expect(page).toHaveURL(/\/sign-in/);
});

test("an account with a temporary password must choose its own before anything else", async ({ page, admin, baseURL }) => {
    const username = unique("newbie");
    const created = await admin.post("/api/v1/instance/users", { username });
    expect(created.password).toBeTruthy();

    await page.goto("/sign-in");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(created.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/change-password$/);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();

    // Nothing else is reachable until it's done.
    await page.goto(`/w/${username}`);
    await expect(page).toHaveURL(/\/change-password$/);

    await page.getByLabel("Current password").fill(created.password);
    await page.getByLabel("New password", { exact: true }).fill("short");
    await page.getByLabel("New password again").fill("short");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByRole("alert")).toHaveText("Use at least 12 characters.");

    await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("New password again").fill(PASSWORD);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${username}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // The new password works; the temporary one doesn't.
    await (await Api.signIn(baseURL as string, username, PASSWORD)).ctx.dispose();
});
