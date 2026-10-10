// Options for reviews run with several models: on Start a review once more than one model is chosen, in a
// project's settings for reviews that don't choose their own, and what each does that people see.

import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { FakeProvider } from "../../../tests/fakes/model-provider";
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
    /** A server of the workspace's own to use instead of OpenRouter (its address), for tests where a model is really asked something. */
    custom: string | null = null,
) {
    const ws = unique("opt");
    const repo = `acme/${ws}`;
    await fakeGithub("git-repo", { fullName: repo, files });
    const token = `github_pat_${randomBytes(16).toString("hex")}`;
    await fakeGithub("pat", { token, login: "octo", repos: [repo] });
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Org ${ws}` });
    await admin.post(`/api/v1/w/${ws}/projects`, { slug: "app", name: "App", repoUrl: `https://github.com/${repo}` });
    await admin.put(`/api/v1/w/${ws}/p/app/settings/github/token`, { token });
    const provider = custom ? "custom" : "openrouter";
    if (custom) await admin.patch(`/api/v1/w/${ws}/settings/review-model/providers/custom`, { url: custom, protocol: "openai" });
    await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/${provider}`, { key: `sk-or-${randomBytes(12).toString("hex")}` });
    await admin.patch(`/api/v1/w/${ws}/settings/review-model`, { provider, model: models[0] });
    const ids: string[] = [];
    for (const model of models) {
        const have = ((await admin.get(`/api/v1/w/${ws}/models`)).favourites as { id: string; model: string }[]).find(
            (f) => f.model === model,
        );
        const id =
            have?.id ??
            (
                (await admin.post(`/api/v1/w/${ws}/settings/models/favourites`, { provider, model })).favourites as {
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
        await page.getByRole("button", { name: "File, assignee, flags" }).click();
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

test.describe("asking a model which findings are the same problem", () => {
    // Every model here is on a server of this test's own (127.0.0.1), so the question never leaves the machine.
    const provider = new FakeProvider();
    test.beforeAll(async () => {
        await provider.start();
    });
    test.afterAll(async () => {
        await provider.stop();
    });

    test("chosen on Start a review with the model to ask; the run says how many it merged", async ({ page, admin }) => {
        test.slow();
        const { ws } = await reviewable(admin, ["fake/model", "fake/apart", "judge-model"], undefined, `${provider.url}/v1`);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.goto(`/w/${ws}/p/app/start-review?kind=full`);
        const form = page.getByRole("region", { name: "What to review" });
        await form.getByRole("button", { name: "Change the models" }).click();
        await form.getByRole("checkbox", { name: "fake/apart" }).check();
        const options = form.getByRole("group", { name: "Options" });
        const ask = options.getByRole("checkbox", { name: "Ask a model whether findings from different models are the same problem" });
        await expect(options.getByLabel("Model to ask")).toHaveCount(0);
        await ask.check();
        // The review's first model unless another is chosen; any favourite can be.
        const who = options.getByLabel("Model to ask");
        await expect(who).toHaveValue("first");
        await expect(who.getByRole("option")).toHaveText([
            "The review's first model that can be (fake/model)",
            "fake/model",
            "fake/apart",
            "judge-model",
        ]);
        await who.selectOption({ label: "judge-model" });
        await axe(page, "Start a review with a model to ask about the findings");
        await noSidewaysScroll(page);

        await form.getByRole("button", { name: "Start review" }).click();
        const panel = page.getByTestId("run-panel");
        await expect(panel.getByTestId("run-options")).toContainText(
            "A model is asked which findings from different models are the same problem.",
        );
        await expect(panel.getByText("Done", { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(panel.getByTestId("run-judge")).toHaveText(
            "judge-model compared 1 pair of findings: 1 the same problem, so there is 1 finding fewer. 320 tokens.",
        );
        await expect(panel.getByTestId("run-log")).toContainText("[triagent] judge-model compared 1 pair: 1 the same problem.");
        await axe(page, "a run that asked a model about its findings");
        expect(provider.requests.at(-1)?.body.model).toBe("judge-model");

        // One finding, found by both, where there would have been two.
        await page.goto(`/w/${ws}/p/app/issues?branch=main`);
        await expect(page.getByText("Found by all 2 models")).toHaveCount(1);
        await expect(page.getByRole("row")).toHaveCount(2);
    });
});

for (const theme of ["light", "dark"] as const) {
    test(`Compare models only: the branch keeps its report, and the comparison has a page of its own (${theme})`, async ({
        page,
        admin,
    }) => {
        test.slow();
        const { ws } = await reviewable(admin, ["fake/model", "fake/wordy-extra", "fake/fail"]);
        // The branch has a report already, from an ordinary review.
        const review = await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "full" });
        await expect.poll(async () => (await admin.get(`/api/v1/w/${ws}/runs/${review.id}`)).status, { timeout: 30_000 }).toBe("done");
        const before = (await admin.get(`/api/v1/w/${ws}/p/app/branches`)).items;

        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.goto(`/w/${ws}/p/app/start-review?kind=full`);
        const form = page.getByRole("region", { name: "What to review" });
        await form.getByRole("button", { name: "Change the models" }).click();
        await form.getByRole("checkbox", { name: "fake/wordy-extra" }).check();
        await form.getByRole("checkbox", { name: "fake/fail" }).check();
        const options = form.getByRole("group", { name: "Options" });
        await expect(options.getByRole("checkbox")).toHaveCount(5);
        await options.getByRole("checkbox", { name: "Compare models only" }).check();
        // What's about the report and the check goes: a comparison touches neither.
        await expect(options.getByRole("checkbox")).toHaveText(["", ""]);
        await expect(options.getByRole("checkbox", { name: "Retry failed models once automatically" })).toHaveCount(0);
        await expect(options.getByRole("checkbox", { name: /^Ask a model/ })).toBeVisible();
        await expect(form.getByRole("button", { name: "Start comparison" })).toBeVisible();
        await axe(page, `Start a review, comparing only (${theme})`);
        await form.getByRole("button", { name: "Start comparison" }).click();

        const panel = page.getByTestId("run-panel");
        await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Comparison: Full scan of main");
        await expect(panel.getByTestId("run-options")).toHaveText(
            "Comparing the models only: the branch's report and triage are left as they are.",
        );
        await expect(panel.getByText("Partly done", { exact: true })).toBeVisible({ timeout: 30_000 });
        const summary = panel.getByTestId("run-comparison");
        await expect(summary).toContainText("2 findings between them, 1 found by more than one model.");
        // A comparison has no report for a failed model's findings to join.
        await expect(panel.getByRole("button", { name: /Run it again/ })).toHaveCount(0);
        await axe(page, `a comparison's run (${theme})`);
        await summary.getByRole("link", { name: "See the comparison" }).click();

        // Its own page: each model's figures, what they found in common, and the findings.
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Comparison: Full scan of main");
        await expect(page.getByTestId("comparison-summary")).toContainText("2 findings between them, 1 found by more than one model.");
        const models = page.getByTestId("comparison-models").getByRole("row");
        await expect(models).toHaveCount(4);
        await expect(models.nth(1)).toHaveText(/^fake\/model101[\d,]+No price\ds$/);
        await expect(models.nth(2)).toHaveText(/^fake\/wordy-extra211[\d,]+No price\ds$/);
        await expect(models.nth(3)).toContainText("Didn't finish: Open Code Review failed");
        const overlap = page.getByTestId("comparison-overlap").getByRole("row");
        await expect(overlap).toHaveText(["Modelfake/modelfake/wordy-extra", "fake/model11", "fake/wordy-extra12"]);
        const findings = page.getByTestId("comparison-findings").getByRole("listitem");
        await expect(findings).toHaveCount(2);
        await expect(findings.nth(0)).toContainText("Found by all 2 models");
        await expect(findings.nth(1)).toContainText("Found by one model");
        // Opened from the keyboard (a toast about the run may be over it).
        await findings.nth(1).locator("summary").press("Enter");
        await expect(findings.nth(1).getByText("Only fake/wordy-extra noticed this.")).toBeVisible();
        await axe(page, `a comparison of models (${theme})`);
        await noSidewaysScroll(page);
        await page.getByLabel("Show", { exact: true }).selectOption({ label: "Found by one model only" });
        await expect(findings).toHaveCount(1);
        await expect(findings).toContainText("fake/wordy-extra");
        await page.getByLabel("Show", { exact: true }).selectOption({ label: "Found by fake/model" });
        await expect(findings).toHaveCount(1);
        await expect(findings).toContainText("Found by all 2 models");

        // The branch is as it was: the one model's report, its one finding.
        expect((await admin.get(`/api/v1/w/${ws}/p/app/branches`)).items).toEqual(before);
        await page.getByRole("link", { name: "Back to the run" }).click();
        await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Comparison: Full scan of main");
        await page.goto(`/w/${ws}/p/app/issues?branch=main`);
        await expect(page.getByRole("row")).toHaveCount(2);
        await expect(page.getByText(/Found by/)).toHaveCount(0);
    });
}

test("a comparison that hasn't finished, and a run that isn't one, say so", async ({ page, admin }) => {
    const { ws, ids } = await reviewable(admin, ["fake/model", "fake/sleep-4"]);
    const review = await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "full", models: [ids[0]] });
    const comparison = await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "full", models: ids, options: { bakeOff: true } });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/p/app/comparisons/${comparison.id}`);
    await expect(page.getByRole("heading", { name: "Nothing to compare yet" })).toBeVisible();
    await expect(page.getByText("This comparison hasn't finished yet. The run's page shows how it's going.")).toBeVisible();
    await axe(page, "a comparison that hasn't finished");
    await page.goto(`/w/${ws}/p/app/comparisons/${review.id}`);
    await expect(page.getByRole("alert")).toContainText("No such comparison");
    await admin.post(`/api/v1/w/${ws}/runs/${comparison.id}/cancel`);
});
