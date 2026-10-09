// Reviews in the browser, against the real server, a real runner with a fake `ocr`, and a fake GitHub:
// pull requests, starting a review and watching it live, cancelling, the "reviews are waiting" banner,
// setting up the GitHub App and installing it, accessibility, and (with SCREENSHOT_DIR) screenshots.

import { randomBytes } from "node:crypto";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { type Api, expect, signInPage, test, unique } from "./fixtures";

const GITHUB = process.env.E2E_GITHUB_URL as string;

async function fake<T = Record<string, unknown>>(what: string, body?: unknown): Promise<T> {
    const res = await fetch(`${GITHUB}/_fake/${what}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`fake ${what}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
}

/** An organisation with a project on its own fake repository, a token for it, and (unless `key: false`) a model key. */
async function reviewProject(admin: Api, opts: { model?: string; key?: boolean } = {}) {
    const ws = unique("rev");
    const repo = `acme/${ws}`;
    await fake("git-repo", { fullName: repo, files: { "src/app.ts": "export const app = 1;\n", "README.md": "# App\n" } });
    const token = `github_pat_${randomBytes(16).toString("hex")}`;
    await fake("pat", { token, login: "octo", repos: [repo] });
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Org ${ws}` });
    await admin.post(`/api/v1/w/${ws}/projects`, { slug: "app", name: "App", repoUrl: `https://github.com/${repo}` });
    await admin.put(`/api/v1/w/${ws}/p/app/settings/github/token`, { token });
    if (opts.key !== false) {
        await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/openrouter`, { key: `sk-or-${randomBytes(12).toString("hex")}` });
        await admin.patch(`/api/v1/w/${ws}/settings/review-model`, { model: opts.model ?? "fake/model" });
    }
    return { ws, repo, base: `/w/${ws}/p/app` };
}

async function openPull(repo: string, number: number, branch: string, title: string) {
    await fake("commit", { fullName: repo, branch, from: "main", message: title, files: { [`src/${branch}.ts`]: `// ${title}\n` } });
    await fake("pull", { fullName: repo, number, headRef: branch, title });
}

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

async function axe(page: Page, what: string) {
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const problems = results.violations.map(
        (v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary}`).join("\n  ")}`,
    );
    expect(problems, `accessibility problems on ${what}`).toEqual([]);
}

test("a pull request is checked, reviewed on request, and watched live until it's done", async ({ page, admin }) => {
    const { ws, repo, base } = await reviewProject(admin, { model: "fake/sleep-3" });
    await openPull(repo, 5, "feature", "Add a feature");
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);

    await page.goto(`${base}/pull-requests`);
    await expect(page.getByRole("heading", { level: 1, name: "Pull requests" })).toBeVisible();
    await expect(page.getByText("Automatic reviews are off")).toBeVisible();
    await page.getByRole("button", { name: "Check now" }).click();
    const row = page.getByTestId("pr-5");
    await expect(row).toContainText("#5 Add a feature");
    await expect(row).toContainText("Not queued: automatic reviews are off");

    await row.getByRole("button", { name: /Review now/ }).click();
    const dialog = page.getByRole("dialog", { name: "Start a review" });
    await expect(dialog.getByLabel("Pull request", { exact: true })).toHaveValue("5");
    await dialog.getByRole("button", { name: "Start review" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/runs/[\\w-]+$`));

    const panel = page.getByTestId("run-panel");
    await expect(panel.getByRole("heading", { name: "PR #5: Add a feature" })).toBeVisible();
    // Live progress and log, with no polling: they arrive with live updates.
    await expect(page.getByTestId("run-progress")).toContainText("Reviewing", { timeout: 15_000 });
    await expect(page.getByTestId("run-log")).toContainText("[fake-ocr] args: review --from");
    await expect(page.getByTestId("run-log")).toContainText("[fake-ocr] key: [redacted]");
    await expect(panel.getByText("Done", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText("1 finding");
    // The person who asked hears about it.
    await expect(page.getByText("Review finished", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Pull requests" }).click();
    await expect(page.getByTestId("pr-5").getByRole("link", { name: "Reviewed" })).toBeVisible();
    const state = await fake<{ statuses: { state: string; context: string }[]; comments: Record<string, { body: string }[]> }>(
        `repo?fullName=${encodeURIComponent(repo)}`,
    );
    expect(state.statuses.at(-1)).toMatchObject({ state: "success", context: "Triagent" });
    expect(state.comments["5"]?.[0]?.body).toContain("1 finding in this pull request");

    // Branches & reports: the branch is up to date with GitHub; one that moved on says so.
    await page.goto(`${base}/branches`);
    await expect(page.getByTestId("branch-feature")).toContainText("Up to date with GitHub");
    await fake("commit", { fullName: repo, branch: "feature", message: "More", files: { "src/more.ts": "x\n" } });
    await fake("commit", { fullName: repo, branch: "other", from: "main", message: "Other", files: { "src/other.ts": "y\n" } });
    await admin.post(`/api/v1/w/${ws}/p/app/pull-requests/check`);
    await page.reload();
    await expect(page.getByTestId("branch-feature")).toContainText("Out of date: 1 commit behind");
    await expect(page.getByTestId("branch-feature").getByRole("button", { name: "Review again feature" })).toBeVisible();
    await expect(page.getByTestId("not-reviewed")).toContainText("other");
});

test("the New review button opens a page for starting one: pick what to review, and the run opens", async ({ page, admin }) => {
    const { repo, base } = await reviewProject(admin);
    await openPull(repo, 8, "feature-x", "Add x");
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`${base}/overview`);
    await page.getByTestId("new-review").click();
    await expect(page).toHaveURL(new RegExp(`${base}/start-review$`));
    await expect(page.getByRole("heading", { level: 1, name: "Start a review" })).toBeVisible();
    await expect(page.getByTestId("review-models")).toContainText("the workspace's model, fake/model");

    // Open pull requests to pick from; or a branch's changes, with the known branches suggested.
    await expect(page.getByLabel("Pull request", { exact: true })).toHaveValue("8");
    await page.getByLabel("A branch's changes").check();
    await page.getByLabel("Branch", { exact: true }).fill("feature-x");
    await page.getByRole("button", { name: "Start review" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/runs/[\\w-]+$`));
    await expect(page.getByTestId("run-panel").getByRole("heading", { name: /Changes on feature-x since main/ })).toBeVisible();

    // A link can choose already.
    await page.goto(`${base}/start-review?kind=full&branch=main`);
    await expect(page.getByLabel("A whole branch")).toBeChecked();
    await expect(page.getByLabel("Branch", { exact: true })).toHaveValue("main");
});

test("a running review can be cancelled", async ({ page, admin }) => {
    const { ws, base } = await reviewProject(admin, { model: "fake/sleep-30" });
    const run = await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "full" });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`${base}/runs`);
    const card = page.getByTestId(`running-${run.id}`);
    await expect(card).toContainText("Reviewing", { timeout: 15_000 });
    await card.getByRole("button", { name: /Cancel/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel review" }).click();
    const recent = page.getByTestId(`recent-${run.id}`);
    await expect(recent).toContainText("Cancelled", { timeout: 15_000 });
    await expect(recent).toContainText("Cancelled by admin");
});

test("reviews say why they're waiting", async ({ page, admin }) => {
    const { ws, base } = await reviewProject(admin, { key: false });
    await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "full" });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`${base}/runs`);
    const banner = page.getByTestId("reviews-waiting");
    await expect(banner).toContainText("Add an OpenRouter API key in Settings → Review model & keys.");
    await expect(banner.getByRole("link", { name: /Review model/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Add an OpenRouter API key/ })).toBeVisible();
    // The rail counts it.
    await expect(page.getByRole("link", { name: /Runs/ })).toContainText("1");
});

test("an instance admin creates the GitHub App, and a project installs it and picks its repository", async ({ page, admin }) => {
    const { ws, repo, base } = await reviewProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    const status = await admin.get("/api/v1/instance/github-app");
    if (!status.configured) {
        await page.goto(`/w/${ws}/settings/github-app`);
        await page.getByLabel("Name").fill("Triagent e2e");
        await page.getByRole("button", { name: "Continue to GitHub…" }).click();
        // Triagent's own page posts the manifest to GitHub (the fake), which comes back with the app's keys.
        await expect(page.getByRole("heading", { name: "Create the GitHub App" })).toBeVisible();
        await page.getByRole("button", { name: "Continue to GitHub" }).click();
        await page.getByRole("link", { name: "Create GitHub App" }).click();
        await expect(page.getByText("The GitHub App is ready")).toBeVisible();
        await expect(page.getByText("Triagent e2e")).toBeVisible();
    }

    await fake("next-install", { account: "acme", repos: [repo], login: "octo" });
    await page.goto(`${base}/settings/github`);
    await page.getByRole("button", { name: "Install on GitHub…" }).click();
    await expect(page.getByTestId("install-outcome")).toContainText("The installation is linked to this workspace");
    await page.getByLabel("Repository").selectOption({ label: repo });
    await page.getByRole("button", { name: "Use this repository" }).click();
    await expect(page.getByTestId("github-mode")).toHaveText(`Connected to ${repo} through the GitHub App.`);
    await page.getByRole("button", { name: "Test the connection" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Reading works" })).toContainText("posted as the GitHub App");
});

for (const theme of ["light", "dark"] as const) {
    test(`review pages are accessible in ${theme} mode`, async ({ page, admin }) => {
        const { ws, repo, base } = await reviewProject(admin);
        await openPull(repo, 3, "a11y", "Check accessibility");
        await admin.post(`/api/v1/w/${ws}/p/app/pull-requests/check`);
        const run = await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "pr", number: 3 });
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.goto(`${base}/runs/${run.id}`);
        await expect(page.getByTestId("run-panel").getByText("Done", { exact: true })).toBeVisible({ timeout: 20_000 });
        for (const p of [
            `${base}/runs/${run.id}`,
            `${base}/runs`,
            `${base}/pull-requests`,
            `${base}/settings/github`,
            `/w/${ws}/settings/github-app`,
        ]) {
            await page.goto(p);
            await expect(page.locator("html")).toHaveClass(new RegExp(theme));
            await axe(page, `${p} (${theme})`);
        }
    });
}

const shots = process.env.SCREENSHOT_DIR;
for (const theme of ["light", "dark"] as const) {
    test(`screenshots of runs and pull requests (${theme})`, async ({ page, admin }) => {
        test.skip(!shots, "set SCREENSHOT_DIR to take screenshots");
        const { ws, repo, base } = await reviewProject(admin);
        for (const [n, branch, title] of [
            [12, "login-limits", "Rate-limit sign-in attempts"],
            [14, "export-csv", "Export issues as CSV"],
            [15, "draft-idea", "Try a new layout"],
        ] as const)
            await openPull(repo, n, branch, title);
        await admin.post(`/api/v1/w/${ws}/p/app/pull-requests/check`);
        const done = await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "pr", number: 12 });
        await expect.poll(async () => (await admin.get(`/api/v1/w/${ws}/runs/${done.id}`)).status, { timeout: 20_000 }).toBe("done");
        await admin.patch(`/api/v1/w/${ws}/settings/review-model`, { model: "fake/sleep-60" });
        const running = await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "pr", number: 14 });
        await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "full" });
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.goto(`${base}/runs/${running.id}`);
        await expect(page.getByTestId("run-progress")).toContainText("Reviewing", { timeout: 15_000 });
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(shots as string, `runs-${theme}.png`), fullPage: true });
        await page.goto(`${base}/pull-requests`);
        await expect(page.getByTestId("pr-12")).toBeVisible();
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(shots as string, `pull-requests-${theme}.png`), fullPage: true });
        for (const r of (await admin.get(`/api/v1/w/${ws}/runs`)).running) await admin.post(`/api/v1/w/${ws}/runs/${r.id}/cancel`);
        for (const r of (await admin.get(`/api/v1/w/${ws}/runs`)).queued) await admin.post(`/api/v1/w/${ws}/runs/${r.id}/cancel`);
    });
}
