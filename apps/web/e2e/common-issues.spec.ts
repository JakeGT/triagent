// Common issues: a model groups a branch's findings by cause, each with how to avoid it; people edit and
// hide them; the Issues page filters by one and an issue shows the advice. And likely false positives,
// drawn from what the team has dismissed. The model is a stand-in on 127.0.0.1.
//
// With SCREENSHOT_DIR set, it also saves screenshots of these pages.

import { randomBytes } from "node:crypto";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { FakeProvider } from "../../../tests/fakes/model-provider";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { type Api, expect, signInPage, test, unique } from "./fixtures";

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

const finding = (file: string, line: number, content: string, severity = "high", category = "security") => ({
    path: file,
    content,
    severity,
    category,
    start_line: line,
    end_line: line,
});

const REPORT = {
    project_summary: "",
    comments: [
        finding("db/migrations/0001_users.sql", 10, "Table users has no row-level security policy.", "critical"),
        finding("db/migrations/0002_orders.sql", 10, "Table orders has no row-level security policy."),
        finding("db/migrations/0003_invoices.sql", 10, "Table invoices has no row-level security policy."),
        finding("db/grants.sql", 4, "The runtime role can read every tenant's rows."),
        finding("src/api/users.ts", 20, "Tenant id is taken from the request body."),
        ...[1, 2, 3, 4].map((n) =>
            finding(`src/gen/client${n}.ts`, n, `Generated client ${n} uses any for its response type.`, "low", "style"),
        ),
    ],
};

/** A workspace with a report, and an analysis model on the stand-in provider. */
async function seeded(admin: Api, provider: string) {
    const ws = unique("ci");
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Org ${ws}` });
    await admin.post(`/api/v1/w/${ws}/projects`, { slug: "app", name: "App" });
    await admin.post(`/api/v1/w/${ws}/p/app/reports`, { branch: "main", fileName: "scan.json", report: REPORT, confirm: true });
    await admin.patch(`/api/v1/w/${ws}/settings/review-model/providers/custom`, { url: provider, protocol: "openai" });
    await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/custom`, { key: `sk-or-${randomBytes(12).toString("hex")}` });
    const fav = await admin.post(`/api/v1/w/${ws}/settings/models/favourites`, { provider: "custom", model: "analyst-model" });
    await admin.put(`/api/v1/w/${ws}/settings/analysis`, { model: (fav.favourites as { id: string }[])[0]?.id });
    return ws;
}

test.describe("common issues", () => {
    const provider = new FakeProvider();
    test.beforeAll(async () => {
        await provider.start();
        provider.say = ({ system, user }) => {
            if (system.startsWith("You group code review findings")) {
                const q = JSON.parse(user) as { findings: { n: number; file: string }[] };
                return JSON.stringify({
                    groups: [
                        {
                            new: {
                                title: "Row-level security missing on new tables",
                                summary: "Tables are created without a policy, so one tenant can read another's rows.",
                                guidance: "Add a policy in the same migration that creates the table.",
                                category: "security",
                            },
                            findings: q.findings.filter((f) => f.file.startsWith("db/")).map((f) => f.n),
                        },
                    ],
                });
            }
            const q = JSON.parse(user) as { open: { n: number; file: string }[] };
            return JSON.stringify({
                likely: q.open
                    .filter((o) => o.file.startsWith("src/gen/"))
                    .map((o) => ({ finding: o.n, like: 1, why: "Another generated client." })),
            });
        };
    });
    test.afterAll(async () => {
        await provider.stop();
    });

    for (const theme of ["light", "dark"] as const) {
        test(`found by a model, edited by people, and used to filter and read the issues (${theme})`, async ({ page, admin }) => {
            const ws = await seeded(admin, `${provider.url}/v1`);
            await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
            await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);

            // No project chosen: it says what to do. With one: nothing yet, and what's waiting.
            await page.goto(`/w/${ws}/analytics/common-issues`);
            await expect(page.getByTestId("common-issues-note")).toHaveText("Choose a project above to see its common issues.");
            await page.getByRole("form", { name: "What to show" }).getByLabel("Project").selectOption("app");
            await expect(page.getByRole("heading", { name: "No common issues yet" })).toBeVisible();
            const grouping = page.getByTestId("grouping");
            await expect(grouping).toContainText("9 of 9 open findings on main aren't under a common issue yet.");
            await grouping.getByRole("button", { name: "Find common issues" }).click();

            const row = page.getByTestId("common-issue");
            await expect(row).toHaveCount(1);
            await expect(row.getByRole("heading", { level: 3 })).toHaveText("Row-level security missing on new tables");
            await expect(row).toContainText("4 open on main · 4 in all");
            await expect(row).toContainText("Add a policy in the same migration that creates the table.");
            await expect(grouping).toContainText("5 of 9 open findings on main aren't under a common issue yet.");
            await expect(grouping).toContainText("1 new common issue, 4 findings put under one");
            // Nine findings is few to draw patterns from, and it says so.
            await expect(grouping.getByTestId("analysis-warning")).toContainText("Only 9 findings are open on this branch");

            // The advice is what agents read: it can be put better by a person.
            await row.getByRole("button", { name: "Edit" }).click();
            const dialog = page.getByRole("dialog", { name: "Edit common issue" });
            await dialog
                .getByLabel("How to avoid it")
                .fill("Write the policy in the migration that creates the table, and test it as another tenant.");
            await axe(page, `editing a common issue (${theme})`);
            await dialog.getByRole("button", { name: "Save" }).click();
            await expect(row).toContainText("and test it as another tenant");

            // One added by hand, then hidden from agents.
            await page.getByRole("button", { name: "Add one by hand" }).click();
            const add = page.getByRole("dialog", { name: "Add a common issue" });
            await add.getByLabel("Title").fill("Tenant id trusted from the client");
            await add.getByLabel("How to avoid it").fill("Take the tenant from the session, never from the request.");
            await add.getByRole("button", { name: "Add", exact: true }).click();
            await expect(row).toHaveCount(2);
            const own = row.filter({ hasText: "Tenant id trusted from the client" });
            await own.getByRole("button", { name: "Hide from agents" }).click();
            await expect(own.getByText("Hidden from agents")).toBeVisible();
            await axe(page, `common issues (${theme})`);
            await shot(page, `common-issues-${theme}`);
            if (dir && theme === "light") {
                await page.setViewportSize({ width: 390, height: 900 });
                await shot(page, "common-issues-phone");
                await page.setViewportSize({ width: 1400, height: 900 });
            }

            // Its findings, in the issues list: the filter says which common issue, and comes off again.
            await row.first().getByRole("link", { name: "See its 4 open findings" }).click();
            await expect(page).toHaveURL(/\/p\/app\/issues\?.*pattern=/);
            const chip = page.getByTestId("under-common-issue");
            await expect(chip).toContainText("Common issue: Row-level security missing on new tables");
            await expect(page.getByTestId("issues-summary")).toHaveText(/^4 issues/);
            // An issue under it shows the advice where it's about to be fixed.
            await page
                .getByRole("row")
                .filter({ hasText: "Table users has no row-level security policy" })
                .getByRole("link")
                .first()
                .click();
            const advice = page.getByTestId("common-issue");
            await expect(advice).toContainText("Row-level security missing on new tables");
            await expect(advice).toContainText("How to avoid it: Write the policy in the migration");
            await axe(page, `an issue under a common issue (${theme})`);
            await shot(page, `common-issue-on-an-issue-${theme}`);
            await page.goto(`/w/${ws}/p/app/issues?pattern=${new URL(page.url()).searchParams.get("pattern")}`);
            await page.getByTestId("under-common-issue").getByRole("button", { name: "Show every issue" }).click();
            await expect(page.getByTestId("issues-summary")).toHaveText(/^9 issues/);

            // Likely false positives: nothing to learn from until something is dismissed with a reason.
            await page.goto(`/w/${ws}/analytics/insights?project=app`);
            const card = page.locator("div", { has: page.getByRole("heading", { name: "Likely false positives" }) }).last();
            await expect(card.getByTestId("analysis-warning")).toContainText(
                "Nothing has been dismissed with a reason in this project yet",
            );
            const issues = (await admin.get(`/api/v1/w/${ws}/p/app/issues?branch=main`)).items as { id: string; path: string }[];
            const generated = issues.find((x) => x.path === "src/gen/client1.ts") as { id: string };
            await admin.patch(`/api/v1/w/${ws}/p/app/issues/${generated.id}?branch=main`, {
                status: "wont_fix",
                note: "Generated code: we don't review its types.",
            });
            await page.reload();
            await expect(card.getByTestId("analysis-warning")).toContainText("Only 1 finding has been dismissed with a reason here");
            await card.getByRole("button", { name: "Look for likely false positives" }).click();
            const likely = card.getByTestId("false-positives").getByRole("listitem");
            await expect(likely).toHaveCount(3);
            await expect(likely.first()).toContainText("Another generated client.");
            await expect(likely.first()).toContainText("dismissed because: Generated code: we don't review its types.");
            await expect(card.getByTestId("analysis-warning")).toContainText("Treat these as guesses until there are at least 10");
            await axe(page, `likely false positives (${theme})`);
            await shot(page, `false-positives-${theme}`);
            // A suggestion opens the finding; it's still open, for a person to decide.
            await likely.first().getByRole("link").click();
            await expect(page).toHaveURL(/\/p\/app\/issues\/ocr-/);
        });
    }
});
