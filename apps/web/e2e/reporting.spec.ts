// Error reporting, end to end: the main end-to-end server reports to a fake Sentry
// (tests/fakes/sentry-server.ts), so these check what would actually leave an instance, and that the
// app's SDK works under the Content Security Policy (every test fails on a violation: fixtures.ts).

import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, signInPage, test } from "./fixtures";

interface Item {
    type: string;
    project: string;
    // biome-ignore lint/suspicious/noExplicitAny: envelope payloads are checked field by field
    payload: any;
    raw: string;
}

const items = async (): Promise<Item[]> => (await fetch(`${process.env.E2E_SENTRY_URL}/_fake/items`)).json() as Promise<Item[]>;

test("a fault in the app is reported through the server, without what it shouldn't carry", async ({ page }) => {
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    const marker = `e2e-fault-${Date.now()}`;
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The page says where reports belong; the app sends them to its own server, never to Sentry itself.
    await expect(page.locator('meta[name="triagent-reporting"]')).toHaveAttribute("content", /browserkey/);
    const sent = page.waitForResponse((r) => r.url().endsWith("/api/v1/telemetry") && r.request().method() === "POST");
    await page.evaluate((m) => {
        // The address has something private in it when the fault happens, as a search or a sign-in's return does.
        history.replaceState(history.state, "", `${location.pathname}?search=private-words`);
        setTimeout(() => {
            throw new Error(`${m} with tri_abcdefghijklmnopqrstuvwx in it`);
        });
    }, marker);
    expect((await sent).status()).toBe(200);

    await expect.poll(async () => (await items()).some((i) => i.type === "event" && i.raw.includes(marker))).toBe(true);
    const event = (await items()).find((i) => i.type === "event" && i.raw.includes(marker)) as Item;
    // The web app's project, not the server's.
    expect(event.project).toBe("2");
    expect(event.payload.exception.values[0].value).toBe(`${marker} with [redacted] in it`);
    // Where it happened, without the query string; who, as an id and nothing else.
    expect(event.payload.request.url).toBe(page.url().replace(/\?.*$/, ""));
    expect(page.url()).toContain("private-words");
    expect(Object.keys(event.payload.user ?? {})).toEqual(["id"]);
    expect(event.payload.release).toBe("e2e");
    for (const never of ["private-words", "tri_abcdefghijklmnopqrstuvwx", "triagent_sid", "Cookie", ADMIN_PASSWORD])
        expect(event.raw, `the report holds ${never}`).not.toContain(never);
});

test("reports are only taken from the site's own pages, and only for its own project", async ({ request, baseURL }) => {
    const envelope = (dsn: string) =>
        `${JSON.stringify({ dsn })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ message: "x" })}\n`;
    const ours = `http://browserkey@127.0.0.1:${new URL(process.env.E2E_SENTRY_URL as string).port}/2`;
    const post = (body: string, headers: Record<string, string>) =>
        request.post("/api/v1/telemetry", { data: body, headers: { "content-type": "text/plain", ...headers } });
    expect((await post(envelope(ours), { origin: "https://elsewhere.example" })).status()).toBe(403);
    expect((await post(envelope("https://key@o1.ingest.sentry.io/99"), { origin: baseURL as string })).status()).toBe(403);
    expect((await post("not an envelope", { origin: baseURL as string })).status()).toBe(400);
    expect((await post(envelope(ours), { origin: baseURL as string })).status()).toBe(200);
});

test("the server's and the runner's log lines reach the error tracker, and requests are traced", async ({ request }) => {
    await request.get("/auth/config");
    await expect
        .poll(
            async () => {
                const logs = (await items())
                    .filter((i) => i.type === "log")
                    .flatMap((i) => i.payload.items as { body: string; attributes: Record<string, { value: unknown }> }[]);
                return {
                    // The runner has no way to Sentry of its own: its lines come through the server.
                    runner: logs.some(
                        (l) =>
                            l.body === "Started" && l.attributes.service?.value === "runner" && l.attributes.runner?.value === "e2e-runner",
                    ),
                    server: logs.some((l) => l.body === "Listening" && l.attributes.service?.value === "server"),
                };
            },
            { timeout: 20_000 },
        )
        .toEqual({ runner: true, server: true });
    await expect
        .poll(async () => (await items()).some((i) => i.type === "transaction" && i.payload.transaction === "GET /auth/config"), {
            timeout: 20_000,
        })
        .toBe(true);
    // Everything from the server and the runner went to their project.
    expect((await items()).filter((i) => i.type === "log").every((i) => i.project === "1")).toBe(true);
});
