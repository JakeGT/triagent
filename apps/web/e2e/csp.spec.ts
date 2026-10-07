// The built app must work under the server's strict Content Security Policy: no inline script, no
// injected <style>. Every test fails on a violation (see fixtures.ts); this one also goes through the
// parts most likely to inject styles: dialogs (scroll lock), menus, tooltips and toasts.

import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, seedProject, signInPage, test } from "./fixtures";

test("the app runs under the server's Content Security Policy", async ({ page, admin }) => {
    const res = await page.goto("/sign-in");
    const csp = res?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("unsafe-inline");

    const { ws, project } = await seedProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/p/${project}/issues`);
    await expect(page.getByRole("heading", { level: 1, name: "Issues" })).toBeVisible();

    // Fonts are self-hosted and load.
    await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Atkinson Hyperlegible Next"'))).toBe(true);

    // A dialog locks scrolling (Radix adds its styles as a constructed stylesheet, which the policy allows).
    await page.getByRole("button", { name: /Workspace/ }).click();
    await page.getByRole("menuitem", { name: /Create an organisation/ }).click();
    await expect(page.getByRole("dialog", { name: "Create an organisation" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute("data-scroll-locked"))).toBe(true);
    await page.keyboard.press("Escape");

    // Static assets are fingerprinted and cached for good; the page itself is revalidated.
    const asset = await page.request.get((await page.locator('script[type="module"]').first().getAttribute("src")) as string);
    expect(asset.headers()["cache-control"]).toContain("immutable");
    expect((await page.request.get(`/w/${ws}`)).headers()["cache-control"]).toBe("no-cache");
});

test("the server serves only the build's files, and the app for its own routes", async ({ request }) => {
    expect((await request.get("/assets/../../package.json")).status()).toBe(404);
    expect((await request.get("/%2e%2e/%2e%2e/package.json")).status()).toBe(404);
    expect((await request.get("/assets/missing.js")).status()).toBe(404);
    expect((await request.get("/api/v1/nothing")).status()).toBe(404);
    const page = await request.get("/w/someone/p/thing/issues");
    expect(page.status()).toBe(200);
    expect(page.headers()["content-type"]).toContain("text/html");
});

test("the CSP guard notices an injected style (so the other tests would too)", async ({ page, cspViolations }) => {
    await page.goto("/sign-in");
    await page.evaluate(() => {
        const style = document.createElement("style");
        style.textContent = "body { outline: 1px solid red; }";
        document.head.append(style);
    });
    await expect.poll(() => cspViolations.length).toBeGreaterThan(0);
    // Expected here: clear it so the guard doesn't fail this test.
    cspViolations.length = 0;
});
