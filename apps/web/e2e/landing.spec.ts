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

test("the hero's reviewers switch on by themselves, and switching one off says what goes with it", async ({ page }) => {
    await page.goto("/");
    const bench = page.getByTestId("bench");
    // It plays itself once: one reviewer after another, each finding flying to its row.
    await expect(page.getByTestId("bench-summary")).toHaveText("14 findings from 3 reviewers, 8 to triage", { timeout: 10_000 });
    await expect(page.getByTestId("bench-list").getByRole("listitem")).toHaveCount(8);
    await expect(page.getByTestId("bench-note-gpt-5")).toHaveText("5 findings, 2 that only it found");

    await bench.getByRole("switch", { name: "mistral-large" }).click();
    await expect(page.getByTestId("bench-summary")).toHaveText("9 findings from 2 reviewers, 6 to triage");
    await expect(page.getByTestId("bench-missed")).toHaveText("With mistral-large off, 2 findings are missed.");
    await expect(page.getByTestId("bench-list").getByRole("listitem")).toHaveCount(6);
    await bench.getByRole("switch", { name: "gpt-5" }).click();
    await bench.getByRole("switch", { name: "claude-sonnet-4.5" }).click();
    await expect(page.getByTestId("bench-summary")).toHaveText("Switch a reviewer on.");
    await expect(page.getByTestId("bench-list").getByRole("listitem")).toHaveCount(0);

    // Back on: its findings land, and nothing is left in the air.
    await bench.getByRole("switch", { name: "gpt-5" }).click();
    await expect(page.getByTestId("bench-summary")).toHaveText("5 findings from 1 reviewer, 5 to triage");
    await expect(bench.locator('[aria-hidden="true"][class*="absolute"]')).toHaveCount(0);
});

test("with less motion asked for, every reviewer is on from the start and the switches still work", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByTestId("bench-summary")).toHaveText("14 findings from 3 reviewers, 8 to triage");
    await page.getByTestId("bench").getByRole("switch", { name: "gpt-5" }).click();
    await expect(page.getByTestId("bench-missed")).toHaveText("With gpt-5 off, 2 findings are missed.");
});

test("three agents sent through the list each take a different issue, and leave the one flagged for discussion", async ({ page }) => {
    await page.goto("/");
    const race = page.getByTestId("agent-race");
    await expect(page.getByTestId("race-log")).toContainText("claude mcp add");
    await race.getByRole("button", { name: "Send them in" }).click();
    await expect(page.getByTestId("race-count")).toHaveText("7 of 8 resolved", { timeout: 20_000 });
    await expect(race.getByRole("listitem").filter({ hasText: "written in three places" })).toContainText("Needs discussion");
    await expect(page.getByTestId("race-log")).toContainText("waiting for a person");
    // Each of the three did some of it.
    for (const agent of ["Claude Code", "Codex", "Cursor"]) await expect(race.getByText(agent).first()).toBeVisible();
    await race.getByRole("button", { name: "Start again" }).click();
    await expect(page.getByTestId("race-count")).toHaveText("0 of 8 resolved");
    await expect(page.getByTestId("race-log")).toContainText("claude mcp add");
});

for (const theme of ["light", "dark"] as const) {
    test(`accessibility in ${theme} mode, and no content-security violations`, async ({ page }) => {
        const violations: string[] = [];
        page.on("console", (m) => {
            if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
        });
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        // Reduced motion starts the hero with every reviewer on.
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

test("the page follows the reader's theme, and the switch says what it gives", async ({ page }) => {
    await page.addInitScript(() => localStorage.getItem("triagent-theme") ?? localStorage.setItem("triagent-theme", "light"));
    await page.goto("/");
    await expect(page.locator("html")).toHaveClass(/light/);
    // Nothing is forced dark on a light page but the part about agents: a picture of a terminal.
    await expect(page.locator(".dark")).toHaveCount(1);
    await expect(page.locator(".dark")).toContainText("claude mcp add");
    const light = await page.locator("header").evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.getByRole("button", { name: "Dark theme" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("button", { name: "Light theme" })).toBeVisible();
    expect(await page.locator("header").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(light);
});

test("the page fits a phone without scrolling sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

// 1280 and 1440: reviewers beside the list. 820: in a row above it. 360: one under another.
for (const width of [360, 820, 1280, 1440]) {
    test(`nothing in the hero spills out of it at ${width}px, and the dots line up`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        const bench = page.getByTestId("bench");
        await expect(page.getByTestId("bench-list").getByRole("listitem")).toHaveCount(8);
        for (const part of [bench, page.getByRole("heading", { level: 1 })]) {
            const spills = await part.evaluate((el) => {
                const box = el.getBoundingClientRect();
                return [...el.querySelectorAll("*")]
                    .filter((child) => {
                        const r = child.getBoundingClientRect();
                        return r.width > 1 && (r.right > box.right + 0.5 || r.left < box.left - 0.5);
                    })
                    .map((child) => `${child.tagName} ${child.textContent?.slice(0, 40)}`);
            });
            expect(spills).toEqual([]);
        }
        // Each row's dots end at the same edge.
        const rights = await page
            .getByTestId("bench-list")
            .locator("li > span:last-child")
            .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
        expect(rights.length).toBe(8);
        expect(new Set(rights).size).toBe(1);
    });
}
