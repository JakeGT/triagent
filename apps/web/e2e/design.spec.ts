// The design rules that can regress without anything else failing (DESIGN.md): on a phone the main places
// stay in view in a bottom bar and no page scrolls sideways; destructive actions are outlined in the
// danger colour with an icon, set apart at the end of their row, and readable in both themes.

import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, issuesOf, REPORT, seedProject, signInPage, test } from "./fixtures";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const PHONE = { width: 390, height: 844 };

async function axe(page: Page, what: string) {
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    // A dialog or sheet that is still fading in is measured half see-through.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const problems = results.violations.map(
        (v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary}`).join("\n  ")}`,
    );
    expect(problems, `accessibility problems on ${what}`).toEqual([]);
}

/** The page itself never scrolls sideways: only something inside it (a code block, a table's frame) may. */
async function expectNoSidewaysScroll(page: Page, what: string) {
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    const { doc, body, main, width } = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        main: document.querySelector("main")?.scrollWidth ?? 0,
        width: window.innerWidth,
    }));
    expect(doc, `document width on ${what}`).toBeLessThanOrEqual(width);
    expect(body, `body width on ${what}`).toBeLessThanOrEqual(width);
    expect(main, `main width on ${what}`).toBeLessThanOrEqual(width);
}

for (const theme of ["light", "dark"] as const)
    test(`on a phone, a bottom bar keeps four places and Menu in view (${theme})`, async ({ page, admin }) => {
        const { ws, project } = await seedProject(admin);
        const [issue] = await issuesOf(admin, ws, project);
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.setViewportSize(PHONE);
        const base = `/w/${ws}/p/${project}`;
        await page.goto(`${base}/issues`);
        await expect(page.getByRole("heading", { level: 1, name: "Issues" })).toBeVisible();

        const bar = page.getByRole("navigation", { name: "Main" });
        await expect(bar).toBeVisible();
        await expect(bar.getByRole("listitem")).toHaveText(["Overview", "Issues", "Tasks", "Runs", "Menu"]);
        // The place you're in is marked for assistive technology, and only that one.
        await expect(bar.getByRole("link", { name: "Issues" })).toHaveAttribute("aria-current", "page");
        await expect(bar.locator('[aria-current="page"]')).toHaveCount(1);
        // Fixed to the bottom of the screen, each target big enough for a thumb.
        const box = await bar.boundingBox();
        expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(PHONE.height);
        for (const item of await bar.locator("a, button").all()) {
            const b = await item.boundingBox();
            expect(b?.width, "target width").toBeGreaterThanOrEqual(44);
            expect(b?.height, "target height").toBeGreaterThanOrEqual(44);
        }
        await axe(page, `the issues list on a phone (${theme})`);

        // The page ends above the bar: the last thing on it can be scrolled clear of it.
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const lastRow = await page.locator("main p, main nav").last().boundingBox();
        const barTop = (await bar.boundingBox())?.y ?? 0;
        expect((lastRow?.y ?? 0) + (lastRow?.height ?? 0), "the page's last line clears the bar").toBeLessThanOrEqual(barTop);

        await bar.getByRole("link", { name: "Tasks" }).click();
        await expect(page).toHaveURL(new RegExp(`${base}/tasks`));
        await expect(bar.getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
        await expect(bar.getByRole("link", { name: "Issues" })).not.toHaveAttribute("aria-current", "page");

        // An open issue replaces the list; the bar stays, and the way back is labelled.
        await page.goto(`${base}/issues/${issue?.id}`);
        await expect(page.getByTestId("issue-panel")).toBeVisible();
        await expect(bar.getByRole("link", { name: "Issues" })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("button", { name: "Back to issues" })).toBeVisible();
        await axe(page, `an open issue on a phone (${theme})`);

        // Menu opens the rail, with every other place by name.
        await bar.getByRole("button", { name: "Menu" }).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        // (Some carry a count after the name.)
        for (const name of ["Files", "Pull requests", "Branches & reports", "Compare", "Analytics", "Activity", "Agents & API", "Settings"])
            await expect(sheet.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
        await axe(page, `the menu on a phone (${theme})`);
        await sheet.getByRole("link", { name: "Activity", exact: true }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
        await expect(sheet).toHaveCount(0);
        await expect(bar.locator('[aria-current="page"]')).toHaveCount(0);
    });

test("from the md breakpoint up the rail is visible and the bottom bar isn't", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(`/w/${ws}/p/${project}/overview`);
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Project" })).toBeVisible();
    await page.setViewportSize({ width: 767, height: 900 });
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("a workspace with no project still gets a bar on a phone: the places that need none, and Menu", async ({ page, admin }) => {
    const ws = `empty-${Date.now().toString(36)}`;
    await admin.post("/api/v1/workspaces", { slug: ws, name: "Nothing here" });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.setViewportSize(PHONE);
    await page.goto(`/w/${ws}/analytics`);
    await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
    const bar = page.getByRole("navigation", { name: "Main" });
    await expect(bar.getByRole("listitem")).toHaveText(["Analytics", "Agents & API", "Settings", "Menu"]);
    await expect(bar.getByRole("link", { name: "Analytics" })).toHaveAttribute("aria-current", "page");
});

test("on a phone nothing scrolls the page sideways: an open issue's code scrolls inside itself, and a branch's actions are in reach", async ({
    page,
    admin,
}) => {
    const { ws, project } = await seedProject(admin);
    await admin.post(`/api/v1/w/${ws}/p/${project}/reports`, {
        branch: "feature/a-long-branch-name-for-the-checkout",
        fileName: "pr.json",
        report: REPORT,
    });
    const issues = await issuesOf(admin, ws, project);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.setViewportSize(PHONE);
    const base = `/w/${ws}/p/${project}`;

    // Every issue with code: the diff is far wider than the screen.
    for (const issue of issues.slice(0, 4)) {
        await page.goto(`${base}/issues/${issue.id}`);
        await expect(page.getByTestId("issue-panel")).toBeVisible();
        await expectNoSidewaysScroll(page, `issue ${issue.title}`);
    }
    const code = page.getByTestId("issue-panel").locator("pre").first();
    if (await code.count()) {
        const box = await code.boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0), "the code block ends inside the screen").toBeLessThanOrEqual(PHONE.width);
    }
    await page.goto(`${base}/tasks/top-issues-1`);
    await expect(page.getByTestId("task-panel")).toBeVisible();
    await expectNoSidewaysScroll(page, "an open task");

    await page.goto(`${base}/branches`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSidewaysScroll(page, "Branches & reports");
    // The row's actions are on screen without scrolling the table.
    const row = page.getByTestId("branch-feature/a-long-branch-name-for-the-checkout");
    for (const name of ["History", "Move", "Delete"]) {
        const box = await row.getByRole("button", { name: new RegExp(`^${name}`) }).boundingBox();
        expect(box?.x, `${name} starts on screen`).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0), `${name} ends on screen`).toBeLessThanOrEqual(PHONE.width);
    }
    const frame = row.locator("xpath=ancestor::*[@data-slot='table-container']");
    expect(await frame.evaluate((el) => el.scrollWidth - el.clientWidth), "the branches table fits its frame").toBeLessThanOrEqual(1);
});

/** Contrast between two CSS colours as the browser paints them (oklch included), the first laid over the second. */
async function contrast(el: Locator, property: "color" | "borderTopColor") {
    return el.evaluate((node, prop) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
        const over = (colours: string[]) => {
            ctx.clearRect(0, 0, 1, 1);
            for (const c of colours) {
                ctx.fillStyle = c;
                ctx.fillRect(0, 0, 1, 1);
            }
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            return [r ?? 0, g ?? 0, b ?? 0];
        };
        // Everything painted behind the button, from the page up.
        const behind: string[] = [];
        for (let e: Element | null = node; e; e = e.parentElement) behind.unshift(getComputedStyle(e).backgroundColor);
        const background = over(["#ffffff", ...behind]);
        const front = over([`rgb(${background.join(",")})`, getComputedStyle(node)[prop]]);
        const lum = (rgb: number[]) => {
            const [r, g, b] = rgb.map((v) => {
                const s = v / 255;
                return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
        };
        const [a, b] = [lum(background), lum(front)].sort((x, y) => y - x);
        return ((a ?? 0) + 0.05) / ((b ?? 0) + 0.05);
    }, property);
}

for (const theme of ["light", "dark"] as const)
    test(`destructive actions are outlined in the danger colour, with an icon, last in their row (${theme})`, async ({ page, admin }) => {
        const { ws, project } = await seedProject(admin);
        await admin.post(`/api/v1/w/${ws}/p/${project}/reports`, { branch: "feature/login", fileName: "pr.json", report: REPORT });
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        await page.goto(`/w/${ws}/p/${project}/branches`);
        const row = page.getByTestId("branch-feature/login");
        const remove = row.getByRole("button", { name: "Delete feature/login" });
        await expect(remove).toBeVisible();
        await expect(remove).toHaveClass(/border-destructive/);
        await expect(remove.locator("svg")).toHaveCount(1);
        // Not a filled red button: that is the confirming button of the dialog only.
        expect(await remove.evaluate((el) => getComputedStyle(el).backgroundColor === getComputedStyle(el).borderTopColor)).toBe(false);
        expect(await contrast(remove, "color"), "danger text against its background").toBeGreaterThanOrEqual(4.5);
        expect(await contrast(remove, "borderTopColor"), "danger border against its background").toBeGreaterThanOrEqual(3);

        // Last in the row, with more room before it than between the harmless actions.
        const history = await row.getByRole("button", { name: "History of feature/login" }).boundingBox();
        const move = await row.getByRole("button", { name: "Move feature/login" }).boundingBox();
        const del = await remove.boundingBox();
        const between = (move?.x ?? 0) - ((history?.x ?? 0) + (history?.width ?? 0));
        const before = (del?.x ?? 0) - ((move?.x ?? 0) + (move?.width ?? 0));
        expect(before, "space before Delete").toBeGreaterThanOrEqual(between + 8);

        // Asking first: the dialog names the thing, says what happens to it, and starts on the safe choice.
        await remove.click();
        const dialog = page.getByRole("alertdialog", { name: "Delete the report for feature/login?" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
        const confirm = dialog.getByRole("button", { name: "Delete branch report" });
        await expect(confirm).toBeDisabled();
        await expect(confirm).toHaveClass(/bg-destructive/);
        await axe(page, `the delete dialog (${theme})`);
        await page.keyboard.press("Escape");

        // The project's own delete is the same outlined kind on the page.
        await page.goto(`/w/${ws}/p/${project}/settings/general`);
        const deleteProject = page.getByRole("button", { name: "Delete project" });
        await expect(deleteProject).toHaveClass(/border-destructive/);
        await expect(deleteProject).not.toHaveClass(/(^|\s)bg-destructive(\s|$)/);
        await expect(deleteProject.locator("svg")).toHaveCount(1);
        expect(await contrast(deleteProject, "color"), "danger text on a settings section").toBeGreaterThanOrEqual(4.5);
    });

test("labelled actions have a border or a fill, and Cancel is the same in every dialog", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    const [issue] = await issuesOf(admin, ws, project);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    const base = `/w/${ws}/p/${project}`;
    /** Buttons with words on them that have neither a border nor a background of their own. */
    const bare = () =>
        page.locator("main button, main a[data-slot=button]").evaluateAll((buttons) =>
            buttons
                // With words to read on them: an icon everyone knows (show password, close) may stand bare.
                .filter((b) => {
                    const seen = b.cloneNode(true) as HTMLElement;
                    for (const hidden of seen.querySelectorAll(".sr-only")) hidden.remove();
                    return (b as HTMLElement).offsetParent !== null && (seen.textContent ?? "").trim() !== "";
                })
                .filter(
                    (b) =>
                        !b.closest("[role=tablist], [role=switch]") &&
                        b.getAttribute("role") !== "switch" &&
                        b.getAttribute("role") !== "checkbox",
                )
                .filter((b) => {
                    const s = getComputedStyle(b);
                    const none = (c: string) => c === "rgba(0, 0, 0, 0)" || c === "transparent";
                    return (Number.parseFloat(s.borderTopWidth) === 0 || none(s.borderTopColor)) && none(s.backgroundColor);
                })
                .map((b) => (b.textContent ?? "").trim()),
        );
    for (const path of [
        `${base}/issues/${issue?.id}`,
        `${base}/branches`,
        `/w/${ws}/settings/users`,
        `/w/${ws}/settings/models`,
        `/w/${ws}/settings/tokens`,
    ]) {
        await page.goto(path);
        await expect(page.locator("main").getByRole("heading").first()).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        expect(await bare(), `buttons without a border or fill on ${path}`).toEqual([]);
    }

    // Cancel: outlined beside the filled button, in a plain dialog and in a confirmation alike.
    await page.goto(`${base}/branches`);
    await page.getByRole("button", { name: "Move main" }).click();
    const outlined = (cancel: Locator) => cancel.evaluate((el) => Number.parseFloat(getComputedStyle(el).borderTopWidth) > 0);
    expect(await outlined(page.getByRole("dialog").getByRole("button", { name: "Cancel" }))).toBe(true);
    await page.keyboard.press("Escape");
    await page.goto(`${base}/issues/${issue?.id}`);
    await page.getByTestId("issue-panel").getByLabel("Add a note").fill("A note to delete");
    await page.getByTestId("issue-panel").getByRole("button", { name: "Add note" }).click();
    await page
        .getByTestId("issue-panel")
        .getByRole("button", { name: /^Delete your note/ })
        .click();
    const ask = page.getByRole("alertdialog", { name: "Delete this note?" });
    await expect(ask).toContainText("can't be undone");
    expect(await outlined(ask.getByRole("button", { name: "Cancel" }))).toBe(true);
    await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(ask.getByRole("button", { name: "Delete note" })).toBeVisible();
});

test("the issue list says what its marks mean in words, and its filter buttons show they open something", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    const [issue] = await issuesOf(admin, ws, project);
    await admin.post(`/api/v1/w/${ws}/p/${project}/issues/bulk`, { ids: [issue?.id], needsDiscussion: true, note: "Is this one real?" });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/p/${project}/issues`);
    const row = page.locator(`[data-issue-row="${issue?.id}"]`);
    await expect(row.getByTestId("issue-flags")).toContainText("Needs discussion");
    await expect(row.getByTestId("issue-flags")).toContainText("1 note");
    // No mark is an icon alone: every one of them has words beside it.
    const bare = await page
        .getByTestId("issue-flags")
        .locator("> span")
        .evaluateAll((marks) => marks.filter((m) => !(m.textContent ?? "").trim()).length);
    expect(bare).toBe(0);

    const filters = page.getByRole("search", { name: "Filter issues" });
    for (const name of ["Severity", "Status", "Category", "File, assignee, flags", "Most urgent first"]) {
        const button = filters.getByRole("button", { name });
        await expect(button.locator("svg.lucide-chevron-down")).toHaveCount(1);
    }
    await expect(filters.getByRole("button", { name: "More filters" })).toHaveCount(0);
    // What the button says is what it holds.
    await filters.getByRole("button", { name: "File, assignee, flags" }).click();
    const popover = page.getByRole("dialog");
    await expect(popover.getByLabel("File or folder")).toBeVisible();
    await expect(popover.getByLabel("Assignee")).toBeVisible();
    await expect(popover.getByLabel("Needs discussion")).toBeVisible();
});
