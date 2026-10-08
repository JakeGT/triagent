// Insights: the Analytics page (scope in the URL, charts with a table view), the OpenRouter model picker,
// model prices and the instance pages for model allowances. Data is seeded through the API; OpenRouter's
// catalogue is served by the test (the server runs with it turned off), so nothing leaves the machine.
// With SCREENSHOT_DIR set, it also saves screenshots of these pages.

import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, PASSWORD } from "./constants";
import { type Api, addMember, expect, issuesOf, REPORT, seedProject, signInPage, test, unique } from "./fixtures";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const dir = process.env.SCREENSHOT_DIR;

async function axe(page: Page, what: string) {
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    // Dialogs and toasts fade in: check them once they've arrived, not half-transparent.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const problems = results.violations.map(
        (v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary}`).join("\n  ")}`,
    );
    expect(problems, `accessibility problems on ${what}`).toEqual([]);
}

async function shot(page: Page, name: string) {
    if (!dir) return;
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
}

const CATALOGUE = {
    enabled: true,
    fetchedAt: "2026-10-08T10:00:00.000Z",
    error: null,
    models: [
        {
            id: "anthropic/claude-sonnet-4.5",
            name: "Anthropic: Claude Sonnet 4.5",
            price: { input: 3, output: 15, cacheRead: 0.3 },
            contextLength: 1_000_000,
        },
        {
            id: "deepseek/deepseek-v3",
            name: "DeepSeek: DeepSeek V3",
            price: { input: 0.27, output: 1.1, cacheRead: null },
            contextLength: 128_000,
        },
        { id: "openai/gpt-5", name: "OpenAI: GPT-5", price: { input: 1.25, output: 10, cacheRead: 0.125 }, contextLength: 400_000 },
    ],
};

/** A copy of the fixture report with what OCR writes about its own run. */
function withRun(count: number, tokens: number, model = "anthropic/claude-sonnet-4.5", extra: Record<string, unknown> = {}) {
    return {
        ...REPORT,
        comments: REPORT.comments.slice(0, count),
        llm: { model, provider: "openrouter" },
        summary: {
            total_tokens: tokens,
            input_tokens: Math.round(tokens * 0.85),
            output_tokens: Math.round(tokens * 0.15),
            cache_read_tokens: Math.round(tokens * 0.3),
            files_reviewed: 12,
            elapsed: "3m10s",
        },
        manifest: { execution: { ocr_version: "v1.4.2" } },
        tool_calls: { total: 64, failure: 3, by_tool: { read_file: 40, grep: 18, list_dir: 6 }, failure_by_tool: { grep: 3 } },
        retry_report: { total_requests: 22, retried_requests: 2, failed_requests: 0 },
        ...extra,
    };
}

/** A workspace with reviews on two branches, some triage by a person and by an agent, and a price. */
async function seedInsights(admin: Api) {
    const { ws, project } = await seedProject(admin);
    const base = `/api/v1/w/${ws}/p/${project}`;
    await admin.post(`${base}/reports`, { branch: "main", confirm: true, fileName: "full-scan.json", report: withRun(8, 1_800_000) });
    await admin.post(`${base}/reports`, { branch: "feature/login", fileName: "pr-12.json", report: withRun(4, 420_000, "openai/gpt-5") });
    await admin.post(`${base}/reports`, {
        branch: "feature/login",
        confirm: true,
        fileName: "pr-12.json",
        report: withRun(5, 380_000, "openai/gpt-5", { warnings: [{ type: "review_round_failed", file: "src/a.ts", message: "timeout" }] }),
    });
    const issues = await issuesOf(admin, ws, project);
    const [a, b, c, d] = issues;
    await admin.patch(`${base}/issues/${a?.id}?branch=main`, { status: "resolved", note: "Parameterised the query." });
    await admin.patch(`${base}/issues/${b?.id}?branch=main`, { status: "wont_fix" });
    await admin.patch(`${base}/issues/${c?.id}?branch=main`, { severity: "low" });
    const token = (await admin.post(`/api/v1/w/${ws}/settings/tokens`, { name: "claude-agent", scope: "full" })).token as string;
    const agent = await admin.ctx.fetch(`${base}/issues/${d?.id}?branch=main`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        data: { status: "resolved", note: "Fixed in 4f2a." },
    });
    expect(agent.status()).toBe(200);
    await admin.put(`/api/v1/w/${ws}/settings/model-prices`, {
        model: "anthropic/claude-sonnet-4.5",
        input: 3,
        output: 15,
        cacheRead: 0.3,
    });
    return { ws, project };
}

for (const theme of ["light", "dark"] as const) {
    test(`the Analytics page shows every section, keeps its scope in the URL, and passes axe (${theme})`, async ({ page, admin }) => {
        const { ws, project } = await seedInsights(admin);
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.goto(`/w/${ws}/p/${project}/overview`);
        await page.getByRole("link", { name: "Analytics" }).click();
        await expect(page).toHaveURL(new RegExp(`/w/${ws}/analytics$`));
        await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
        for (const name of ["Reviews", "Findings and backlog", "Triage", "Model and OCR performance"])
            await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();

        const reviews = page.locator("#reviews");
        await expect(reviews.getByText("0 run here, 4 uploaded")).toBeVisible();
        // Only one of the two models has a price.
        await expect(page.getByTestId("unpriced")).toContainText("openai/gpt-5");
        await expect(page.locator("#triage")).toContainText("claude-agent");

        // A chart's figures as a table.
        const chart = page.getByRole("figure", { name: /^Reviews a day/ });
        await expect(chart.getByRole("img")).toHaveAttribute("aria-label", /Reviews a day, by outcome/);
        await chart.getByRole("button", { name: "Table" }).click();
        await expect(chart.getByRole("table")).toBeVisible();
        await expect(chart.getByRole("columnheader", { name: "Partial" })).toBeVisible();
        await chart.getByRole("button", { name: "Chart" }).click();

        // Hovering a column shows its values.
        await chart.getByRole("img").hover({ position: { x: 400, y: 80 } });
        await expect(chart.getByTestId("chart-tooltip")).toBeVisible();

        await axe(page, `analytics (${theme})`);
        await shot(page, `analytics-${theme}`);

        // The scope lives in the URL and survives a reload.
        const scope = page.getByRole("form", { name: "What to show" });
        await scope.getByLabel("Project").selectOption(project);
        await expect(page).toHaveURL(new RegExp(`project=${project}`));
        await scope.getByLabel("Branch").selectOption("feature/login");
        await scope.getByLabel("Range").selectOption("90");
        await expect(page).toHaveURL(/branch=feature%2Flogin/);
        await expect(page).toHaveURL(/days=90/);
        await page.reload();
        await expect(scope.getByLabel("Branch")).toHaveValue("feature/login");
        await expect(scope.getByLabel("Range")).toHaveValue("90");
        await expect(reviews.getByText("0 run here, 2 uploaded")).toBeVisible();
        await expect(page.getByRole("figure", { name: /^Reviews a week/ })).toBeVisible();
    });
}

test("the review model picker lists OpenRouter's models with prices, and fills in the model", async ({ page, admin }) => {
    const { ws } = await seedProject(admin);
    await page.route("**/models/catalogue", (route) => route.fulfill({ json: CATALOGUE }));
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/review-model`);
    await expect(page.getByTestId("instance-key-status")).toContainText("can't use the instance's key");
    await page.getByRole("button", { name: "Browse OpenRouter models" }).click();
    const dialog = page.getByRole("dialog", { name: "OpenRouter models" });
    await expect(dialog.getByRole("status")).toHaveText("3 models match.");
    await dialog.getByLabel("Search models").fill("deep seek");
    await expect(dialog.getByRole("status")).toHaveText("1 model matches.");
    await expect(dialog.getByRole("row", { name: /DeepSeek V3/ })).toContainText("US$0.27");
    await axe(page, "model picker");
    await dialog.getByRole("button", { name: "Choose DeepSeek: DeepSeek V3" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("deepseek/deepseek-v3");
    await page.getByRole("button", { name: "Save model" }).click();
    await expect(page.getByTestId("review-model-status")).toContainText("Not ready");
    expect((await admin.get(`/api/v1/w/${ws}/settings/review-model`)).model).toBe("deepseek/deepseek-v3");
});

test("workspace model prices: set, listed with where each price comes from, and removed", async ({ page, admin }) => {
    const { ws } = await seedInsights(admin);
    await page.route("**/models/catalogue", (route) => route.fulfill({ json: CATALOGUE }));
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/model-prices`);
    await expect(page.getByRole("row", { name: /openai\/gpt-5/ }).first()).toContainText("No price: left out of costs");
    const editor = page.getByTestId("price-editor").first();
    await editor.getByLabel("Model").fill("openai/gpt-5");
    await editor.getByRole("button", { name: "Use OpenRouter's price" }).click();
    await expect(editor.getByLabel("Input (US$ per million)")).toHaveValue("1.25");
    await editor.getByLabel("Output (US$ per million)").fill("abc");
    await editor.getByRole("button", { name: "Save price" }).click();
    await expect(editor.getByRole("alert")).toContainText("The output price must be a number");
    await editor.getByLabel("Output (US$ per million)").fill("10");
    await editor.getByRole("button", { name: "Save price" }).click();
    await expect(page.getByRole("row", { name: /openai\/gpt-5/ }).first()).toContainText("This workspace");
    await axe(page, "model prices");
    await editor.getByRole("button", { name: "Remove the price of openai/gpt-5" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove price" }).click();
    await expect(page.getByRole("row", { name: /openai\/gpt-5/ }).first()).toContainText("No price");
});

test("instance admins set the instance key and give a workspace a monthly allowance, which it then sees", async ({ page, admin }) => {
    const { ws } = await seedProject(admin);
    const other = unique("org");
    await admin.post("/api/v1/workspaces", { slug: other, name: `Allowance ${other}` });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);

    await page.goto(`/w/${ws}/settings/instance-model`);
    const field = page.getByTestId("secret-field").first();
    await field.getByLabel("OpenRouter instance key").fill("sk-or-v1-instance-e2e-key-wxyz");
    await field.getByRole("button", { name: "Save" }).click();
    await expect(field).toContainText("ends …wxyz");
    expect(await page.content()).not.toContain("instance-e2e-key");
    await expect(page.getByTestId("instance-model-status")).toContainText("Ready");
    await axe(page, "instance model key");

    await page.getByRole("link", { name: "Workspaces" }).click();
    await page.getByLabel("Find a workspace").fill(other);
    const row = page.getByTestId(`grant-${other}`);
    await row.getByLabel(`Monthly tokens for Allowance ${other}`).fill("lots");
    await row.getByRole("button", { name: /Allow/ }).click();
    await expect(row.getByRole("alert")).toContainText("at least 1,000");
    await row.getByLabel(`Monthly tokens for Allowance ${other}`).fill("2m");
    await row.getByRole("button", { name: /Allow/ }).click();
    await expect(row.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "0 of 2,000,000 tokens used");
    await expect(row).toContainText("0 of 2M used");
    await axe(page, "instance workspaces");
    await page.getByLabel("Find a workspace").fill("");
    await shot(page, "instance-grants");

    // The workspace sees its allowance, and reviews would use the instance key.
    await page.goto(`/w/${other}/settings/review-model`);
    await expect(page.getByTestId("instance-key-status")).toContainText("for up to 2,000,000 tokens a month");
    await expect(page.getByTestId("instance-key-status")).toContainText("Reviews use it now");
    await expect(page.getByTestId("review-model-status")).toContainText("through the instance's key");

    // Removing the allowance.
    await page.goto(`/w/${ws}/settings/instance-workspaces`);
    await page.getByLabel("Find a workspace").fill(other);
    await page
        .getByTestId(`grant-${other}`)
        .getByRole("button", { name: /Remove/ })
        .click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove allowance" }).click();
    await expect(page.getByTestId(`grant-${other}`).getByRole("progressbar")).toHaveCount(0);
    expect((await admin.get(`/api/v1/w/${other}/settings/model-allowance`)).granted).toBe(false);
});

test("the instance pages are for instance admins only", async ({ page, admin, baseURL }) => {
    const { ws } = await seedProject(admin);
    const member = await addMember(admin, baseURL as string, ws, "admin");
    await member.api.ctx.dispose();
    await signInPage(page, member.username, PASSWORD);
    await page.goto(`/w/${ws}/settings/instance-workspaces`);
    await expect(page.getByText("Only instance administrators can manage allowances.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Instance model key" })).toHaveCount(0);
    const res = await page.request.get("/api/v1/instance/workspaces");
    expect(res.status()).toBe(403);
});
