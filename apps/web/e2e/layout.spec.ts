// The layout rules the form primitives promise (src/components/field.tsx): fields side by side line their
// controls up whatever their labels and descriptions say, every label and description is tied to its
// control, and no page is wider than a phone's screen.

import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, REPORT, seedProject, signInPage, test } from "./fixtures";

/**
 * For each line of fields side by side (a row of four may wrap onto two lines): the top edge of each
 * control, and of the line's buttons.
 */
async function rowTops(page: Page) {
    return page.locator("[data-field-row]").evaluateAll((rows) =>
        rows
            .filter((row) => (row as HTMLElement).offsetParent !== null)
            .flatMap((row) => {
                const lines = new Map<number, number[]>();
                for (const item of row.querySelectorAll(":scope > *")) {
                    const control = item.querySelector(":scope > [data-field-control], :scope > [data-field-actions]");
                    if (!control) continue;
                    const line = Math.round(item.getBoundingClientRect().top);
                    lines.set(line, [...(lines.get(line) ?? []), Math.round(control.getBoundingClientRect().top * 10) / 10]);
                }
                return [...lines.values()].map((tops) => ({ row: row.textContent?.slice(0, 60) ?? "", tops }));
            }),
    );
}

async function expectAligned(page: Page, what: string) {
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    const rows = await rowTops(page);
    expect(rows.length, `rows of fields on ${what}`).toBeGreaterThan(0);
    for (const { row, tops } of rows) {
        const spread = Math.max(...tops) - Math.min(...tops);
        expect(spread, `controls' top edges in "${row}" on ${what}: ${tops.join(", ")}`).toBeLessThanOrEqual(1);
    }
}

/** Every field's label names its control, and its description and error describe it. */
async function expectWired(page: Page, what: string) {
    const problems = await page.locator("[data-field]").evaluateAll((fields) =>
        fields.flatMap((field) => {
            const label = field.querySelector(":scope > label");
            const id = label?.getAttribute("for");
            const control = id ? document.getElementById(id) : null;
            if (!control) return [`no control for the label "${label?.textContent}"`];
            const describedBy = (control.getAttribute("aria-describedby") ?? "").split(" ");
            return [...field.querySelectorAll('[id$="-hint"], [id$="-error"]')]
                .filter((d) => !describedBy.includes(d.id))
                .map((d) => `"${label?.textContent}" isn't described by "${d.textContent}"`);
        }),
    );
    expect(problems, `labels and descriptions on ${what}`).toEqual([]);
}

test("fields side by side line up, and are wired to their labels and descriptions", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await admin.post(`/api/v1/w/${ws}/p/${project}/reports`, { branch: "feature/login", fileName: "pr.json", report: REPORT });
    await admin.put(`/api/v1/w/${ws}/settings/model-prices`, {
        model: "anthropic/claude-sonnet-4.5",
        input: 3,
        output: 15,
        cacheRead: null,
    });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    for (const width of [1440, 1024, 700]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of [
            "/settings/tokens",
            "/settings/projects",
            "/settings/members",
            "/settings/users",
            "/settings/model-prices",
            `/p/${project}/branches`,
            `/p/${project}/compare`,
            `/p/${project}/activity`,
            "/analytics",
        ]) {
            await page.goto(`/w/${ws}${path}`);
            await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
            await expectAligned(page, `${path} at ${width}px`);
            await expectWired(page, path);
        }
    }
});

test("the review model form lines up for every kind of provider", async ({ page, admin }) => {
    const { ws } = await seedProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    for (const width of [1440, 700]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of ["/settings/review-model", "/settings/instance-model"]) {
            await page.goto(`/w/${ws}${path}`);
            for (const label of ["OpenAI", "Amazon Bedrock", "Azure OpenAI", "Custom (OpenAI-compatible)"]) {
                await page.getByLabel("Provider").selectOption({ label });
                await expectAligned(page, `${path} with ${label} at ${width}px`);
                await expectWired(page, `${path} with ${label}`);
            }
        }
    }
});

test("no page is wider than a phone", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    // Long paths, as the tutorial's example project has.
    await admin.post(`/api/v1/w/${ws}/p/${project}/reports`, {
        branch: "main",
        confirm: true,
        fileName: "long.json",
        report: {
            ...REPORT,
            comments: REPORT.comments.map((c, i) => ({ ...c, path: `src/checkout/components/CheckoutFormStep${i}.tsx` })),
        },
    });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [
        `/p/${project}/overview`,
        `/p/${project}/issues`,
        `/p/${project}/tasks`,
        `/p/${project}/files`,
        `/p/${project}/branches`,
        `/p/${project}/compare`,
        `/p/${project}/runs`,
        `/p/${project}/pull-requests`,
        `/p/${project}/activity`,
        "/analytics",
        "/agents",
        `/p/${project}/settings/general`,
        `/p/${project}/settings/automation`,
        "/settings/tokens",
        "/settings/members",
        "/settings/model-prices",
        "/settings/users",
        "/settings/instance-workspaces",
    ]) {
        await page.goto(`/w/${ws}${path}`);
        await expect(page.locator("main").getByRole("heading").first()).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(wide, `width of ${path}`).toBeLessThanOrEqual(390);
    }
    // Long model ids among Bedrock's suggestions.
    await page.goto(`/w/${ws}/settings/review-model`);
    await page.getByLabel("Provider").selectOption({ label: "Amazon Bedrock" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth), "width of the review model page").toBeLessThanOrEqual(390);
});
