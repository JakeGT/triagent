import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider, ReviewModel } from "@/lib/types";
import { ModelProviderForm } from "./model-provider-form";

const unset = (name: string) => ({ name, set: false, hint: null, setBy: null, setAt: null });

function provider(over: Partial<Provider> & Pick<Provider, "id" | "name" | "group">): Provider {
    return {
        protocols: ["openai"],
        protocol: "openai",
        url: `https://api.${over.id}.test/v1`,
        endpoint: null,
        region: null,
        docs: "https://docs.test",
        keyFormat: null,
        keysUrl: null,
        keyLabel: "API key",
        listsModels: true,
        suggested: [],
        fields: [],
        model: "",
        key: unset(`model-key:${over.id}`),
        accessKeyId: null,
        ready: false,
        missing: `a ${over.name} API key`,
        ...over,
    };
}

const DATA: ReviewModel = {
    provider: "mistral",
    model: "mistral-medium-latest",
    ready: true,
    missing: null,
    providers: [
        provider({
            id: "openai",
            name: "OpenAI",
            group: "Model makers",
            protocols: ["openai", "openai-responses"],
            suggested: ["gpt-6-astra"],
            model: "gpt-6-astra",
        }),
        provider({
            id: "mistral",
            name: "Mistral",
            group: "Model makers",
            suggested: ["mistral-medium-latest", "codestral-latest"],
            model: "mistral-medium-latest",
            key: { name: "model-key:mistral", set: true, hint: "…wxyz", setBy: "Sam", setAt: "2026-10-01T09:00:00.000Z" },
            ready: true,
            missing: null,
        }),
        provider({
            id: "bedrock",
            name: "Amazon Bedrock",
            group: "Cloud platforms",
            protocols: ["anthropic-bedrock"],
            protocol: "anthropic-bedrock",
            url: null,
            listsModels: false,
            fields: ["region", "accessKeyId"],
            keyLabel: "AWS secret access key",
            suggested: ["global.anthropic.claude-opus-4-6-v1"],
            model: "global.anthropic.claude-opus-4-6-v1",
            accessKeyId: unset("model-key:bedrock:access-key-id"),
        }),
    ],
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(fetchMock: ReturnType<typeof vi.fn>, data = DATA) {
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onSaved = vi.fn();
    render(
        <QueryClientProvider client={client}>
            <ModelProviderForm
                data={data}
                base="/api/v1/w/acme/settings/review-model"
                ws="acme"
                queryKey={["ws", "acme", "settings", "review-model"]}
                scope="workspace"
                canConfigure
                canSetSecrets
                onSaved={onSaved}
                refresh={async () => {}}
            />
        </QueryClientProvider>,
    );
    return { onSaved };
}

describe("ModelProviderForm", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("groups providers, lists the chosen one's models from the server, and offers its suggestions", async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url.endsWith("/providers/mistral/models"))
                return json({
                    provider: "mistral",
                    source: "provider",
                    models: [{ id: "mistral-large-latest", name: null }],
                    suggested: [],
                    fetchedAt: null,
                    error: null,
                });
            return json({});
        });
        setup(fetchMock);
        const select = screen.getByLabelText("Provider") as HTMLSelectElement;
        expect([...select.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Model makers", "Cloud platforms"]);
        expect(await screen.findByText("1 model from Mistral: start typing in Model to pick one.")).toBeTruthy();
        expect(screen.getByLabelText("Model").getAttribute("list")).toBeTruthy();
        const options = [...document.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"));
        expect(options).toEqual(["mistral-large-latest", "mistral-medium-latest", "codestral-latest"]);
        await userEvent.setup().click(within(screen.getByTestId("model-suggestions")).getByRole("button", { name: "codestral-latest" }));
        expect(screen.getByLabelText("Model")).toHaveProperty("value", "codestral-latest");
        // The key's status, never the key; and no API choice for a provider with one API.
        expect(screen.getByTestId("provider-keys").textContent).toContain("ends …wxyz");
        expect(screen.queryByLabelText("API")).toBeNull();
    });

    it("OpenAI offers the Responses API, and saving sends the provider's settings", async () => {
        const user = userEvent.setup();
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === "PATCH") return json({ ...DATA, provider: "openai", model: "gpt-5.5-pro" });
            return json({
                provider: "x",
                source: "provider",
                models: [],
                suggested: [],
                fetchedAt: null,
                error: "Add an OpenAI API key to see OpenAI's models.",
            });
        });
        const { onSaved } = setup(fetchMock);
        await user.selectOptions(screen.getByLabelText("Provider"), "openai");
        expect(screen.getByLabelText("Model")).toHaveProperty("value", "gpt-6-astra");
        await user.selectOptions(screen.getByLabelText("API"), "openai-responses");
        await user.clear(screen.getByLabelText("Model"));
        await user.type(screen.getByLabelText("Model"), "gpt-5.5-pro");
        expect(await screen.findByText(/Add an OpenAI API key to see OpenAI's models\. You can still type/)).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Save model" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH") as unknown as [string, RequestInit];
        expect(patch[0]).toBe("/api/v1/w/acme/settings/review-model");
        expect(JSON.parse(patch[1].body as string)).toEqual({ provider: "openai", model: "gpt-5.5-pro", protocol: "openai-responses" });
    });

    it("Bedrock asks for a region and an access key ID as well as the secret, and has no list to fetch", async () => {
        const user = userEvent.setup();
        const empty = { provider: "mistral", source: "provider", models: [], suggested: [], fetchedAt: null, error: null };
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => json(init?.method === "PATCH" ? DATA : empty));
        setup(fetchMock);
        await user.selectOptions(screen.getByLabelText("Provider"), "bedrock");
        await user.type(screen.getByLabelText("AWS region"), "eu-west-2");
        expect(screen.getByText("Requests go to Bedrock in eu-west-2.")).toBeTruthy();
        expect(screen.getByText("Amazon Bedrock doesn't list its models here. Choose a suggestion or type the model's name.")).toBeTruthy();
        expect(screen.getByLabelText("Amazon Bedrock AWS access key ID")).toBeTruthy();
        expect(screen.getByLabelText("Amazon Bedrock AWS secret access key")).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Save model" }));
        const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH") as unknown as [string, RequestInit];
        expect(JSON.parse(patch[1].body as string)).toEqual({
            provider: "bedrock",
            model: "global.anthropic.claude-opus-4-6-v1",
            region: "eu-west-2",
        });
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/providers/bedrock/models"))).toBe(false);
    });
});
