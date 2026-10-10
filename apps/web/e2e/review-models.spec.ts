// Choosing a review's models: a project's sets in its settings (for every review, and for one kind),
// the picker on Start a review (the project's for that kind, changed for one review only), the models
// as chips on runs, and removing a favourite that a project uses.

import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { type Api, expect, seedProject, signInPage, test, unique } from "./fixtures";
import { fakeGithub } from "./showcase";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

/** `dialog`: one is open, so the page behind it (and its heading) is hidden from assistive technology. */
async function axe(page: Page, what: string, dialog = false) {
    if (!dialog) await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    // Toasts fade in and badges change colour: check them once they've arrived, not half-transparent.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const problems = results.violations.map(
        (v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary}`).join("\n  ")}`,
    );
    expect(problems, `accessibility problems on ${what}`).toEqual([]);
}

interface Fav {
    id: string;
    provider: string;
    model: string;
}

/** Add a favourite model, and return its id. */
async function favourite(admin: Api, ws: string, model: string, extra: { provider?: string; name?: string } = {}): Promise<string> {
    const provider = extra.provider ?? "openrouter";
    const out = await admin.post(`/api/v1/w/${ws}/settings/models/favourites`, {
        provider,
        model,
        ...(extra.name ? { name: extra.name } : {}),
    });
    return (out.favourites as Fav[]).find((f) => f.provider === provider && f.model === model)?.id as string;
}

/** A workspace with an OpenRouter key, whose fake/model is the default favourite; returns that favourite's id. */
async function withKey(admin: Api, ws: string): Promise<string> {
    await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/openrouter`, { key: `sk-or-${randomBytes(12).toString("hex")}` });
    await admin.patch(`/api/v1/w/${ws}/settings/review-model`, { model: "fake/model" });
    return (await admin.get(`/api/v1/w/${ws}/models`)).defaultId as string;
}

test("a project's review models: a set for every review, and one for pull requests, from the workspace's favourites", async ({
    page,
    admin,
}) => {
    const { ws, project } = await seedProject(admin);
    const usual = await withKey(admin, ws);
    const fast = await favourite(admin, ws, "vendor/first-model", { name: "Fast" });
    const second = await favourite(admin, ws, "vendor/second-model-with-quite-a-long-name-for-a-phone");
    await favourite(admin, ws, "claude-test", { provider: "anthropic" });
    await favourite(admin, ws, "vendor/third-model");
    await favourite(admin, ws, "vendor/fourth-model");
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/p/${project}/settings/automation`);

    const every = page.getByRole("group", { name: "For every review" });
    await expect(every.getByTestId("models-chosen")).toHaveText("None ticked: reviews use the workspace default, fake/model.");
    await expect(every.getByRole("checkbox")).toHaveCount(6);
    // Each says what it is, and one without its provider's key says so.
    await expect(every).toContainText("vendor/first-model · OpenRouter");
    await expect(every).toContainText("Not ready: add an Anthropic API key in Settings → Models.");
    await expect(every.getByRole("link", { name: "Settings → Models" })).toHaveAttribute("href", `/w/${ws}/settings/models`);

    // The first ticked leads; five at most.
    await every.getByRole("checkbox", { name: /vendor\/second-model/ }).check();
    await every.getByRole("checkbox", { name: "Fast" }).check();
    await expect(every.getByTestId("models-chosen")).toContainText(
        /^Reviews with vendor\/second-model\S* and Fast at the same time: each reviews it/,
    );
    for (const name of ["fake/model", "vendor/third-model", "vendor/fourth-model"]) {
        await expect(every.getByRole("checkbox", { name: "claude-test" })).toBeEnabled();
        await every.getByRole("checkbox", { name }).check();
    }
    await expect(every.getByRole("checkbox", { name: "claude-test" })).toBeDisabled();
    for (const name of ["fake/model", "vendor/third-model", "vendor/fourth-model"]) await every.getByRole("checkbox", { name }).uncheck();
    await expect(every.getByRole("checkbox", { name: "claude-test" })).toBeEnabled();

    // A kind of review can have its own: switched on, it needs at least one.
    await expect(page.getByRole("group", { name: "Models for pull requests" })).toHaveCount(0);
    await page.getByRole("switch", { name: "Use different models for pull requests" }).click();
    const prs = page.getByRole("group", { name: "Models for pull requests" });
    await expect(prs.getByTestId("models-chosen")).toHaveText("None ticked yet: tick the models for pull requests.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert")).toHaveText("Tick at least one model for pull requests, or switch that off.");
    await prs.getByRole("checkbox", { name: "fake/model" }).check();
    await expect(prs.getByTestId("models-chosen")).toHaveText("Reviews with fake/model.");
    await axe(page, "project automation with review models chosen");
    for (const width of [390, 1400]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth), `width at ${width}px`).toBeLessThanOrEqual(width);
    }

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Automation settings saved.")).toBeVisible();
    const api = `/api/v1/w/${ws}/p/${project}/settings/automation`;
    expect((await admin.get(api)).models).toEqual({ all: [second, fast], pr: [usual] });

    // Saved, they're there the next time; switching a kind off goes back to the project's.
    await page.reload();
    await expect(every.getByRole("checkbox", { name: "Fast" })).toBeChecked();
    await expect(page.getByRole("switch", { name: "Use different models for pull requests" })).toBeChecked();
    await expect(page.getByRole("switch", { name: "Use different models for full scans" })).not.toBeChecked();
    await page.getByRole("switch", { name: "Use different models for pull requests" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Automation settings saved.")).toBeVisible();
    expect((await admin.get(api)).models).toEqual({ all: [second, fast] });

    // Removing a favourite the project uses: asked once, then again, naming the project.
    await page.goto(`/w/${ws}/settings/models`);
    await page.getByRole("button", { name: "Remove Fast" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Remove Fast?" });
    await dialog.getByRole("button", { name: "Remove favourite" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("A project's reviews use this model.");
    await expect(dialog.getByTestId("favourite-in-use")).toContainText("App (every review)");
    await axe(page, "removing a favourite in use", true);
    await dialog.getByRole("button", { name: "Remove it from them too" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("favourites").getByRole("row", { name: /Fast/ })).toHaveCount(0);
    expect((await admin.get(api)).models).toEqual({ all: [second] });
});

test("a project's review models say so when the favourites can't be loaded, and can be tried again", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await withKey(admin, ws);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    const models = `**/api/v1/w/${ws}/models`;
    await page.route(models, (route) => route.fulfill({ status: 400, json: { error: "The models can't be listed now." } }));
    await page.goto(`/w/${ws}/p/${project}/settings/automation`);
    const failed = page.getByRole("alert").filter({ hasText: "Couldn't load the models" });
    await expect(failed).toContainText("The models can't be listed now.");
    await expect(page.getByRole("group", { name: "For every review" })).toHaveCount(0);

    await page.unroute(models);
    await failed.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("group", { name: "For every review" }).getByRole("checkbox", { name: "fake/model" })).toBeVisible();
    await expect(failed).toHaveCount(0);
});

test("the default favourite a project uses can't be removed without saying what happens to the project", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    const usual = await withKey(admin, ws);
    const other = await favourite(admin, ws, "fake/other");
    const api = `/api/v1/w/${ws}/p/${project}/settings/automation`;
    await admin.patch(api, { models: { full: [usual, other] } });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/models`);
    await page.getByRole("button", { name: "Remove fake/model" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove fake/model?" });
    await dialog.getByRole("button", { name: "Remove favourite" }).click();
    await expect(dialog.getByTestId("favourite-in-use")).toContainText("App (full scans)");
    await dialog.getByRole("button", { name: "Remove it from them too" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("review-model-status")).toHaveText("Ready: reviews use fake/other through OpenRouter.");
    expect((await admin.get(api)).models).toEqual({ full: [other] });
});

test("Start a review: the models are the project's for that kind of review, and can be changed for one review", async ({ page, admin }) => {
    test.slow();
    const ws = unique("mod");
    const repo = `acme/${ws}`;
    await fakeGithub("git-repo", { fullName: repo, files: { "src/app.ts": "export const app = 1;\n", "README.md": "# App\n" } });
    const token = `github_pat_${randomBytes(16).toString("hex")}`;
    await fakeGithub("pat", { token, login: "octo", repos: [repo] });
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Org ${ws}` });
    await admin.post(`/api/v1/w/${ws}/projects`, { slug: "app", name: "App", repoUrl: `https://github.com/${repo}` });
    await admin.put(`/api/v1/w/${ws}/p/app/settings/github/token`, { token });
    const usual = await withKey(admin, ws);
    const second = await favourite(admin, ws, "fake/model-b", { name: "Second" });
    const wordy = await favourite(admin, ws, "fake/wordy-extra");
    const api = `/api/v1/w/${ws}/p/app`;
    await admin.patch(`${api}/settings/automation`, { models: { full: [wordy, usual] } });
    await fakeGithub("commit", {
        fullName: repo,
        branch: "feature",
        from: "main",
        message: "A feature",
        files: { "src/feature.ts": "// f\n" },
    });
    await fakeGithub("pull", { fullName: repo, number: 8, headRef: "feature", title: "A feature" });
    await admin.post(`${api}/pull-requests/check`);
    const base = `/w/${ws}/p/app`;
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);

    // The Pull requests page says what the next review of one uses.
    await page.goto(`${base}/pull-requests`);
    await expect(page.getByTestId("next-review-models")).toHaveText("A review of a pull request uses fake/model");

    // Pre-filled from the rule for the kind chosen, and following it.
    await page.goto(`${base}/start-review`);
    const line = page.getByTestId("review-models");
    const chips = page.getByTestId("review-models-chosen");
    await expect(chips).toHaveText("fake/model");
    await expect(line).toContainText("The workspace's default model. Changing them applies to this review only.");
    await page.getByLabel("A whole branch").check();
    await expect(chips).toHaveText("fake/wordy-extrafake/model");
    await expect(line).toContainText("This project's models for full scans.");
    await page.getByLabel("A pull request").check();
    await expect(chips).toHaveText("fake/model");

    // Changed, they stay as chosen whatever the kind, for this review only.
    await page.getByLabel("A whole branch").check();
    await page.getByRole("button", { name: "Change the models" }).click();
    const picker = page.getByRole("group", { name: "Models for this review" });
    await expect(picker.getByRole("checkbox", { name: "fake/wordy-extra" })).toBeChecked();
    await expect(picker.getByRole("checkbox", { name: "Second" })).not.toBeChecked();
    await picker.getByRole("checkbox", { name: "fake/model", exact: true }).uncheck();
    await picker.getByRole("checkbox", { name: "Second" }).check();
    await expect(chips).toHaveText("fake/wordy-extraSecond");
    await expect(line).toContainText("Chosen for this review only.");
    await axe(page, "start a review with the models open");
    await page.getByLabel("A pull request").check();
    await expect(chips).toHaveText("fake/wordy-extraSecond");
    // None at all can't start; the project's are one click away.
    await picker.getByRole("checkbox", { name: "fake/wordy-extra" }).uncheck();
    await picker.getByRole("checkbox", { name: "Second" }).uncheck();
    await expect(page.getByRole("button", { name: "Start review" })).toBeDisabled();
    await page.getByRole("button", { name: "Use the project's" }).click();
    await expect(chips).toHaveText("fake/model");
    await expect(page.getByRole("button", { name: "Start review" })).toBeEnabled();

    await page.getByLabel("A whole branch").check();
    await picker.getByRole("checkbox", { name: "fake/model", exact: true }).uncheck();
    await picker.getByRole("checkbox", { name: "Second" }).check();
    await page.getByRole("button", { name: "Start review" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/runs/[\\w-]+$`));

    // The run: each model's outcome, known by its label; the project's own models are as they were.
    const panel = page.getByTestId("run-panel");
    await expect(panel.getByText("Done", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId("run-models")).toContainText("fake/wordy-extra");
    await expect(panel.getByTestId("run-models")).toContainText("Second");
    await expect(panel.getByTestId("run-models-chosen")).toHaveText("Chosen for this review.");
    const id = page.url().split("/").at(-1) as string;
    await expect(page.getByTestId(`recent-${id}`).getByTestId("run-model-chips")).toHaveText("Models: fake/wordy-extraSecond");
    await axe(page, "a run with several models");
    const run = await admin.get(`/api/v1/w/${ws}/runs/${id}`);
    expect(run.requestedModels).toEqual([wordy, second]);
    expect(run.model.models.map((m: { label: string; model: string }) => [m.label, m.model])).toEqual([
        ["fake/wordy-extra", "fake/wordy-extra"],
        ["Second", "fake/model-b"],
    ]);
    expect((await admin.get(`${api}/settings/automation`)).models).toEqual({ full: [wordy, usual] });

    // The dialog beside a pull request has the same picker, with the project's models for pull requests.
    await admin.patch(`${api}/settings/automation`, { models: { full: [wordy, usual], pr: [second] } });
    await page.goto(`${base}/pull-requests`);
    await expect(page.getByTestId("next-review-models")).toHaveText("A review of a pull request uses Second");
    await page
        .getByTestId("pr-8")
        .getByRole("button", { name: /Review now/ })
        .click();
    const dialog = page.getByRole("dialog", { name: "Start a review" });
    await expect(dialog.getByTestId("review-models-chosen")).toHaveText("Second");
    await expect(dialog.getByTestId("review-models")).toContainText("This project's models for pull requests.");
    await dialog.getByRole("button", { name: "Change the models" }).click();
    await dialog.getByRole("checkbox", { name: "Second" }).uncheck();
    await dialog.getByRole("checkbox", { name: "fake/model", exact: true }).check();
    await axe(page, "the start a review dialog with the models open", true);
    await dialog.getByRole("button", { name: "Start review" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/runs/[\\w-]+$`));
    await expect(panel.getByText("Done", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId("run-models")).toContainText("fake/model");
    await expect(panel.getByTestId("run-models")).toContainText("chosen for this review");
});
