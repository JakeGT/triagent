// Triage on the Issues page: filters in the URL, the open issue, keyboard shortcuts, bulk changes,
// and what happens when someone else changes an issue at the same time.

import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { addMember, expect, issuesOf, seedProject, signInPage, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
});

test("filters live in the URL and the counts come from the server", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await page.goto(`/w/${ws}/p/${project}/issues`);
    await expect(page.getByTestId("issues-summary")).toHaveText(/10 issues: 1 critical, 2 high, 3 medium, 4 low/);

    await page.getByRole("button", { name: "Severity" }).click();
    await page.getByRole("checkbox", { name: "High" }).click();
    await page.getByRole("checkbox", { name: "Critical" }).click();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/severity=high%2Ccritical|severity=critical%2Chigh/);
    await expect(page.getByTestId("issues-summary")).toHaveText(/3 issues: 1 critical, 2 high/);

    await page.getByRole("searchbox", { name: "Search issues" }).fill("session");
    await expect(page).toHaveURL(/q=session/);
    await expect(page.getByTestId("issues-summary")).toHaveText(/1 issue: 1 high/);

    // The URL alone restores the view.
    await page.reload();
    await expect(page.getByTestId("issues-summary")).toHaveText(/1 issue: 1 high/);
    await expect(page.getByRole("searchbox", { name: "Search issues" })).toHaveValue("session");

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByTestId("issues-summary")).toHaveText(/^10 issues/);
    await expect(page).not.toHaveURL(/severity=/);
});

test("triage an issue: status, assignee, rating, discussion, duplicate and notes", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await page.goto(`/w/${ws}/p/${project}/issues`);
    await page.getByRole("link", { name: /User input is concatenated into SQL/ }).click();
    const panel = page.getByTestId("issue-panel");
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText(/User input is concatenated into SQL/);
    await expect(panel.getByText("Code and suggested fix")).toBeVisible();
    await expect(panel.getByRole("link", { name: /View source/ })).toHaveAttribute(
        "href",
        "https://github.com/example/app/blob/main/src/db/query.ts#L41-L44",
    );

    await panel.getByRole("button", { name: "In progress" }).click();
    await expect(panel.getByRole("button", { name: "In progress" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-issue-row]").first()).toContainText("In progress");

    await panel.getByRole("button", { name: "Assign to me" }).click();
    await expect(panel.getByLabel("Assignee")).toHaveValue("admin");

    // Correct the reviewer's rating, then put it back.
    await panel.getByRole("button", { name: "Correct the rating" }).click();
    await page.getByRole("menuitemradio", { name: "Low" }).click();
    await expect(panel.getByText("Low, was critical")).toBeVisible();
    await panel.getByRole("button", { name: "Restore the reviewer's rating" }).click();
    await expect(panel.getByText("was critical")).toHaveCount(0);

    await panel.getByRole("switch", { name: "Needs discussion" }).click();
    await expect(panel.getByRole("switch", { name: "Needs discussion" })).toBeChecked();

    await panel.getByLabel("Add a note").fill("Fixed in the parameterised query.");
    await panel.getByRole("button", { name: "Add note" }).click();
    await expect(panel.getByText("Fixed in the parameterised query.")).toBeVisible();
    await expect(panel.getByLabel("Add a note")).toHaveValue("");

    // Your own notes can be edited and deleted.
    // (The server also notes rating corrections and the discussion flag; this is the one we wrote.)
    const mine = panel.getByRole("listitem").filter({ hasText: "Fixed in the parameterised query." });
    await mine.getByRole("button", { name: /^Edit/ }).click();
    await panel.getByLabel("Edit your note").fill("Fixed in commit abc123.");
    await panel.getByRole("button", { name: "Save note" }).click();
    await expect(panel.getByText("Fixed in commit abc123.")).toBeVisible();
    await expect(panel.getByText("(edited)")).toBeVisible();
    await panel
        .getByRole("listitem")
        .filter({ hasText: "Fixed in commit abc123." })
        .getByRole("button", { name: /^Delete/ })
        .click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete note" }).click();
    await expect(panel.getByText("Fixed in commit abc123.")).toHaveCount(0);

    // Duplicates point at each other.
    await page.getByRole("link", { name: /Session ids are compared with/ }).click();
    await panel.getByRole("button", { name: "Mark as a duplicate…" }).click();
    const picker = page.getByRole("dialog", { name: "Mark as a duplicate" });
    await picker.getByLabel("Search issues").fill("expired sessions");
    await picker
        .getByRole("button", { name: /^Choose/ })
        .first()
        .click();
    await expect(panel.getByText(/Duplicate of/)).toBeVisible();
    await expect(page.getByText("Marked a duplicate of", { exact: false }).first()).toBeVisible();
});

test("keyboard: j/k move, 1–4 set the status, x selects, / searches; and the shortcuts can be turned off", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    const issues = await issuesOf(admin, ws, project);
    await page.goto(`/w/${ws}/p/${project}/issues`);
    await expect(page.getByTestId("issues-summary")).toHaveText(/^10 issues/);

    await page.keyboard.press("j");
    await expect(page).toHaveURL(new RegExp(`/issues/${issues[0]?.id}`));
    await page.keyboard.press("j");
    await expect(page).toHaveURL(new RegExp(`/issues/${issues[1]?.id}`));
    await page.keyboard.press("k");
    await expect(page).toHaveURL(new RegExp(`/issues/${issues[0]?.id}`));
    // Status keys act on the open issue once it has loaded.
    await expect(page.getByTestId("issue-panel").getByRole("heading", { level: 2 })).toHaveText((issues[0]?.title ?? "").replace(/`/g, ""));

    await page.keyboard.press("3");
    await expect(page.getByTestId("issue-panel").getByRole("button", { name: "Resolved" })).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("x");
    await expect(page.getByRole("region", { name: "Change selected issues" })).toContainText("1 issue selected");

    await page.keyboard.press("/");
    await expect(page.getByRole("searchbox", { name: "Search issues" })).toBeFocused();
    await page.keyboard.press("Escape");

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/w/${ws}/p/${project}/issues($|\\?)`));

    // Turned off in Appearance, single keys do nothing (WCAG 2.1.4).
    await page.goto(`/w/${ws}/settings/appearance`);
    await page.getByRole("switch", { name: /shortcuts/i }).click();
    await page.goto(`/w/${ws}/p/${project}/issues`);
    await expect(page.getByTestId("issues-summary")).toHaveText(/^10 issues/);
    await page.keyboard.press("j");
    await expect(page).not.toHaveURL(/\/issues\/ocr-/);
});

test("pressing j several times quickly moves that many issues", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    const issues = await issuesOf(admin, ws, project);
    await page.goto(`/w/${ws}/p/${project}/issues`);
    await expect(page.getByTestId("issues-summary")).toHaveText(/^10 issues/);
    for (let i = 0; i < 3; i++) await page.keyboard.press("j");
    await expect(page).toHaveURL(new RegExp(`/issues/${issues[2]?.id}`));
});

test("a half-typed note stays with its issue when another issue is opened", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    const [first, second] = await issuesOf(admin, ws, project);
    if (!first || !second) throw new Error("not enough issues");
    await page.goto(`/w/${ws}/p/${project}/issues/${first.id}`);
    const panel = page.getByTestId("issue-panel");
    await panel.getByLabel("Add a note").fill("Meant for the first issue");
    await page.locator(`[data-issue-row="${second.id}"]`).getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/issues/${second.id}`));
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText(second.title.replace(/`/g, ""));
    await expect(panel.getByLabel("Add a note")).toHaveValue("");
    const after = (await issuesOf(admin, ws, project)).find((x) => x.id === second.id);
    expect(after?.noteCount ?? 0).toBe(0);
});

test("a selection kept across filters says how much of it isn't shown, and can be shown or cleared", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await page.goto(`/w/${ws}/p/${project}/issues?severity=low`);
    await expect(page.getByTestId("issues-summary")).toHaveText(/^4 issues/);
    await page.getByRole("checkbox", { name: "Select all issues on this page" }).click();
    const bar = page.getByRole("region", { name: "Change selected issues" });
    await expect(bar).toContainText("4 issues selected");
    await expect(bar).not.toContainText("not shown");
    await expect(bar.getByRole("button", { name: "Show selected" })).toHaveCount(0);

    // Another filter: the selection is kept, and the bar says none of it is in the list now.
    await page.getByRole("button", { name: "Severity" }).click();
    await page.getByRole("checkbox", { name: "Low" }).click();
    await page.getByRole("checkbox", { name: "Critical" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("issues-summary")).toHaveText(/^1 issue:/);
    await expect(bar).toContainText("4 issues selected, 4 not shown");

    // x selects the open issue, which is in the list.
    await page.locator("[data-issue-row]").getByRole("link").first().click();
    await expect(page.getByTestId("issue-panel").getByRole("heading", { level: 2 })).toBeVisible();
    await page.keyboard.press("x");
    await expect(bar).toContainText("5 issues selected, 4 not shown");

    await bar.getByRole("button", { name: "Show selected" }).click();
    await expect(page.getByTestId("issues-summary")).toHaveText(/^5 issues: 1 critical, 4 low/);
    await expect(page.locator("[data-issue-row]")).toHaveCount(5);
    await expect(bar).toContainText("5 issues selected");
    await expect(bar).not.toContainText("not shown");
    await expect(page.getByTestId("showing-selected")).toContainText("5 selected issues only");

    // Back to the filtered list, then to the low ones: the open issue (critical) isn't among them, so x leaves it be.
    await bar.getByRole("button", { name: "Back to the filtered list" }).click();
    await expect(page.locator("[data-issue-row]")).toHaveCount(1);
    await page.getByRole("button", { name: "Severity" }).click();
    await page.getByRole("checkbox", { name: "Critical" }).click();
    await page.getByRole("checkbox", { name: "Low" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("issues-summary")).toHaveText(/^4 issues/);
    await expect(bar).toContainText("5 issues selected, 1 not shown");
    await page.keyboard.press("x");
    await expect(bar).toContainText("5 issues selected, 1 not shown");

    await bar.getByRole("button", { name: "Clear selection" }).click();
    await expect(bar).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Select all issues on this page" })).not.toBeChecked();
});

test("bulk changes apply to every selected issue", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await page.goto(`/w/${ws}/p/${project}/issues?severity=low`);
    await expect(page.getByTestId("issues-summary")).toHaveText(/^4 issues/);
    await page.getByRole("checkbox", { name: "Select all issues on this page" }).click();
    const bar = page.getByRole("region", { name: "Change selected issues" });
    await expect(bar).toContainText("4 issues selected");
    await bar.getByRole("button", { name: "Status" }).click();
    await page.getByRole("menuitem", { name: "Won't fix" }).click();
    await expect(page.getByText("Marked won't fix: 4 issues changed.")).toBeVisible();
    await expect(page.locator("[data-issue-row]").filter({ hasText: "Won't fix" })).toHaveCount(4);
    const after = await issuesOf(admin, ws, project);
    expect(after.filter((x) => x.status === "wont_fix")).toHaveLength(4);
});

test("someone else's change arrives live, and never clobbers a note being typed", async ({ page, admin, baseURL }) => {
    const { ws, project } = await seedProject(admin);
    const sam = await addMember(admin, baseURL as string, ws, "editor");
    const [first] = await issuesOf(admin, ws, project);
    if (!first) throw new Error("no issues");
    await page.goto(`/w/${ws}/p/${project}/issues/${first.id}`);
    const panel = page.getByTestId("issue-panel");
    await expect(page.getByTestId("live-status")).toHaveAttribute("data-status", "live");

    // Not editing: their change just shows up.
    await sam.api.patch(`/api/v1/w/${ws}/p/${project}/issues/${first.id}?branch=main`, { status: "in_progress", rev: first.rev });
    await expect(panel.getByRole("button", { name: "In progress" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`[data-issue-row="${first.id}"]`)).toContainText("In progress");

    // Editing: the note stays, the issue holds still, and a banner says it changed.
    await panel.getByLabel("Add a note").fill("My half-written note");
    const now = (await issuesOf(admin, ws, project)).find((x) => x.id === first.id);
    await sam.api.patch(`/api/v1/w/${ws}/p/${project}/issues/${first.id}?branch=main`, { status: "resolved", rev: now?.rev });
    await expect(panel.getByTestId("changed-elsewhere")).toBeVisible();
    await expect(panel.getByRole("button", { name: "In progress" })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByLabel("Add a note")).toHaveValue("My half-written note");

    // Saving against the old version is refused (409): we show their change and keep the note.
    await panel.getByRole("button", { name: "Add note" }).click();
    const conflict = panel.getByTestId("conflict");
    await expect(conflict).toContainText("Someone else changed this issue first");
    await expect(conflict).toContainText(sam.username);
    await expect(conflict).toContainText("It's now resolved");
    await expect(conflict).toContainText("add a note");
    await expect(panel.getByRole("button", { name: "Resolved" })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByLabel("Add a note")).toHaveValue("My half-written note");

    // Applying it again, to their version, works.
    await conflict.getByRole("button", { name: "Apply my change to their version" }).click();
    await expect(panel.getByText("My half-written note")).toBeVisible();
    await expect(panel.getByLabel("Add a note")).toHaveValue("");
    await expect(conflict).toHaveCount(0);
});
