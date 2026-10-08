// Model providers: choosing one, its settings and key, and a model from the provider's own list, which the
// server fetches with the stored key. The provider is a fake served by this test on 127.0.0.1 (the
// end-to-end server allows private model URLs, ALLOW_PRIVATE_MODEL_URLS=true), so nothing leaves the
// machine. Keys are made up for each run. With SCREENSHOT_DIR set, it also saves screenshots.

import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, signInPage, test, unique } from "./fixtures";

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

test("choosing a custom provider, setting its key and picking a model from its list", async ({ page, admin }) => {
    const ws = unique("prov");
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Providers ${ws}` });
    const key = `sk-local-${randomBytes(16).toString("hex")}`;
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/review-model`);
    await expect(page.getByTestId("review-model-status")).toContainText("Not ready");

    await page.getByLabel("Provider").selectOption({ label: "Custom (OpenAI-compatible)" });
    await page.getByLabel("Base URL").fill(providerUrl);
    await page.getByLabel("API", { exact: true }).selectOption({ label: "Chat Completions" });
    await page.getByRole("button", { name: "Save model" }).click();
    await expect(page.getByTestId("model-list-status")).toContainText("Add an API key for your server to see");

    const field = page.getByTestId("provider-keys").getByTestId("secret-field");
    await field.getByLabel("Custom (OpenAI-compatible) API key").fill(key);
    await field.getByRole("button", { name: "Save" }).click();
    await expect(field).toContainText(`ends …${key.slice(-4)}`);
    await expect(page.getByTestId("model-list-status")).toHaveText("2 models from your server: start typing in Model to pick one.");
    await expect(page.locator("datalist option")).toHaveCount(2);
    await page.getByLabel("Model", { exact: true }).fill("local-coder-large");
    await page.getByRole("button", { name: "Save model" }).click();
    await expect(page.getByTestId("review-model-status")).toHaveText(
        "Ready: reviews use local-coder-large through Custom (OpenAI-compatible).",
    );
    // The server used the key; the page never had it back.
    expect(seen).toContain(`Bearer ${key}`);
    expect(await page.content()).not.toContain(key);
    await axe(page, "review model: custom provider");
    const saved = await admin.get(`/api/v1/w/${ws}/settings/review-model`);
    expect([saved.provider, saved.model]).toEqual(["custom", "local-coder-large"]);
    expect(JSON.stringify(saved)).not.toContain(key);
});

test("Amazon Bedrock: a region, an access key ID and its secret; suggestions to start from", async ({ page, admin }) => {
    const ws = unique("prov");
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Bedrock ${ws}` });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/review-model`);
    await page.getByLabel("Provider").selectOption({ label: "Amazon Bedrock" });
    await page.getByLabel("AWS region").fill("eu-west-2");
    await expect(page.getByTestId("model-list-status")).toContainText("Amazon Bedrock doesn't list its models here");
    await page.getByTestId("model-suggestions").getByRole("button").first().click();
    await page.getByRole("button", { name: "Save model" }).click();
    await expect(page.getByTestId("review-model-status")).toContainText(/add an AWS access key ID for Amazon Bedrock/i);

    const keys = page.getByTestId("provider-keys");
    const id = `AKIA${randomBytes(8).toString("hex").toUpperCase()}`;
    const secret = randomBytes(30).toString("base64url");
    await keys.getByLabel("Amazon Bedrock AWS access key ID").fill(id);
    await keys.getByTestId("secret-field").first().getByRole("button", { name: "Save" }).click();
    await expect(keys.getByTestId("secret-field").first()).toContainText(`ends …${id.slice(-4)}`);
    await keys.getByLabel("Amazon Bedrock AWS secret access key").fill(secret);
    await keys.getByTestId("secret-field").nth(1).getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("review-model-status")).toContainText("Ready: reviews use global.anthropic.");
    expect(await page.content()).not.toContain(secret);
    await axe(page, "review model: Amazon Bedrock");
});

test("a private address is refused unless the instance allows it, and an unsafe URL says why", async ({ page, admin }) => {
    const ws = unique("prov");
    await admin.post("/api/v1/workspaces", { slug: ws, name: `Refused ${ws}` });
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/settings/review-model`);
    await page.getByLabel("Provider").selectOption({ label: "Azure OpenAI" });
    await page.getByLabel("Endpoint").fill("https://user:pass@res.openai.azure.com");
    await page.getByRole("button", { name: "Save model" }).click();
    await expect(page.getByRole("alert")).toContainText("mustn't contain a user name or password");
    await axe(page, "review model: an error");
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
        test(`the review model page (${theme})`, async ({ page, admin }) => {
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
            await page.goto(`/w/${ws}/settings/review-model`);
            await expect(page.getByTestId("model-list-status")).toContainText("2 models");
            await page.waitForTimeout(300);
            await page.screenshot({ path: path.join(dir as string, `review-model-${theme}.png`), fullPage: true });
        });
});
