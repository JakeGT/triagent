// What a model writes about reviews: choosing the model in Settings → Analysis, a review's page with what
// it changed and how its models compare, and Analytics → Insights with a question answered from the
// figures. The model is a stand-in on 127.0.0.1, so nothing leaves the machine.
//
// With SCREENSHOT_DIR set, it also saves screenshots of these pages.

import { randomBytes } from "node:crypto";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { FakeProvider } from "../../../tests/fakes/model-provider";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { type Api, expect, signInPage, test, unique } from "./fixtures";

const GITHUB = process.env.E2E_GITHUB_URL as string;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const dir = process.env.SCREENSHOT_DIR;

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

async function fakeGithub(what: string, body: unknown): Promise<void> {
    const res = await fetch(`${GITHUB}/_fake/${what}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fake ${what}: ${res.status} ${await res.text()}`);
}

const COMPARISON = [
    "**In short**",
    "",
    "All three models found the same problem in each file. fake/alarm alone rated one finding critical.",
    "",
    "**Each model**",
    "",
    "- **fake/model**: the plainest of the three, and nothing only it found.",
    "- **fake/wordy-extra**: one finding of its own, a low one about style.",
    "- **fake/alarm**: one finding of its own, the only critical.",
    "",
    "**Suggestion**",
    "",
    "Keep all three for now: one review is too little to tell. [More](https://example.invalid/more)",
].join("\n");
const SUMMARY = "This is the first review of main. It reported four findings in two files, one of them critical.";
const ANSWER = "Three findings are open and rated critical or high: start with the critical one in `src/app.ts`.";

/** A workspace whose models are all on the stand-in provider, with a project to review. */
async function reviewable(admin: Api, provider: string) {
    const ws = unique("ana");
    const repo = `acme/${ws}`;
    await fakeGithub("git-repo", {
        fullName: repo,
        files: { "src/app.ts": "export const app = 1;\n", "src/util.ts": "export const u = 2;\n" },
    });
    const token = `github_pat_${randomBytes(16).toString("hex")}`;
    await fakeGithub("pat", { token, login: "octo", repos: [repo] });
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Org ${ws}` });
    await admin.post(`/api/v1/w/${ws}/projects`, { slug: "app", name: "App", repoUrl: `https://github.com/${repo}` });
    await admin.put(`/api/v1/w/${ws}/p/app/settings/github/token`, { token });
    await admin.patch(`/api/v1/w/${ws}/settings/review-model/providers/custom`, { url: provider, protocol: "openai" });
    await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/custom`, { key: `sk-or-${randomBytes(12).toString("hex")}` });
    const ids: string[] = [];
    for (const model of ["fake/model", "fake/wordy-extra", "fake/alarm", "analyst-model"]) {
        const out = await admin.post(`/api/v1/w/${ws}/settings/models/favourites`, { provider: "custom", model });
        ids.push((out.favourites as { id: string; model: string }[]).find((f) => f.model === model)?.id as string);
    }
    return { ws, ids };
}

test.describe("what a model writes about reviews", () => {
    const provider = new FakeProvider();
    test.beforeAll(async () => {
        await provider.start();
        provider.say = ({ system }) =>
            system.startsWith("You write a short comparison")
                ? COMPARISON
                : system.startsWith("You write a short account")
                  ? SUMMARY
                  : system.includes("Reply with one JSON object")
                    ? JSON.stringify({ lookups: [{ project: "app", status: ["open"], severity: ["critical", "high"] }] })
                    : ANSWER;
    });
    test.afterAll(async () => {
        await provider.stop();
    });

    for (const theme of ["light", "dark"] as const) {
        test(`chosen in Settings, then on a review's page and under Analytics → Insights (${theme})`, async ({ page, admin }) => {
            test.slow();
            const { ws, ids } = await reviewable(admin, `${provider.url}/v1`);
            await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
            await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);

            // Nothing is asked until a model is chosen, and the pages say where to choose one.
            await page.goto(`/w/${ws}/analytics/insights`);
            await expect(page.getByTestId("analysis-no-model")).toContainText("No model is chosen for analysis yet");
            await page.getByRole("link", { name: "Open Settings → Analysis" }).click();
            await expect(page.getByRole("heading", { level: 2, name: "Analysis" })).toBeVisible();
            await expect(page.getByTestId("analysis-status")).toContainText("No model is chosen");
            await page.getByLabel("Model for analysis").selectOption(ids[3] as string);
            await page.getByLabel("Write what the review changed").check();
            await axe(page, `analysis settings (${theme})`);
            await page.getByRole("button", { name: "Save", exact: true }).click();
            await expect(page.getByTestId("analysis-status")).toContainText("Ready: analyst-model is asked.");
            await shot(page, `analysis-settings-${theme}`);

            // A review with three models. Its summary is written as it finishes; its comparison when asked.
            const run = await admin.post(`/api/v1/w/${ws}/p/app/reviews`, { kind: "full", models: ids.slice(0, 3) });
            await expect.poll(async () => (await admin.get(`/api/v1/w/${ws}/runs/${run.id}`)).status, { timeout: 60_000 }).toBe("done");
            await page.goto(`/w/${ws}/p/app/runs/${run.id}`);
            const written = page.getByTestId("run-analysis");
            const summary = written.getByTestId("written-summary");
            await expect(summary).toContainText("It reported four findings in two files");
            await expect(summary.getByTestId("analysis-warning")).toContainText("first review of this branch");
            await expect(summary).toContainText("Written by analyst-model");
            const comparison = written.getByTestId("written-comparison");
            await comparison.getByRole("button", { name: "Write a comparison" }).click();
            await expect(comparison).toContainText("fake/alarm alone rated one finding critical");
            // What it wrote is text: a link in it is only its words.
            await expect(comparison.getByText("More", { exact: false }).last()).toBeVisible();
            await expect(comparison.getByRole("link", { name: "More" })).toHaveCount(0);
            await axe(page, `a review with what was written about it (${theme})`);
            await shot(page, `analysis-run-${theme}`);

            // Insights, for the project: both are there, and a question is answered from the figures.
            await page.goto(`/w/${ws}/analytics/insights?project=app&days=0`);
            const latest = page.getByTestId("latest-review");
            await expect(latest).toContainText("It reported four findings in two files");
            await expect(latest).toContainText("Keep all three for now");
            await expect(latest.getByRole("link", { name: "Full scan of main" }).first()).toBeVisible();
            await page.getByRole("button", { name: "What should we fix first?" }).click();
            await expect(page.getByLabel("About App, all branches")).toHaveValue("What should we fix first?");
            await page.getByRole("button", { name: "Ask", exact: true }).click();
            const answer = page.getByTestId("answer");
            await expect(answer).toContainText("Three findings are open and rated critical or high");
            await expect(answer.getByTestId("analysis-warning")).toContainText("There's little to go on here: 1 review");
            await expect(answer).toContainText("Answered from the analytics for app, all branches, all time, and from:");
            await axe(page, `analytics insights (${theme})`);
            await shot(page, `analysis-insights-${theme}`);
            if (dir && theme === "light") {
                await page.setViewportSize({ width: 390, height: 900 });
                await shot(page, "analysis-insights-phone");
                await page.goto(`/w/${ws}/p/app/runs/${run.id}`);
                await expect(page.getByTestId("written-comparison")).toContainText("Keep all three");
                await shot(page, "analysis-run-phone");
                await page.setViewportSize({ width: 1400, height: 900 });
                await page.goto(`/w/${ws}/analytics/insights?project=app&days=0`);
                await page.getByLabel("About App, all branches").fill("What should we fix first?");
                await page.getByRole("button", { name: "Ask", exact: true }).click();
                await expect(page.getByTestId("answer")).toContainText("Three findings are open");
            }
            // What it looked at is a view of the issues list.
            await page.getByTestId("answer").getByRole("link", { name: "open critical or high findings in app" }).click();
            await expect(page).toHaveURL(/\/p\/app\/issues\?.*severity=/);
            await expect(page.getByTestId("issues-summary")).toHaveText(/^3 issues/);

            // What the asking took is counted apart from the reviews.
            await page.goto(`/w/${ws}/analytics/reviews?days=0`);
            await expect(page.getByTestId("analysis-usage")).toContainText(/Apart from the reviews: \d analyses written by a model/);
        });
    }
});
