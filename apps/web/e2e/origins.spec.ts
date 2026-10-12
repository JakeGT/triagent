// Where findings came from: off until an admin turns it on in Settings → Analysis; then each finding says
// which commit is behind it and suggests its author, the Findings tab shows how old that code is, and
// (only when the admin asks for it too) an Authors tab counts open findings by author.
//
// With SCREENSHOT_DIR set, it also saves screenshots of these pages.

import { randomBytes } from "node:crypto";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { type Api, expect, signInPage, test, unique } from "./fixtures";

const GITHUB = process.env.E2E_GITHUB_URL as string;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const dir = process.env.SCREENSHOT_DIR;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

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

async function fakeGithub<T = unknown>(what: string, body: unknown): Promise<T> {
    const res = await fetch(`${GITHUB}/_fake/${what}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fake ${what}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
}

const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n")}\n`;
const finding = (file: string, line: number, content: string, severity = "high") => ({
    path: file,
    content,
    severity,
    category: "bug",
    start_line: line,
    end_line: line,
});

/** A project on a repository with a history: Ada wrote it long ago, Grace reworked part of it last week in pull request #12. */
async function seeded(admin: Api) {
    const ws = unique("org");
    const repo = `acme/${ws}`;
    await fakeGithub("git-repo", { fullName: repo, files: { "README.md": "# app\n" } });
    await fakeGithub("commit", {
        fullName: repo,
        branch: "main",
        files: { "src/billing.ts": lines(240), "src/users.ts": lines(260) },
        message: "Add billing and users",
        author: { name: "Ada Lovelace", email: "ada@example.test", at: ago(400) },
    });
    const billing = lines(240).split("\n");
    for (let i = 10; i < 230; i++) billing[i] = `export const line${i + 1} = ${i + 1}; // reworked`;
    const { sha } = await fakeGithub<{ sha: string }>("commit", {
        fullName: repo,
        branch: "main",
        files: { "src/billing.ts": billing.join("\n") },
        message: "Rework billing totals",
        author: { name: "Grace Hopper", email: "grace@example.test", at: ago(6) },
    });
    await fakeGithub("blame", {
        logins: { "grace@example.test": "grace" },
        pulls: { [sha]: { number: 12, title: "Rework billing totals" } },
    });
    const token = `github_pat_${randomBytes(16).toString("hex")}`;
    await fakeGithub("pat", { token, login: "octo", repos: [repo] });
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Org ${ws}` });
    await admin.post(`/api/v1/w/${ws}/projects`, { slug: "app", name: "App", repoUrl: `https://github.com/${repo}` });
    await admin.put(`/api/v1/w/${ws}/p/app/settings/github/token`, { token });
    await admin.post(`/api/v1/w/${ws}/p/app/reports`, {
        branch: "main",
        commit: sha,
        fileName: "scan.json",
        confirm: true,
        report: {
            project_summary: "",
            comments: [
                finding("src/billing.ts", 40, "The total is rounded before tax is added.", "critical"),
                finding("src/billing.ts", 120, "Discounts can make the total negative."),
                finding("src/billing.ts", 200, "Currency is assumed to be the same on every line.", "medium"),
                finding("src/billing.ts", 4, "The invoice number isn't checked for duplicates.", "low"),
                finding("src/users.ts", 30, "Emails are compared without lowering their case."),
            ],
        },
    });
    return ws;
}

for (const theme of ["light", "dark"] as const) {
    test(`off until an admin turns it on; then the commit behind each finding, the code's age, and the leaderboard if asked for (${theme})`, async ({
        page,
        admin,
    }) => {
        const ws = await seeded(admin);
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);

        // Off: no Authors tab, nothing about commits on the Findings tab.
        await page.goto(`/w/${ws}/analytics/findings?project=app`);
        const tabs = page.getByRole("navigation", { name: "Analytics" });
        await expect(tabs.getByRole("link", { name: "Common issues" })).toBeVisible();
        await expect(tabs.getByRole("link", { name: "Authors" })).toHaveCount(0);
        await expect(page.getByTestId("where-from")).toHaveCount(0);

        // An admin turns tracing on, without the leaderboard.
        await page.goto(`/w/${ws}/settings/analysis`);
        await page.getByRole("radio", { name: "Trace findings to commits" }).check();
        await axe(page, `analysis settings with tracing (${theme})`);
        await shot(page, `origins-settings-${theme}`);
        await page.getByRole("button", { name: "Save tracing" }).click();
        await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

        await page.goto(`/w/${ws}/analytics/findings?project=app`);
        const from = page.getByTestId("where-from");
        await expect(from.getByTestId("tracing")).toContainText("haven't been traced to commits yet");
        await from.getByRole("button", { name: "Trace them now" }).click();
        await expect(from.getByTestId("tracing")).toContainText("5 findings in 2 files");
        // Grace's week-old rework has three of them; Ada's year-old code two.
        const ages = from.getByRole("list", { name: "Open findings by when their lines were last changed" });
        await expect(ages.getByRole("listitem").filter({ hasText: "The last 30 days" })).toContainText("3");
        await expect(ages.getByRole("listitem").filter({ hasText: "Over a year" })).toContainText("2");
        await expect(from.getByRole("row", { name: /#12 Rework billing totals/ })).toContainText("3");
        await expect(tabs.getByRole("link", { name: "Authors" })).toHaveCount(0);
        await axe(page, `where findings came from (${theme})`);
        await shot(page, `origins-findings-${theme}`);

        // The finding itself says which commit, and by whom.
        await page.goto(`/w/${ws}/p/app/issues`);
        await page.getByRole("row").filter({ hasText: "The total is rounded before tax is added" }).getByRole("link").first().click();
        await expect(page.getByTestId("issue-origin")).toContainText(/Lines last changed .* by Grace Hopper in [0-9a-f]{7} \(#12\)/);

        // The leaderboard is a choice of its own.
        await page.goto(`/w/${ws}/settings/analysis`);
        await page.getByRole("radio", { name: "Also show an authors leaderboard" }).check();
        await page.getByRole("button", { name: "Save tracing" }).click();
        await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
        await page.goto(`/w/${ws}/analytics/overview?project=app`);
        await tabs.getByRole("link", { name: "Authors" }).click();
        const board = page.getByRole("table", { name: /Authors by open findings/ });
        const rows = board.getByRole("row");
        await expect(rows.nth(1)).toContainText("Grace Hopper");
        await expect(rows.nth(1)).toContainText("@grace");
        await expect(rows.nth(1).getByRole("cell").nth(2)).toHaveText("3");
        // 220 lines of hers in the files looked at: 3 open findings is 13.6 a thousand.
        await expect(rows.nth(1).getByRole("cell").nth(6)).toHaveText("13.6");
        await expect(rows.nth(2)).toContainText("Ada Lovelace");
        await expect(rows.nth(2).getByRole("cell").nth(2)).toHaveText("2");
        await axe(page, `authors leaderboard (${theme})`);
        await shot(page, `origins-authors-${theme}`);
        if (dir && theme === "light") {
            await page.setViewportSize({ width: 390, height: 900 });
            await shot(page, "origins-authors-phone");
            await page.setViewportSize({ width: 1400, height: 900 });
        }
        // A name opens that author's open findings.
        await board.getByRole("link", { name: "Grace Hopper" }).click();
        await expect(page.getByTestId("by-author")).toContainText("In code last changed by @grace");
        await expect(page.getByTestId("issues-summary")).toHaveText(/^3 issues/);
        await page.getByTestId("by-author").getByRole("button", { name: "Show every issue" }).click();
        await expect(page.getByTestId("issues-summary")).toHaveText(/^5 issues/);

        // Turned off: the tab goes, and so does what was traced.
        await page.goto(`/w/${ws}/settings/analysis`);
        await page.getByRole("radio", { name: "Off", exact: true }).check();
        await page.getByRole("button", { name: "Save tracing" }).click();
        await expect(page.getByText("Tracing turned off, and what was traced deleted.")).toBeVisible();
        await page.goto(`/w/${ws}/analytics/authors?project=app`);
        await expect(page.getByTestId("authors-note")).toContainText("doesn't show an authors leaderboard");
        expect((await admin.get(`/api/v1/w/${ws}/p/app/origins`)).scan).toBeNull();
    });
}
