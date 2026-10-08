// Reviews run with several models: a project lists its models, and triage shows which found each
// finding, filters and sorts by agreement, and shows what the other models said.

import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, seedProject, signInPage, test } from "./fixtures";

const finding = (line: number, content: string, also: object[] = [], foundBy = ["model-a", "model-b"]) => ({
    path: "src/shop/cart.ts",
    content,
    severity: "high",
    category: "bug",
    start_line: line,
    end_line: line,
    found_by: foundBy,
    ...(also.length ? { also } : {}),
});

/** A report as the server writes it after merging two models' reviews (domain/merge.ts). */
const MERGED = {
    models: ["model-a", "model-b"],
    project_summary: "",
    comments: [
        finding(10, "The total is computed before the discount is applied.", [
            {
                model: "model-b",
                severity: "critical",
                category: "bug",
                start_line: 11,
                end_line: 11,
                content: "Discounts are ignored in the total.",
            },
        ]),
        finding(40, "Only model B noticed this rounding error.", [], ["model-b"]),
    ],
};

test("triage shows which models found each finding, and filters and sorts by agreement", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await admin.post(`/api/v1/w/${ws}/p/${project}/reports`, { branch: "multi", fileName: "merged.json", report: MERGED, confirm: true });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/p/${project}/issues?branch=multi`);

    const rows = page.getByRole("row");
    await expect(page.getByText("Found by all 2 models")).toBeVisible();
    await expect(page.getByText("Found by 1 of 2")).toBeVisible();

    // Sort: what most models agree on first.
    await page.getByRole("button", { name: "Most urgent first" }).click();
    await page.getByRole("menuitemradio", { name: "Most models agree" }).click();
    await expect(page).toHaveURL(/sort=agreement/);
    await expect(rows.nth(1)).toContainText("The total is computed");

    // Filter: only what both found.
    await page.getByRole("button", { name: "Found by" }).click();
    await page.getByRole("menuitemradio", { name: "All 2 models" }).click();
    await expect(page).toHaveURL(/foundBy=2/);
    await expect(page.getByText("Found by 1 of 2")).toHaveCount(0);
    await expect(rows.filter({ hasText: "The total is computed" })).toHaveCount(1);

    // The issue says who found it, and what the other model said.
    await rows.filter({ hasText: "The total is computed" }).getByRole("link").first().click();
    const found = page.getByTestId("found-by");
    await expect(found).toContainText("Found by 2 models");
    await expect(found).toContainText("model-a, model-b");
    await found.getByText("What model-b said").click();
    await expect(found).toContainText("Discounts are ignored in the total.");
});

test("a project's review models are chosen in its settings", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/openrouter`, { key: `sk-or-v1-${"x".repeat(40)}` });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/p/${project}/settings/automation`);

    await expect(page.getByText(/Reviews use the workspace's model/)).toBeVisible();
    await page.getByRole("button", { name: "Review with several models" }).click();
    const first = page.getByRole("group", { name: /Model 1/ });
    const second = page.getByRole("group", { name: /Model 2/ });
    await first.getByLabel("Model", { exact: true }).fill("vendor/first-model");
    await second.getByLabel("Provider", { exact: true }).selectOption("openrouter");
    await second.getByLabel("Model", { exact: true }).fill("vendor/second-model");
    // The second leads instead.
    await page.getByRole("button", { name: "Move model 2 up" }).click();
    await expect(first.getByLabel("Model", { exact: true })).toHaveValue("vendor/second-model");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Automation settings saved.")).toBeVisible();

    const saved = await admin.get(`/api/v1/w/${ws}/p/${project}/settings/automation`);
    expect(saved.models).toEqual([
        { provider: "openrouter", model: "vendor/second-model" },
        { provider: "openrouter", model: "vendor/first-model" },
    ]);
});
