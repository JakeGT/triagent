// Reviews run with several models: the run page shows each model's own progress while they review at the
// same time, and its log can be narrowed to one model; triage shows which found each finding, filters and
// sorts by agreement, and shows what the other models said. (Choosing the models is in review-models.spec.ts.)

import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, seedProject, signInPage, test, unique } from "./fixtures";

const GITHUB = process.env.E2E_GITHUB_URL as string;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

async function fakeGithub(what: string, body: unknown): Promise<void> {
    const res = await fetch(`${GITHUB}/_fake/${what}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fake ${what}: ${res.status} ${await res.text()}`);
}

async function axe(page: Page, what: string) {
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    // Toasts fade in and badges change colour: check them once they've arrived, not half-transparent.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const problems = results.violations.map(
        (v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary}`).join("\n  ")}`,
    );
    expect(problems, `accessibility problems on ${what}`).toEqual([]);
}

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

for (const theme of ["light", "dark"] as const) {
    test(`a review with three models, live: a row for each model, and the log for one of them (${theme})`, async ({ page, admin }) => {
        test.slow();
        const ws = unique("par");
        const repo = `acme/${ws}`;
        await fakeGithub("git-repo", { fullName: repo, files: { "src/app.ts": "export const app = 1;\n", "README.md": "# App\n" } });
        const token = `github_pat_${randomBytes(16).toString("hex")}`;
        await fakeGithub("pat", { token, login: "octo", repos: [repo] });
        await admin.post("/api/v1/workspaces", { slug: ws, name: `Org ${ws}` });
        await admin.post(`/api/v1/w/${ws}/projects`, { slug: "app", name: "App", repoUrl: `https://github.com/${repo}` });
        await admin.put(`/api/v1/w/${ws}/p/app/settings/github/token`, { token });
        await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/openrouter`, { key: `sk-or-${randomBytes(12).toString("hex")}` });
        // Two that take a few seconds (one known by a nickname) and one that's done at once.
        const ids: string[] = [];
        for (const [model, name] of [
            ["fake/sleep-6", null],
            ["fake/sleep-6-wordy", "Careful"],
            ["fake/model", null],
        ] as const) {
            const out = await admin.post(`/api/v1/w/${ws}/settings/models/favourites`, {
                provider: "openrouter",
                model,
                ...(name ? { name } : {}),
            });
            ids.push((out.favourites as { id: string; model: string }[]).find((f) => f.model === model)?.id as string);
        }
        const run = await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "full", models: ids });

        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.goto(`/w/${ws}/p/app/runs/${run.id}`);
        const panel = page.getByTestId("run-panel");

        // While it runs: a row for each model with its own progress, and the review's on top.
        const rows = panel.getByTestId("run-model-row");
        await expect(rows).toHaveCount(3, { timeout: 15_000 });
        await expect(rows.nth(0)).toContainText(/^fake\/sleep-6 Reviewing · 2 files · round 1\/2 · \d+s so far$/, { timeout: 15_000 });
        await expect(rows.nth(1)).toContainText(/^Careful Reviewing · 2 files · round 1\/2 · \d+s so far$/);
        await expect(rows.nth(2)).toContainText(/^fake\/model Finished · 2 files · took \ds$/);
        await expect(panel.getByTestId("run-progress")).toContainText("Reviewing with 3 models (1 finished)");
        await expect(panel.getByTestId("run-models-chosen")).toHaveText("Chosen for this review.");

        // The log: every model's lines under its label, or one model's alone.
        const log = panel.getByTestId("run-log");
        const filter = panel.getByRole("group", { name: "Log lines to show" });
        await expect(filter.getByRole("button")).toHaveText(["All lines", "fake/sleep-6", "Careful", "fake/model"]);
        await expect(filter.getByRole("button", { name: "All lines" })).toHaveAttribute("aria-pressed", "true");
        await expect(log).toContainText("[triagent] Reviewing with 3 models at once: fake/sleep-6, Careful, fake/model.");
        await expect(log).toContainText("[Careful] [fake-ocr] args: scan");
        await expect(log).toContainText("[fake/model] [triagent] Finished.");
        await axe(page, `a review with three models, running (${theme})`);

        await filter.getByRole("button", { name: "Careful" }).click();
        await expect(filter.getByRole("button", { name: "Careful" })).toHaveAttribute("aria-pressed", "true");
        await expect(log).toContainText("[Careful] [fake-ocr] args: scan");
        await expect(log).not.toContainText("[fake/model]");
        await expect(log).not.toContainText("[fake/sleep-6]");
        await expect(log).not.toContainText("[triagent] Reviewing with 3 models");
        const shown = await log.locator("div").allTextContents();
        expect(shown.length).toBeGreaterThan(3);
        expect(shown.every((l) => l.startsWith("[Careful] "))).toBe(true);
        await axe(page, `one model's log lines (${theme})`);
        await filter.getByRole("button", { name: "All lines" }).click();
        await expect(log).toContainText("[fake/model] [triagent] Finished.");

        // Finished: how each model went.
        await expect(panel.getByText("Done", { exact: true })).toBeVisible({ timeout: 30_000 });
        const done = panel.getByTestId("run-models").getByRole("listitem");
        await expect(done).toHaveCount(3);
        await expect(done.nth(1)).toContainText(/^Careful 2 findings, [\d,]+ tokens, \ds$/);
        await expect(panel.getByTestId("run-model-row")).toHaveCount(0);
        await filter.getByRole("button", { name: "fake/sleep-6" }).click();
        await expect(log).toContainText("[fake/sleep-6] [triagent] Finished.");
        await expect(log).not.toContainText("[Careful]");
        for (const width of [390, 1400]) {
            await page.setViewportSize({ width, height: 900 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth), `width at ${width}px`).toBeLessThanOrEqual(width);
        }
        await axe(page, `a review with three models, finished (${theme})`);
    });
}
