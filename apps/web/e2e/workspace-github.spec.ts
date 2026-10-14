// A workspace's GitHub settings: lending a token to its projects (checked with GitHub when saved), a
// project's page saying it uses the workspace's token, and a GitHub Enterprise address that this instance
// refuses (it resolves to a private address, and ALLOW_PRIVATE_GITHUB_URLS isn't set here).
//
// With SCREENSHOT_DIR set, it also saves screenshots of these pages.

import { randomBytes } from "node:crypto";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, signInPage, test, unique } from "./fixtures";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const dir = process.env.SCREENSHOT_DIR;
const GITHUB = process.env.E2E_GITHUB_URL as string;

async function fake(what: string, body: unknown) {
    const res = await fetch(`${GITHUB}/_fake/${what}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fake ${what}: ${res.status} ${await res.text()}`);
}

async function axe(page: Page, what: string) {
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
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

for (const theme of ["light", "dark"] as const) {
    test(`a workspace lends its token to its projects; a private Enterprise address is refused (${theme})`, async ({ page, admin }) => {
        const ws = unique("ghws");
        const repo = `acme/${ws}`;
        await fake("git-repo", { fullName: repo, files: { "README.md": "# App\n" } });
        const token = `github_pat_${randomBytes(16).toString("hex")}`;
        await fake("pat", { token, login: "workspace-bot", repos: [repo] });
        await admin.post("/api/v1/workspaces", { slug: ws, name: `Org ${ws}` });
        await admin.post(`/api/v1/w/${ws}/projects`, { slug: "app", name: "App", repoUrl: `https://github.com/${repo}` });

        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.goto(`/w/${ws}/settings/github`);
        await expect(page.getByRole("heading", { level: 2, name: "GitHub" })).toBeVisible();
        // Under Workspace in the settings menu (Project has a GitHub page of its own).
        await expect(page.locator(`a[href="/w/${ws}/settings/github"]`)).toHaveAttribute("aria-current", "page");

        // Lend a token: the token section appears once that's saved.
        await page.getByRole("radio", { name: /A token for the whole workspace/ }).check();
        await page.getByRole("button", { name: "Save connection" }).click();
        await expect(page.getByTestId("workspace-github-status")).toContainText("Not ready: add the workspace's token");
        const field = page.getByTestId("secret-field");
        await field.getByLabel("GitHub token").fill(`github_pat_${"0".repeat(30)}`);
        await field.getByRole("button", { name: "Save" }).click();
        await expect(field.getByRole("alert")).toContainText("turned the token down");
        await field.getByLabel("GitHub token").fill(token);
        await field.getByRole("button", { name: "Save" }).click();
        await expect(field).toContainText("Fine-grained token, belongs to workspace-bot.");
        await expect(page.getByTestId("workspace-github-status")).toContainText("use the workspace's token (workspace-bot)");
        expect(await page.content()).not.toContain(token);
        await axe(page, `workspace GitHub (${theme})`);
        await shot(page, `workspace-github-token-${theme}`);
        if (theme === "light") {
            await page.setViewportSize({ width: 390, height: 900 });
            await shot(page, "workspace-github-token-narrow");
            await page.setViewportSize({ width: 1400, height: 900 });
        }

        // GitHub Enterprise: the app can't be chosen there, and this instance refuses private addresses.
        await page.getByRole("radio", { name: /GitHub Enterprise Server/ }).check();
        await expect(page.getByRole("radio", { name: /The GitHub App/ })).toBeDisabled();
        await page.getByLabel("Server address").fill("https://127.0.0.1");
        await page.getByRole("button", { name: "Save connection" }).click();
        await expect(page.getByRole("alert")).toContainText("ALLOW_PRIVATE_GITHUB_URLS=true");
        await shot(page, `workspace-github-enterprise-${theme}`);

        // The project, with no connection of its own, uses the workspace's token.
        await page.goto(`/w/${ws}/p/app/settings/github`);
        await expect(page.getByTestId("workspace-token-note")).toContainText("uses the workspace's token (workspace-bot)");
        await page.getByRole("button", { name: "Test the connection" }).click();
        await expect(page.getByRole("status").filter({ hasText: "Reading works" })).toContainText("posted as workspace-bot");
        await axe(page, `project GitHub with the workspace's token (${theme})`);
        await shot(page, `project-github-workspace-token-${theme}`);
    });
}
