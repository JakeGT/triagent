// Options for reviews run with several models: on Start a review once more than one model is chosen, in a
// project's settings for reviews that don't choose their own, and what each does that people see.

import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { type Api, expect, signInPage, test, unique } from "./fixtures";
import { fakeGithub } from "./showcase";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

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

async function noSidewaysScroll(page: Page) {
    for (const width of [390, 1400]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth), `width at ${width}px`).toBeLessThanOrEqual(width);
    }
}

/**
 * A workspace whose project is a repository on the fake GitHub, with a key and these models as
 * favourites (the first is the workspace's default). Returns the favourites' ids, in order.
 */
async function reviewable(
    admin: Api,
    models: readonly string[],
    files: Record<string, string> = { "src/app.ts": "export const app = 1;\n" },
) {
    const ws = unique("opt");
    const repo = `acme/${ws}`;
    await fakeGithub("git-repo", { fullName: repo, files });
    const token = `github_pat_${randomBytes(16).toString("hex")}`;
    await fakeGithub("pat", { token, login: "octo", repos: [repo] });
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Org ${ws}` });
    await admin.post(`/api/v1/w/${ws}/projects`, { slug: "app", name: "App", repoUrl: `https://github.com/${repo}` });
    await admin.put(`/api/v1/w/${ws}/p/app/settings/github/token`, { token });
    await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/openrouter`, { key: `sk-or-${randomBytes(12).toString("hex")}` });
    await admin.patch(`/api/v1/w/${ws}/settings/review-model`, { model: models[0] });
    const ids: string[] = [];
    for (const model of models) {
        const have = ((await admin.get(`/api/v1/w/${ws}/models`)).favourites as { id: string; model: string }[]).find(
            (f) => f.model === model,
        );
        const id =
            have?.id ??
            (
                (await admin.post(`/api/v1/w/${ws}/settings/models/favourites`, { provider: "openrouter", model })).favourites as {
                    id: string;
                    model: string;
                }[]
            ).find((f) => f.model === model)?.id;
        ids.push(id as string);
    }
    return { ws, repo, ids };
}

for (const theme of ["light", "dark"] as const) {
    test(`Start a review: agreement options appear with two models, and show on the run and in triage (${theme})`, async ({
        page,
        admin,
    }) => {
        test.slow();
        const { ws } = await reviewable(admin, ["fake/model", "fake/wordy-alarm"]);
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.goto(`/w/${ws}/p/app/start-review?kind=full`);

        // One model: no options to offer.
        const form = page.getByRole("region", { name: "What to review" });
        await expect(form.getByTestId("review-models-chosen")).toHaveText("fake/model");
        await expect(form.getByRole("group", { name: "Options" })).toHaveCount(0);

        await form.getByRole("button", { name: "Change the models" }).click();
        await form.getByRole("checkbox", { name: "fake/wordy-alarm" }).check();
        const options = form.getByRole("group", { name: "Options" });
        const failAt = options.getByRole("checkbox", { name: "Fail the pull request check only for criticals at least 2 models found" });
        const singles = options.getByRole("checkbox", { name: "Mark findings only one model found as lower confidence" });
        await expect(failAt).not.toBeChecked();
        await expect(singles).not.toBeChecked();
        await failAt.check();
        await singles.check();
        // With two models there's nothing to choose: both must have found it.
        await expect(options.getByRole("combobox")).toHaveCount(0);
        await axe(page, `Start a review with options (${theme})`);
        await noSidewaysScroll(page);

        await form.getByRole("button", { name: "Start review" }).click();
        const panel = page.getByTestId("run-panel");
        await expect(panel.getByTestId("run-options")).toContainText(
            "The pull request check fails only for criticals at least 2 models found.",
        );
        await expect(panel.getByTestId("run-options")).toContainText("Findings only one model found are marked as lower confidence.");
        await expect(panel.getByText("Done", { exact: true })).toBeVisible({ timeout: 30_000 });
        await axe(page, `a run with options (${theme})`);

        // Triage: the finding one model found says so, after the others of its severity, and can be filtered.
        await page.goto(`/w/${ws}/p/app/issues?branch=main`);
        const rows = page.getByRole("row");
        await expect(page.getByText("Lower confidence", { exact: true })).toHaveCount(1);
        await expect(rows.filter({ hasText: "thinks this is critical" })).toContainText("Found by 1 of 2");
        await axe(page, `issues with a lower-confidence finding (${theme})`);
        await page.getByRole("button", { name: "More filters" }).click();
        await page.getByLabel("Lower confidence (one model found it)").selectOption("false");
        await page.getByRole("button", { name: "Apply filters" }).click();
        await expect(page).toHaveURL(/lowerConfidence=false/);
        await expect(page.getByText("Lower confidence", { exact: true })).toHaveCount(0);
        await expect(rows.filter({ hasText: "Found by all 2 models" })).toHaveCount(1);
        await rows.filter({ hasText: "Found by all 2 models" }).getByRole("link").first().click();
        await expect(page.getByTestId("found-by")).not.toContainText("lower confidence");
        await page.goto(`/w/${ws}/p/app/issues?branch=main&lowerConfidence=true`);
        await page.getByRole("row").filter({ hasText: "thinks this is critical" }).getByRole("link").first().click();
        await expect(page.getByTestId("found-by")).toContainText("No other model found it, so this review marks it as lower confidence.");
    });
}

test("a project's own options: saved in its settings, and what Start a review begins with", async ({ page, admin }) => {
    const { ws, ids } = await reviewable(admin, ["fake/model", "fake/wordy", "fake/b"]);
    await admin.patch(`/api/v1/w/${ws}/p/app/settings/automation`, { models: { all: ids } });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/p/app/settings/automation`);

    const options = page.getByRole("group", { name: "When a review has several models" });
    const failAt = options.getByRole("checkbox", { name: /^Fail the pull request check only for criticals/ });
    await expect(failAt).not.toBeChecked();
    await failAt.check();
    // A project's reviews can have up to five models: how many must agree is chosen.
    const many = options.getByLabel("How many models must have found it");
    await expect(many.getByRole("option")).toHaveText(["At least 2", "At least 3", "At least 4", "At least 5"]);
    await many.selectOption("3");
    await expect(
        options.getByRole("checkbox", { name: "Fail the pull request check only for criticals at least 3 models found" }),
    ).toBeChecked();
    await axe(page, "a project's options for several models");
    await noSidewaysScroll(page);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Automation settings saved.")).toBeVisible();
    expect((await admin.get(`/api/v1/w/${ws}/p/app/settings/automation`)).options).toEqual({ agreement: { failAt: 3 } });
    await page.reload();
    await expect(options.getByRole("checkbox", { name: /at least 3 models found/ })).toBeChecked();

    // Start a review begins with them, for this project's three models.
    await page.goto(`/w/${ws}/p/app/start-review?kind=full`);
    const form = page.getByRole("region", { name: "What to review" });
    const own = form.getByRole("group", { name: "Options" });
    await expect(own.getByRole("checkbox", { name: /at least 3 models found/ })).toBeChecked();
    await expect(own.getByLabel("How many models must have found it").getByRole("option")).toHaveText(["At least 2 of 3", "All 3"]);
    await expect(own.getByLabel("How many models must have found it")).toHaveValue("3");
});

for (const theme of ["light", "dark"] as const) {
    test(`a model that failed is run again from the review's page, and its findings join the report (${theme})`, async ({
        page,
        admin,
    }) => {
        test.slow();
        const { ws, ids } = await reviewable(admin, ["fake/model", "fake/wordy-extra-fail-once"]);
        const review = await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "full", models: ids });
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.goto(`/w/${ws}/p/app/runs/${review.id}`);
        const panel = page.getByTestId("run-panel");
        await expect(panel.getByText("Partly done", { exact: true })).toBeVisible({ timeout: 30_000 });

        // The model that failed says so, and can be run again; the one that finished has nothing to run.
        const models = panel.getByTestId("run-models").locator("> li");
        await expect(models).toHaveCount(2);
        await expect(models.nth(1)).toContainText("fake/wordy-extra-fail-once failed");
        await expect(models.nth(0).getByRole("button")).toHaveCount(0);
        const again = models.nth(1).getByRole("button", { name: "Run it again: fake/wordy-extra-fail-once" });
        await axe(page, `a review with a model that failed (${theme})`);
        await again.click();
        await expect(page.getByText("Running fake/wordy-extra-fail-once again.")).toBeVisible();

        // Its second attempt is listed under it, and says what it added once it's done.
        const attempt = models.nth(1).getByTestId("run-model-retries").getByRole("link");
        await expect(attempt).toHaveText("Second attempt: Added to the report: 1 new finding, and 1 that another model also found.", {
            timeout: 30_000,
        });
        await expect(again).toHaveCount(0);
        await expect(models.nth(1).getByTestId("run-model-retries")).toContainText("findings have been added already");
        await axe(page, `a review whose model was run again (${theme})`);
        await noSidewaysScroll(page);

        // The attempt has a page of its own, which says what it is and leads back.
        await attempt.click();
        await expect(panel.getByRole("heading", { level: 2 })).toHaveText("fake/wordy-extra-fail-once again: Full scan of main");
        const of = panel.getByTestId("run-rerun-of");
        await expect(of).toContainText("fake/wordy-extra-fail-once in the review it failed in.");
        await expect(of).toContainText("Added to the report: 1 new finding, and 1 that another model also found.");
        await expect(panel.getByText("Second attempt of")).toBeVisible();
        await axe(page, `a model's second attempt (${theme})`);
        await of.getByRole("link", { name: "the review it failed in" }).click();
        await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Full scan of main");

        // Triage has both models' findings now.
        await page.goto(`/w/${ws}/p/app/issues?branch=main`);
        await expect(page.getByText("Found by all 2 models")).toHaveCount(1);
        await expect(page.getByText("Found by 1 of 2")).toHaveCount(1);
    });
}
