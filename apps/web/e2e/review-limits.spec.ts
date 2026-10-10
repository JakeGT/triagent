// Settings → Instance → Reviews, and a workspace's own limit on the Workspaces page: setting how many
// reviews run at once, beside the runners; who may; the Runs page saying what applies; both pages
// accessible in light and dark and no wider than a phone.
//
// The tests share one server with every other test, and these limits are the whole instance's: they're
// only ever raised here (never below the server's own four, the runner's four slots), so no other
// test's reviews wait because of this one.

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, PASSWORD } from "./constants";
import { addMember, expect, seedProject, signInPage, test, unique } from "./fixtures";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

async function axe(page: Page, what: string) {
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const problems = results.violations.map(
        (v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary}`).join("\n  ")}`,
    );
    expect(problems, `accessibility problems on ${what}`).toEqual([]);
}

const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings" });

test("an instance admin sets how many reviews run at once, beside the runners", async ({ page, admin }) => {
    const { ws, project } = await seedProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/projects`);
    await settingsNav(page).getByRole("link", { name: "Reviews", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Reviews", level: 2 })).toBeVisible();

    const instance = page.getByLabel("At once on this instance");
    const perWorkspace = page.getByLabel("At once in one workspace");
    const before = await admin.get("/api/v1/instance/reviews");
    await expect(instance).toHaveValue(String(before.limits.instance));
    await expect(perWorkspace).toHaveValue(String(before.limits.perWorkspace));
    const save = page.getByRole("button", { name: "Save limits" });
    await expect(save).toBeDisabled();

    // The runner the tests start works on four reviews at once.
    const runner = page.getByTestId("runner-e2e-runner");
    await expect(runner).toContainText("0.1.0");
    await expect(runner).toContainText(/\d of 4/);
    await expect(page.getByTestId("capacity-note")).toContainText("The connected runner can work on 4 reviews at once");

    // Not a limit: said beside the field, nothing saved, what was typed kept.
    await instance.fill("0");
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("Give a whole number from 1 to 100.");
    await expect(instance).toHaveValue("0");
    expect((await admin.get("/api/v1/instance/reviews")).limits).toEqual(before.limits);

    // More than the runner can do: saved, and the page says reviews past four wait for a runner slot.
    const next = before.limits.instance === 6 ? 7 : 6;
    await instance.fill(String(next));
    await save.click();
    await expect(page.getByText("Limits saved.")).toBeVisible();
    await expect(page.getByTestId("limits-source")).toContainText("Saved by");
    await expect(page.getByTestId("capacity-note")).toContainText(
        `fewer than this instance's limit of ${next}: reviews past 4 wait for a free runner slot.`,
    );
    await expect(save).toBeDisabled();
    expect((await admin.get("/api/v1/instance/reviews")).limits).toEqual({ instance: next, perWorkspace: before.limits.perWorkspace });
    await page.reload();
    await expect(instance).toHaveValue(String(next));

    // The Runs page says what applies here, with the way back for an instance admin.
    await page.goto(`/w/${ws}/p/${project}/runs`);
    await expect(
        page.getByText(`At most ${next} reviews at once on this instance, ${before.limits.perWorkspace} in this workspace.`),
    ).toBeVisible();
    await page.getByRole("link", { name: "Change the limits" }).click();
    await expect(page.getByRole("heading", { name: "Reviews", level: 2 })).toBeVisible();
});

test("a workspace is given its own limit on the Workspaces page, and its Runs page says so", async ({ page, admin }) => {
    const { ws } = await seedProject(admin);
    const other = (await seedProject(admin)).ws;
    const name = `Org ${other}`;
    const limits = (await admin.get("/api/v1/instance/reviews")).limits as { instance: number; perWorkspace: number };
    const own = async () =>
        ((await admin.get("/api/v1/instance/workspaces")).items as { slug: string; reviewLimit: number | null }[]).find(
            (w) => w.slug === other,
        )?.reviewLimit;
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/instance-workspaces`);
    await expect(page.getByTestId("review-limits-note")).toContainText(`Leave it empty for the default (${limits.perWorkspace}).`);
    await page.getByLabel("Find a workspace").fill(other);
    const row = page.getByTestId(`grant-${other}`);
    const field = row.getByLabel(`Reviews at once in ${name}`);
    await expect(field).toHaveValue("");
    await expect(field).toHaveAttribute("placeholder", `Default (${limits.perWorkspace})`);

    await field.fill("lots");
    await row.getByRole("button", { name: `Set ${name}'s reviews at once` }).click();
    await expect(row.getByRole("alert")).toHaveText("Give a whole number from 1 to 100, or leave it empty for the default.");
    expect(await own()).toBeNull();

    await field.fill("3");
    await row.getByRole("button", { name: `Set ${name}'s reviews at once` }).click();
    await expect(page.getByText(`${name} runs up to 3 reviews at once.`)).toBeVisible();
    await expect(row.getByRole("button", { name: `Change ${name}'s reviews at once` })).toBeVisible();
    expect(await own()).toBe(3);

    // Its own Runs page says three; the other workspace's still says the default.
    await page.goto(`/w/${other}/p/app/runs`);
    await expect(page.getByText(`on this instance, ${Math.min(3, limits.instance)} in this workspace.`)).toBeVisible();
    await page.goto(`/w/${ws}/p/app/runs`);
    await expect(page.getByText(`on this instance, ${limits.perWorkspace} in this workspace.`)).toBeVisible();

    // Emptied: the default again.
    await page.goto(`/w/${ws}/settings/instance-workspaces`);
    await page.getByLabel("Find a workspace").fill(other);
    await expect(field).toHaveValue("3");
    await field.fill("");
    await row.getByRole("button", { name: `Change ${name}'s reviews at once` }).click();
    await expect(page.getByText(`${name} goes by the default again: ${limits.perWorkspace} at once.`)).toBeVisible();
    await expect(row.getByRole("button", { name: `Set ${name}'s reviews at once` })).toBeVisible();
    expect(await own()).toBeNull();
});

test("the limits are for instance admins only; a workspace admin still sees what applies to their workspace", async ({
    page,
    admin,
    baseURL,
}) => {
    const { ws, project } = await seedProject(admin);
    const member = await addMember(admin, baseURL as string, ws, "admin");
    await member.api.ctx.dispose();
    await signInPage(page, member.username, PASSWORD);
    await page.goto(`/w/${ws}/settings/instance-reviews`);
    await expect(page.getByText("Only instance administrators can change how many reviews run at once.")).toBeVisible();
    await expect(settingsNav(page).getByRole("link", { name: "Reviews", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("At once on this instance")).toHaveCount(0);
    expect((await page.request.get("/api/v1/instance/reviews")).status()).toBe(403);
    await page.goto(`/w/${ws}/p/${project}/runs`);
    await expect(page.getByText(/At most \d+ reviews? at once on this instance, \d+ in this workspace\./)).toBeVisible();
    await expect(page.getByRole("link", { name: "Change the limits" })).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const)
    test(`the Reviews page and the Workspaces page are accessible, at desktop and phone widths (${theme})`, async ({ page, admin }) => {
        test.slow();
        const { ws } = await seedProject(admin);
        // A workspace with an allowance and a limit of its own, so every part of a row is there.
        const other = unique("org");
        await admin.post("/api/v1/workspaces", { slug: other, name: `Limits ${other}` });
        const made = ((await admin.get("/api/v1/instance/workspaces")).items as { id: string; slug: string }[]).find(
            (w) => w.slug === other,
        );
        await admin.put(`/api/v1/instance/workspaces/${made?.id}/review-limit`, { limit: 2 });
        await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
        await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`/w/${ws}/settings/instance-reviews`);
            await expect(page.locator("html")).toHaveClass(new RegExp(theme));
            await expect(page.getByTestId("runner-e2e-runner")).toBeVisible();
            // With an error showing too.
            const instance = page.getByLabel("At once on this instance");
            const was = await instance.inputValue();
            await instance.fill("1000");
            await page.getByRole("button", { name: "Save limits" }).click();
            await expect(page.getByRole("alert")).toBeVisible();
            await axe(page, `Reviews at ${width}px (${theme})`);
            expect(await page.evaluate(() => document.documentElement.scrollWidth), `width of Reviews at ${width}px`).toBeLessThanOrEqual(
                width,
            );
            await instance.fill(was);

            await page.goto(`/w/${ws}/settings/instance-workspaces`);
            await page.getByLabel("Find a workspace").fill(other);
            await expect(page.getByLabel(`Reviews at once in Limits ${other}`)).toHaveValue("2");
            await axe(page, `Workspaces at ${width}px (${theme})`);
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth),
                `width of Workspaces at ${width}px`,
            ).toBeLessThanOrEqual(width);
        }
    });
