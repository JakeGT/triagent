// Signing in through an identity provider (AUTH_MODE=oidc), against the fake provider started by
// playwright.config.ts: the sign-in button and the trip there and back, the "You need an invite" page,
// inviting someone, confirming it's you before changing a secret or creating a token, and signing out at the
// provider.

import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

const PROVIDER = new URL(process.env.E2E_PROVIDER_ISSUER as string).origin;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

const ADMIN = {
    sub: "e2e-admin",
    email: "ada@example.com",
    email_verified: true,
    name: "Ada Admin",
    preferred_username: "ada",
    groups: ["platform-admin"],
};
const KIM = { sub: "e2e-kim", email: "kim@example.com", email_verified: true, name: "Kim Invitee", preferred_username: "kim" };

/** Choose who the provider approves next, and how it spoils their ID token. */
async function provide(request: APIRequestContext, identity: object | null, tamper: object = {}) {
    const res = await request.post(`${PROVIDER}/__control`, { data: { identity, tamper } });
    expect(res.status()).toBe(200);
}

async function accessible(page: Page, what: string) {
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    // A dialog fading in is briefly low-contrast: check what people see once it has.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(
        results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`),
        `accessibility problems on ${what}`,
    ).toEqual([]);
}

/** Sign in from the sign-in page with the provider's button, ending on `landing`. */
async function signIn(page: Page, landing: RegExp) {
    await page.goto("/sign-in");
    await page.getByRole("link", { name: "Sign in with Test ID" }).click();
    await expect(page).toHaveURL(landing);
}

test("sign in with the provider's button and come back to the page you wanted", async ({ page, request }) => {
    await provide(request, ADMIN);
    await page.goto("/w/ada/settings/appearance");
    await expect(page).toHaveURL(/\/sign-in\?redirect=/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    // No password form: only the provider.
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await accessible(page, "the sign-in page");
    await page.getByRole("link", { name: "Sign in with Test ID" }).click();
    await expect(page).toHaveURL(/\/w\/ada\/settings\/appearance$/);
    await expect(page.getByRole("heading", { level: 2, name: "Appearance" })).toBeVisible();

    // Passwords belong to the provider: no Password page. Users lists accounts and instance invites.
    const nav = page.getByRole("navigation", { name: "Settings" });
    await expect(nav.getByRole("link", { name: "Password" })).toHaveCount(0);
    await nav.getByRole("link", { name: "Users" }).click();
    await expect(page.getByRole("cell", { name: /Ada Admin/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Reset password/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Invites" })).toBeVisible();
    await accessible(page, "Users");
});

test("someone without an invite gets nothing, and an invite lets them in", async ({ page, request, browser }) => {
    await provide(request, KIM);
    await signIn(page, /\/invite-required$/);
    await expect(page.getByRole("heading", { name: "You need an invite" })).toBeVisible();
    await expect(page.getByText("Ask the administrator to add your address to the sign-in allowlist.")).toBeVisible();
    await accessible(page, "You need an invite");

    // The admin, in another browser, invites Kim to an organisation as a viewer.
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await provide(request, ADMIN);
    await signIn(admin, /\/w\/ada$/);
    await admin.getByRole("button", { name: /Workspace/ }).click();
    await admin.getByRole("menuitem", { name: /Create an organisation/ }).click();
    const dialog = admin.getByRole("dialog", { name: "Create an organisation" });
    await dialog.getByLabel("Name").fill("Acme");
    await dialog.getByLabel("Id").fill("acme");
    await dialog.getByRole("button", { name: "Create organisation" }).click();
    await expect(admin).toHaveURL(/\/w\/acme$/);
    await admin.goto("/w/acme/settings/members");
    const invites = admin.locator("section", { has: admin.getByRole("heading", { name: "Invites" }) });
    await invites.getByLabel("Email address").fill("kim@example.com");
    await invites.getByLabel("Role").selectOption("viewer");
    await invites.getByRole("button", { name: "Invite" }).click();
    await expect(invites.getByText("Invite ready for kim@example.com")).toBeVisible();
    await expect(invites.getByText("Ask the administrator to add your address to the sign-in allowlist.")).toBeVisible();
    await expect(invites.getByRole("cell", { name: /^kim@example\.com/ })).toBeVisible();
    await accessible(admin, "Members with invites");
    await adminContext.close();

    // Kim tries again and is in, with a personal workspace and the organisation.
    await provide(request, KIM);
    await page.getByRole("link", { name: "Sign in again" }).click();
    await expect(page).toHaveURL(/\/w\/kim$/);
    await page.goto("/w/acme/settings/members");
    await expect(page.getByRole("cell", { name: /Kim Invitee/ })).toBeVisible();
});

test("changing a secret after an old sign-in asks you to confirm it's you, then carries on where you were", async ({ page, request }) => {
    // The provider says Ada authenticated an hour ago (an old single sign-on session).
    await provide(request, ADMIN, { authAgo: 3600 });
    await signIn(page, /\/w\/ada$/);
    await page.goto("/w/ada/settings/review-model");
    const field = page.getByTestId("secret-field").first();
    await field.locator("input").fill("sk-or-e2e-key-0001");
    await field.getByRole("button", { name: "Save" }).click();

    const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Changing secrets, members, API tokens or the workspace needs a recent sign-in");
    await accessible(page, "the confirm-it's-you dialog");

    // This time the provider checks again (a fresh auth_time).
    await provide(request, ADMIN);
    await dialog.getByRole("button", { name: "Sign in with Test ID" }).click();
    await expect(page).toHaveURL(/\/w\/ada\/settings\/review-model$/);
    const again = page.getByTestId("secret-field").first();
    await again.locator("input").fill("sk-or-e2e-key-0001");
    await again.getByRole("button", { name: "Save" }).click();
    await expect(again).toContainText(/Set by Ada Admin on .+, ends …0001/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("creating an API token after an old sign-in asks you to confirm it's you too", async ({ page, request }) => {
    await provide(request, ADMIN, { authAgo: 3600 });
    await signIn(page, /\/w\/ada$/);
    await page.goto("/w/ada/settings/tokens");
    // Reading the list doesn't ask.
    await expect(page.getByRole("button", { name: "Create token" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByLabel("Name").fill("CI uploads");
    await page.getByRole("button", { name: "Create token" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("one-time-reveal")).toHaveCount(0);

    await provide(request, ADMIN);
    await dialog.getByRole("button", { name: "Sign in with Test ID" }).click();
    await expect(page).toHaveURL(/\/w\/ada\/settings\/tokens$/);
    await page.getByLabel("Name").fill("CI uploads");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByTestId("one-time-reveal")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("signing out ends the session here and at the provider, then comes back to sign-in", async ({ page, request }) => {
    await provide(request, ADMIN);
    await signIn(page, /\/w\/ada$/);
    await page.getByTestId("user-menu").click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    // The provider's sign-out page sends people back to the front page, which asks them to sign in.
    await expect(page).toHaveURL(/\/sign-in/);
    await page.goto("/w/ada");
    await expect(page).toHaveURL(/\/sign-in/);
});
