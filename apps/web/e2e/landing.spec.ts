// The landing page at the front door, for everyone signed in or not: its two demos, and
// the same accessibility and content-security checks as the rest of the app.

import AxeBuilder from "@axe-core/playwright";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, signInPage, test } from "./fixtures";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

test("the front door is the landing page, with a way to sign in and back", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("One list");
    await page.getByRole("link", { name: "Sign in" }).first().click();
    await expect(page).toHaveURL(/\/sign-in$/);
    // And the sign-in page's logo leads back.
    await page.getByRole("link", { name: "Triagent" }).click();
    await expect(page).toHaveURL(/^http:\/\/[^/]+\/$/);
});

test("the app itself still asks you to sign in and comes back", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/sign-in\?redirect=/);
});

test("signed in, the front door is still the landing page, with a button to the dashboard", async ({ page }) => {
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("One list");
    // Every way in says so, the footer's too.
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await page.getByRole("link", { name: "Open dashboard" }).first().click();
    await expect(page).toHaveURL(/\/w\//);
});

test("the demo list filters, opens findings and can be triaged by hand or by an agent", async ({ page }) => {
    await page.goto("/");
    const demo = page.getByTestId("try-it");
    await expect(demo.locator("tbody tr")).toHaveCount(8);
    await expect(page.getByTestId("try-progress")).toContainText("0 of 8");

    await demo.getByRole("button", { name: "All 3" }).click();
    await expect(demo.locator("tbody tr")).toHaveCount(2);
    await demo.getByRole("button", { name: "Any model" }).click();
    await demo.getByRole("button", { name: /^High/ }).click();
    await expect(demo.locator("tbody tr")).toHaveCount(2);
    await demo.getByRole("button", { name: /^High/ }).click();

    // By hand.
    await demo.getByRole("button", { name: "The backoff doubles without a ceiling" }).click();
    const panel = page.getByTestId("try-panel");
    await expect(panel.getByRole("heading", { level: 3 })).toHaveText("The backoff doubles without a ceiling");
    await panel.getByRole("button", { name: "Won't fix" }).click();
    await expect(panel).toContainText("You marked it won't fix.");
    await expect(page.getByTestId("try-progress")).toContainText("1 of 8");

    // By an agent: it takes the critical one, and says what it sent.
    await demo.getByRole("button", { name: "Let an agent take the next one" }).click();
    await expect(page.getByTestId("agent-log")).toContainText("claim_next_issue");
    await expect(page.getByTestId("agent-log")).toContainText("ocr-3fa9c1d2");
    await expect(panel).toContainText("An agent resolved it.");
    await expect(page.getByTestId("try-progress")).toContainText("2 of 8");

    await demo.getByRole("button", { name: "Start again" }).click();
    await expect(page.getByTestId("try-progress")).toContainText("0 of 8");
    await expect(page.getByTestId("agent-log")).toHaveCount(0);
});

test("the hero's review can be paused and played, and rests on its last frame with reduced motion", async ({ page }) => {
    await page.goto("/");
    const stage = page.getByTestId("review-stage");
    await stage.getByRole("button", { name: "Pause" }).click();
    await expect(stage.getByRole("button", { name: /^Play/ })).toBeVisible();

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await expect(stage.getByRole("button", { name: "Play again" })).toBeVisible();
    await expect(stage).toContainText("Fixed in");
});

for (const theme of ["light", "dark"] as const) {
    test(`accessibility in ${theme} mode, and no content-security violations`, async ({ page }) => {
        const violations: string[] = [];
        page.on("console", (m) => {
            if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
        });
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        // Reduced motion rests the hero on its last, fullest frame.
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await page.getByTestId("try-it").getByRole("button", { name: "Let an agent take the next one" }).click();
        await expect(page.getByTestId("try-panel")).toContainText("An agent resolved it.");
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
        expect(violations).toEqual([]);
    });
}

test("the page fits a phone without scrolling sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

for (const width of [360, 820, 1440]) {
    test(`nothing in the hero's review spills out of its window at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        // Reduced motion rests it on the last frame, the one with the longest lines.
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        const stage = page.getByTestId("review-stage");
        await expect(stage).toContainText("Fixed in");
        const spills = await stage.evaluate((el) => {
            const box = el.getBoundingClientRect();
            return [...el.querySelectorAll("*")]
                .filter((child) => {
                    const r = child.getBoundingClientRect();
                    return r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5);
                })
                .map((child) => `${child.tagName} ${child.textContent?.slice(0, 40)}`);
        });
        expect(spills).toEqual([]);
        // What belongs on the right (the file of each finding) ends at the same edge on every row.
        const rights = await stage
            .locator("li p:last-child span.font-mono")
            .evaluateAll((els) =>
                els.filter((e) => e.classList.contains("shrink-0")).map((e) => Math.round(e.getBoundingClientRect().right)),
            );
        expect(rights.length).toBe(4);
        expect(new Set(rights).size).toBe(1);
    });
}
