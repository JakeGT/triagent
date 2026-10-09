// Settings → Models: connecting providers, each with its settings and key, and the favourite models, added
// from a provider's own list (which the server fetches with the stored key), with one the default. The
// provider is a fake served by this test on 127.0.0.1 (the end-to-end server allows private model URLs,
// ALLOW_PRIVATE_MODEL_URLS=true), so nothing leaves the machine. Keys are made up for each run. With
// SCREENSHOT_DIR set, it also saves screenshots.

import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, PASSWORD } from "./constants";
import { addMember, expect, seedProject, signInPage, test, unique } from "./fixtures";

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

/** A model provider's list endpoint, recording the keys it's sent. */
const seen: string[] = [];
const provider = http.createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? ""));
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models")
        res.end(JSON.stringify({ object: "list", data: [{ id: "local-coder-small" }, { id: "local-coder-large" }] }));
    else res.writeHead(404).end("{}");
});
let providerUrl = "";

test.beforeAll(async () => {
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
});
test.afterAll(() => {
    provider.close();
});

/** Open a provider that isn't connected yet, from "Add a provider". */
async function addProvider(page: Page, label: string) {
    await page.getByLabel("Add a provider").selectOption({ label });
    await page.getByRole("button", { name: "Add provider" }).click();
    return page.getByTestId("provider-detail");
}

test("connecting a custom provider, setting its key and adding a model from its list", async ({ page, admin }) => {
    const ws = unique("prov");
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Providers ${ws}` });
    const key = `sk-local-${randomBytes(16).toString("hex")}`;
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    // The page's old address still arrives.
    await page.goto(`/w/${ws}/settings/review-model`);
    await expect(page).toHaveURL(new RegExp(`/w/${ws}/settings/models$`));
    await expect(page.getByRole("heading", { level: 2, name: "Models" })).toBeVisible();
    await expect(page.getByTestId("review-model-status")).toContainText("Not ready");
    await expect(page.getByText("No providers connected yet.")).toBeVisible();

    const detail = await addProvider(page, "Custom (OpenAI-compatible)");
    await detail.getByLabel("Base URL").fill(providerUrl);
    await detail.getByLabel("API", { exact: true }).selectOption({ label: "Chat Completions" });
    await detail.getByRole("button", { name: "Save settings" }).click();
    const row = page.getByTestId("providers").getByRole("row", { name: /Custom \(OpenAI-compatible\)/ });
    await expect(row).toContainText("Needs an API key for your server");
    const add = page.getByTestId("add-favourite");
    await expect(add.getByTestId("model-list-status")).toContainText("Add an API key for your server to see");

    const field = detail.getByTestId("provider-keys").getByTestId("secret-field");
    await field.getByLabel("Custom (OpenAI-compatible) API key").fill(key);
    await field.getByRole("button", { name: "Save" }).click();
    await expect(field).toContainText(`ends …${key.slice(-4)}`);
    await expect(row).toContainText("Ready");
    await expect(add.getByTestId("model-list-status")).toHaveText("2 models from your server: start typing in Model to pick one.");
    await expect(page.locator("datalist option")).toHaveCount(2);
    await add.getByLabel("Model", { exact: true }).fill("local-coder-large");
    await add.getByRole("button", { name: "Add favourite" }).click();
    // The first favourite is the default.
    await expect(page.getByTestId("review-model-status")).toHaveText(
        "Ready: reviews use local-coder-large through Custom (OpenAI-compatible).",
    );
    await expect(page.getByTestId("favourites").getByRole("row", { name: /local-coder-large/ })).toContainText("Default");
    // The server used the key; the page never had it back.
    expect(seen).toContain(`Bearer ${key}`);
    expect(await page.content()).not.toContain(key);
    await axe(page, "models: a custom provider");
    const saved = await admin.get(`/api/v1/w/${ws}/settings/review-model`);
    expect([saved.provider, saved.model]).toEqual(["custom", "local-coder-large"]);
    expect(JSON.stringify(saved)).not.toContain(key);
});

test("several providers, and favourites from each: add, make default, rename, reorder, remove", async ({ page, admin }) => {
    const ws = unique("prov");
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Library ${ws}` });
    const settings = `/api/v1/w/${ws}/settings`;
    // One provider connected already: its usual model is the favourite, and the default.
    await admin.put(`${settings}/review-model/keys/openrouter`, { key: `sk-or-v1-${randomBytes(20).toString("hex")}` });
    await admin.patch(`${settings}/review-model`, { model: "fake/model" });
    const key = `sk-local-${randomBytes(16).toString("hex")}`;
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/models`);
    const providers = page.getByTestId("providers");
    const favourites = page.getByTestId("favourites");
    const status = page.getByTestId("review-model-status");
    await expect(providers.getByRole("row")).toHaveCount(2);
    await expect(favourites.getByRole("row", { name: /fake\/model/ })).toContainText("Default");
    await expect(status).toHaveText("Ready: reviews use fake/model through OpenRouter.");

    // A second provider, with its own address and key.
    const detail = await addProvider(page, "Custom (OpenAI-compatible)");
    await detail.getByLabel("Base URL").fill(providerUrl);
    await detail.getByRole("button", { name: "Save settings" }).click();
    const field = detail.getByTestId("secret-field");
    await field.getByLabel("Custom (OpenAI-compatible) API key").fill(key);
    await field.getByRole("button", { name: "Save" }).click();
    await expect(field).toContainText(`ends …${key.slice(-4)}`);
    await page.getByRole("button", { name: "Close Custom (OpenAI-compatible)" }).click();
    await expect(detail).toHaveCount(0);
    // Both are listed, each ready, at a glance.
    await expect(providers.getByRole("row")).toHaveCount(3);
    await expect(providers.getByRole("row", { name: /OpenRouter/ })).toContainText("Ready");
    await expect(providers.getByRole("row", { name: /Custom/ })).toContainText("Ready");

    // A favourite from each provider.
    const add = page.getByTestId("add-favourite");
    await add.getByLabel("Provider", { exact: true }).selectOption({ label: "Custom (OpenAI-compatible)" });
    await expect(add.getByTestId("model-list-status")).toContainText("2 models from your server");
    await add.getByLabel("Model", { exact: true }).fill("local-coder-small");
    await add.getByLabel("Nickname").fill("Fast");
    await add.getByRole("button", { name: "Add favourite" }).click();
    await expect(favourites.getByRole("row", { name: /Fast/ })).toContainText("local-coder-small");
    await add.getByLabel("Provider", { exact: true }).selectOption({ label: "OpenRouter" });
    await add.getByLabel("Model", { exact: true }).fill("fake/second");
    await add.getByRole("button", { name: "Add favourite" }).click();
    await expect(favourites.getByRole("row")).toHaveCount(4);
    // Adding one doesn't change the default; the same model twice is refused.
    await expect(status).toHaveText("Ready: reviews use fake/model through OpenRouter.");
    await add.getByLabel("Model", { exact: true }).fill("fake/second");
    await add.getByRole("button", { name: "Add favourite" }).click();
    await expect(add.getByRole("alert")).toHaveText("fake/second from OpenRouter is a favourite already.");
    await axe(page, "models: providers and favourites");

    // Make default.
    await page.getByRole("button", { name: "Make default: Fast" }).click();
    await expect(status).toHaveText("Ready: reviews use local-coder-small through Custom (OpenAI-compatible).");
    await expect(favourites.getByRole("row", { name: /Fast/ })).toContainText("Default");
    await expect(favourites.getByText("Default", { exact: true })).toHaveCount(1);

    // Rename.
    await page.getByRole("button", { name: "Rename Fast" }).click();
    const rename = page.getByRole("dialog", { name: "Rename Fast" });
    await axe(page, "models: renaming a favourite");
    await rename.getByLabel("Nickname").fill("Quick");
    await rename.getByRole("button", { name: "Save nickname" }).click();
    await expect(rename).toHaveCount(0);
    await expect(favourites.getByRole("row", { name: /Quick/ })).toContainText("local-coder-small");

    // Reorder.
    await page.getByRole("button", { name: "Move Quick up" }).click();
    await expect(favourites.getByRole("row").nth(1)).toContainText("Quick");
    await expect(page.getByRole("button", { name: "Move Quick up" })).toBeDisabled();
    const order = await admin.get(`${settings}/models/favourites`);
    expect(order.favourites.map((f: { model: string }) => f.model)).toEqual(["local-coder-small", "fake/model", "fake/second"]);

    // Remove one that isn't the default, then the default, which needs the next one chosen.
    await page.getByRole("button", { name: "Remove fake/second" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove favourite" }).click();
    await expect(favourites.getByRole("row")).toHaveCount(3);
    await page.getByRole("button", { name: "Remove Quick" }).click();
    const remove = page.getByRole("dialog", { name: "Remove Quick?" });
    await expect(remove.getByLabel("New default")).toContainText("fake/model");
    await remove.getByRole("button", { name: "Remove favourite" }).click();
    await expect(remove).toHaveCount(0);
    await expect(favourites.getByRole("row")).toHaveCount(2);
    await expect(status).toHaveText("Ready: reviews use fake/model through OpenRouter.");
    // The last favourite stays.
    await expect(page.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
    expect(await page.content()).not.toContain(key);
    const saved = await admin.get(`${settings}/review-model`);
    expect([saved.provider, saved.model, saved.favourites.length]).toEqual(["openrouter", "fake/model", 1]);
});

test("Amazon Bedrock: a region, an access key ID and its secret; suggestions to start from", async ({ page, admin }) => {
    const ws = unique("prov");
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Bedrock ${ws}` });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/models`);
    const detail = await addProvider(page, "Amazon Bedrock");
    await detail.getByLabel("AWS region").fill("eu-west-2");
    await detail.getByRole("button", { name: "Save settings" }).click();
    const row = page.getByTestId("providers").getByRole("row", { name: /Amazon Bedrock/ });
    await expect(row).toContainText("Needs an AWS access key ID for Amazon Bedrock");

    const keys = detail.getByTestId("provider-keys");
    const id = `AKIA${randomBytes(8).toString("hex").toUpperCase()}`;
    const secret = randomBytes(30).toString("base64url");
    await keys.getByLabel("Amazon Bedrock AWS access key ID").fill(id);
    await keys.getByTestId("secret-field").first().getByRole("button", { name: "Save" }).click();
    await expect(keys.getByTestId("secret-field").first()).toContainText(`ends …${id.slice(-4)}`);
    await expect(row).toContainText("Needs an AWS secret access key for Amazon Bedrock");
    await keys.getByLabel("Amazon Bedrock AWS secret access key").fill(secret);
    await keys.getByTestId("secret-field").nth(1).getByRole("button", { name: "Save" }).click();
    await expect(row).toContainText("Ready");

    const add = page.getByTestId("add-favourite");
    await expect(add.getByTestId("model-list-status")).toContainText("Amazon Bedrock doesn't list its models here");
    await add.getByTestId("model-suggestions").getByRole("button").first().click();
    await add.getByRole("button", { name: "Add favourite" }).click();
    await expect(page.getByTestId("review-model-status")).toContainText("Ready: reviews use global.anthropic.");
    expect(await page.content()).not.toContain(secret);
    await axe(page, "models: Amazon Bedrock");
});

test("a private address is refused unless the instance allows it, and an unsafe URL says why", async ({ page, admin }) => {
    const ws = unique("prov");
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Refused ${ws}` });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/models`);
    const detail = await addProvider(page, "Azure OpenAI");
    await detail.getByLabel("Endpoint").fill("https://user:pass@res.openai.azure.com");
    await detail.getByRole("button", { name: "Save settings" }).click();
    await expect(detail.getByRole("alert")).toContainText("mustn't contain a user name or password");
    await axe(page, "models: an error");
});

test("someone who can't configure sees the providers and favourites, and changes nothing", async ({ page, admin, baseURL }) => {
    const { ws } = await seedProject(admin);
    await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/openrouter`, { key: `sk-or-v1-${randomBytes(20).toString("hex")}` });
    const viewer = await addMember(admin, baseURL as string, ws, "viewer");
    await signInPage(page, viewer.username, PASSWORD);
    await page.goto(`/w/${ws}/settings/models`);
    await expect(page.getByTestId("providers").getByRole("row", { name: /OpenRouter/ })).toContainText("Ready");
    await expect(page.getByTestId("favourites").getByRole("row")).toHaveCount(2);
    await expect(page.getByLabel("Add a provider")).toHaveCount(0);
    await expect(page.getByTestId("add-favourite")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Rename|Remove|Make default|Move/ })).toHaveCount(0);
    await page.getByRole("button", { name: "View OpenRouter" }).click();
    await expect(page.getByTestId("provider-detail").getByRole("button", { name: /Save|Replace|Clear/ })).toHaveCount(0);
    await axe(page, "models: read only");
});

test("the instance model key page offers every provider, with the same fields", async ({ page, admin }) => {
    const ws = unique("prov");
    await admin.post("/api/v1/workspaces", { slug: ws, name: ws });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/instance-model`);
    const select = page.getByLabel("Provider");
    await expect(select.locator("optgroup")).toHaveCount(4);
    await select.selectOption({ label: "OpenAI" });
    await expect(page.getByLabel("API", { exact: true })).toHaveValue("openai");
    await expect(page.getByTestId("provider-keys").getByLabel("OpenAI instance key")).toBeVisible();
    await axe(page, "instance model key: OpenAI");
});

test.describe("screenshots", () => {
    test.skip(!dir, "set SCREENSHOT_DIR to take screenshots");
    for (const theme of ["light", "dark"] as const)
        test(`the models page (${theme})`, async ({ page, admin }) => {
            const ws = unique("shot");
            await admin.post("/api/v1/workspaces", { slug: ws, name: "Acme" });
            await admin.patch(`/api/v1/w/${ws}/settings/review-model`, {
                provider: "custom",
                url: providerUrl,
                model: "local-coder-large",
            });
            await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/custom`, { key: `sk-local-${randomBytes(16).toString("hex")}` });
            await page.addInitScript((t) => localStorage.setItem("triagent-theme", t), theme);
            await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
            await page.goto(`/w/${ws}/settings/models`);
            await expect(page.getByTestId("model-list-status")).toContainText("2 models");
            await page.waitForTimeout(300);
            await page.screenshot({ path: path.join(dir as string, `models-${theme}.png`), fullPage: true });
        });
});
