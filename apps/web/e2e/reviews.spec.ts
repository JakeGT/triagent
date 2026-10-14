// Reviews in the browser, against the real server, a real runner with a fake `ocr`, and a fake GitHub:
// pull requests, starting a review and watching it live, when reviews start by themselves (checks, later
// pushes, /review, skipped pull requests) and their settings, cancelling, the "reviews are waiting" banner,
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
    return { ws, repo, token, base: `/w/${ws}/p/app` };
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

test("a pull request waits for its checks, is reviewed once, and later pushes wait to be asked", async ({ page, admin }) => {
    test.setTimeout(90_000);
    const { ws, repo, token, base } = await reviewProject(admin);
    await admin.patch(`/api/v1/w/${ws}/p/app/settings/automation`, { enabled: true });
    // The baseline, with nothing open.
    await admin.post(`/api/v1/w/${ws}/p/app/pull-requests/check`);
    const commit = async (branch: string, files: Record<string, string>, from?: string) =>
        (await fake<{ sha: string }>("commit", { fullName: repo, branch, ...(from ? { from } : {}), message: branch, files })).sha;
    const first = await commit("feature", { "src/feature.ts": "// one\n" }, "main");
    await fake("pull", { fullName: repo, number: 1, headRef: "feature", title: "Add a feature" });
    await fake("check-run", { fullName: repo, sha: first, name: "build", status: "in_progress" });
    // Ones Triagent doesn't review by itself: a bot's, and one labelled skip-review.
    const deps = await commit("deps", { "package.json": "{}\n" }, "main");
    await fake("pull", { fullName: repo, number: 2, headRef: "deps", title: "Bump a dependency", author: "dependabot[bot]" });
    const wip = await commit("wip", { "src/wip.ts": "// wip\n" }, "main");
    await fake("pull", { fullName: repo, number: 3, headRef: "wip", title: "Not yet", labels: ["skip-review"] });
    for (const sha of [deps, wip])
        await fake("check-run", { fullName: repo, sha, name: "build", status: "completed", conclusion: "success" });

    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`${base}/pull-requests`);
    await expect(page.getByText("a pull request is reviewed once, when it's ready and its checks have passed")).toBeVisible();
    await expect(page.getByText("Later pushes aren't reviewed until someone asks")).toBeVisible();
    const check = async () => {
        await page.getByRole("button", { name: "Check now" }).click();
        await expect(page.getByText("Checked GitHub.").last()).toBeVisible();
    };
    await check();
    const row = page.getByTestId("pr-1");
    await expect(row).toContainText("Waiting for checks (1 of 1)");
    await expect(row).toContainText("Waiting for 1 of 1 checks.");
    await expect(row.getByRole("button", { name: /Review now/ })).toBeVisible();
    await expect(page.getByTestId("pr-2")).toContainText("Skipped: opened by a bot");
    await expect(page.getByTestId("pr-3")).toContainText("Skipped: label skip-review");
    // The toast has finished fading in.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    await axe(page, "pull requests with their states");

    // The check fails: not reviewed, and it says which.
    await fake("check-run", { fullName: repo, sha: first, name: "build", status: "completed", conclusion: "failure" });
    await check();
    await expect(row).toContainText("Checks failed");
    await expect(row).toContainText("Not queued: checks failed (build)");

    // It passes: one review, by itself.
    await fake("check-run", { fullName: repo, sha: first, name: "build", status: "completed", conclusion: "success" });
    await admin.post(`/api/v1/w/${ws}/p/app/pull-requests/check`, {});
    await expect
        .poll(
            async () =>
                (await admin.get(`/api/v1/w/${ws}/p/app/pull-requests`)).items.find((p: { number: number }) => p.number === 1).reviewed,
            { timeout: 20_000 },
        )
        .toBe(true);
    await page.reload();
    await expect(row.getByRole("link", { name: "Reviewed", exact: true })).toBeVisible();

    // A push after that isn't reviewed: the page and Triagent's comment say how many commits since.
    await commit("feature", { "src/feature.ts": "// two\n" });
    await check();
    await expect(row.getByRole("link", { name: `Reviewed at ${first.slice(0, 7)}, 1 commit since` })).toBeVisible();
    await expect(row).toContainText("later pushes aren't reviewed until someone asks");
    const runs = async () => (await admin.get(`/api/v1/w/${ws}/runs`)).recent.filter((r: { kind: string }) => r.kind === "pr").length;
    expect(await runs()).toBe(1);
    await expect
        .poll(async () => {
            const state = await fake<{ comments: Record<string, { body: string }[]> }>(`repo?fullName=${encodeURIComponent(repo)}`);
            return state.comments["1"]?.[0]?.body ?? "";
        })
        .toContain("**1 commit since this review**");

    // Someone with write access asks, with a comment: one more.
    await fake("comment", { fullName: repo, number: 1, body: "/review", user: "alice", association: "COLLABORATOR" });
    await admin.post(`/api/v1/w/${ws}/p/app/pull-requests/check`, {});
    await expect.poll(runs, { timeout: 20_000 }).toBe(2);
    await page.reload();
    await expect(row.getByRole("link", { name: "Reviewed", exact: true })).toBeVisible();

    // A token GitHub won't show check runs: reviewed when ready, and both pages say so.
    await fake("pat", { token, login: "octo", repos: [repo], noChecks: true });
    await commit("blind", { "src/blind.ts": "// blind\n" }, "main");
    await fake("pull", { fullName: repo, number: 4, headRef: "blind", title: "Unseen checks" });
    await check();
    await expect(page.getByTestId("pr-4")).toContainText("can't see checks, so reviewing when ready");
    await expect(page.getByTestId("checks-unreadable")).toContainText("GitHub won't show Triagent this repository's check runs");
    await page.getByTestId("checks-unreadable").getByRole("link", { name: "GitHub settings" }).click();
    await expect(page.getByTestId("checks-note")).toContainText("Triagent can't see this repository's checks");
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    await axe(page, "GitHub settings with the checks note");
});

test("when reviews start is set on the project's Automation page", async ({ page, admin }) => {
    const { ws, repo, base } = await reviewProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`${base}/settings/automation`);
    await page.getByLabel("Review pull requests automatically").click();
    const when = page.getByRole("group", { name: "When a pull request gets its first review" });
    await expect(when.getByLabel("When it's ready and its checks have passed")).toBeChecked();
    await expect(when).toContainText("comment /review on it");
    await when.getByLabel("As soon as it's ready").check();
    await page.getByLabel("Files that don't need a review").fill("docs/**\n*.md\n");
    await expect(page.getByLabel("Skip pull requests opened by bots")).toBeChecked();
    await page.getByLabel("Skip pull requests opened by bots").click();
    await axe(page, "automation settings");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Automation settings saved.")).toBeVisible();
    const saved = await admin.get(`/api/v1/w/${ws}/p/app/settings/automation`);
    expect([saved.enabled, saved.firstReview, saved.skipPaths, saved.skipBots]).toEqual([true, "ready", ["docs/**", "*.md"], false]);

    // A pull request touching only those files is skipped, and says which; a bot's is now reviewed.
    await admin.post(`/api/v1/w/${ws}/p/app/pull-requests/check`);
    await fake("commit", { fullName: repo, branch: "docs", from: "main", message: "Docs", files: { "docs/guide.md": "# Guide\n" } });
    await fake("pull", { fullName: repo, number: 6, headRef: "docs", title: "Write the guide" });
    await fake("commit", { fullName: repo, branch: "deps", from: "main", message: "Deps", files: { "package.json": "{}\n" } });
    await fake("pull", { fullName: repo, number: 7, headRef: "deps", title: "Bump", author: "renovate[bot]" });
    await page.goto(`${base}/pull-requests`);
    await expect(page.getByText("a pull request is reviewed once, as soon as it's ready")).toBeVisible();
    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByTestId("pr-6")).toContainText("Skipped: only docs/**");
    await expect(page.getByTestId("pr-6")).toContainText("it only changes files this project doesn't review (docs/**)");
    await expect(page.getByTestId("pr-7")).toContainText("Queued: it's ready for review");
});

test("the New review button opens a page for starting one: pick what to review, and the run opens", async ({ page, admin }) => {
    const { repo, base } = await reviewProject(admin);
    await openPull(repo, 8, "feature-x", "Add x");
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`${base}/overview`);
    await page.getByTestId("new-review").click();
    await expect(page).toHaveURL(new RegExp(`${base}/start-review$`));
    await expect(page.getByRole("heading", { level: 1, name: "Start a review" })).toBeVisible();
    await expect(page.getByTestId("review-models-chosen")).toHaveText("fake/model");
    await expect(page.getByTestId("review-models")).toContainText("The workspace's default model.");

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

test("a project's guided setup: GitHub with a token, the webhook, automatic reviews, then the first review", async ({ page, admin }) => {
    const ws = unique("setup");
    const repo = `acme/${ws}`;
    await fake("git-repo", { fullName: repo, files: { "src/app.ts": "export const app = 1;\n" } });
    const token = `github_pat_${randomBytes(16).toString("hex")}`;
    await fake("pat", { token, login: "octo", repos: [repo] });
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Org ${ws}` });
    await admin.post(`/api/v1/w/${ws}/projects`, { slug: "app", name: "App", repoUrl: `https://github.com/${repo}` });
    await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/openrouter`, { key: `sk-or-${randomBytes(12).toString("hex")}` });
    await admin.patch(`/api/v1/w/${ws}/settings/review-model`, { model: "fake/model" });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/p/app/overview`);

    // Only the GitHub connection is left: Finish setup opens the project's setup there.
    const finish = page.getByTestId("finish-setup");
    await expect(finish).toContainText("1");
    await finish.click();
    const setup = page.getByTestId("setup-dialog");
    await expect(setup.getByRole("heading", { name: "Connect GitHub", level: 3 })).toBeVisible();
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    const found = await new AxeBuilder({ page }).include('[data-testid="setup-dialog"]').withTags(TAGS).analyze();
    expect(found.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    await setup.getByLabel("GitHub token").fill(token);
    await setup.getByRole("button", { name: "Save", exact: true }).click();
    await expect(setup.getByTestId("setup-progress")).toHaveText("Everything required is done.");
    await expect(finish).toHaveCount(0);

    // A token needs the webhook set up by hand.
    await setup.getByRole("button", { name: "Next" }).click();
    await expect(setup.getByRole("heading", { name: "GitHub webhook", level: 3 })).toBeVisible();
    await setup.getByRole("button", { name: "Generate a secret" }).click();
    await expect(setup.getByLabel("Webhook secret")).toBeVisible();
    await expect(setup.getByRole("button", { name: /GitHub webhook\s*Done/ })).toBeVisible();

    await setup.getByRole("button", { name: "Next" }).click();
    await expect(setup.getByRole("heading", { name: "Automatic reviews", level: 3 })).toBeVisible();
    await setup.getByLabel("Review pull requests automatically").click();
    await setup.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => (await admin.get(`/api/v1/w/${ws}/p/app/settings/automation`)).enabled).toBe(true);

    await setup.getByRole("button", { name: "Next" }).click();
    await setup.getByRole("link", { name: "Start your first review" }).click();
    await expect(setup).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/w/${ws}/p/app/start-review$`));

    // Coming back from installing the GitHub App (started in the setup) opens it again, at GitHub.
    await page.goto(`/w/${ws}/p/app/settings/github?github=linked&setup=project`);
    await expect(setup.getByRole("heading", { name: "Connect GitHub", level: 3 })).toBeVisible();
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
    await expect(banner).toContainText("Add an OpenRouter API key in Settings → Models.");
    await expect(banner.getByRole("link", { name: "Open Models" })).toBeVisible();
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

    // An account and owner of this test's own: other tests install the app too.
    const account = `acme-${ws}`;
    const owner = `owner-${ws}`;
    await fake("next-install", { account, repos: [repo], login: owner });
    await page.goto(`${base}/settings/github`);
    await page.getByRole("button", { name: "Install on GitHub…" }).click();
    await expect(page.getByTestId("install-outcome")).toContainText("The installation is linked to this workspace");
    await page.getByLabel("Repository").selectOption({ label: repo });
    await page.getByRole("button", { name: "Use this repository" }).click();
    await expect(page.getByTestId("github-mode")).toHaveText(`Connected to ${repo} through the GitHub App.`);
    await page.getByRole("button", { name: "Test the connection" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Reading works" })).toContainText("posted as the GitHub App");

    // Another workspace can't install it on the same account again, so it links the installation instead:
    // GitHub only asks who you are.
    const other = await reviewProject(admin);
    await fake("next-authorize", { login: owner });
    await page.goto(`${other.base}/settings/github`);
    await page.getByRole("button", { name: "Link one you already have…" }).click();
    await expect(page.getByTestId("install-outcome")).toContainText("The installation is linked to this workspace");
    await expect(page.getByText(new RegExp(`${account} \\(chosen repositories\\)`))).toBeVisible();
    if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "github-app-linked-existing.png"), fullPage: true });
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
