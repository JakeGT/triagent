import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, CLIENT_ID, configureApi, conflictCurrent, isApiError, providerSignInUrl, queryString, setCsrfToken } from "./api";

type Call = [string, RequestInit];

function respond(status: number, body: unknown) {
    return vi.fn(async (_url: string, _init?: RequestInit) => new Response(body === undefined ? null : JSON.stringify(body), { status }));
}

const headersOf = (fetchMock: ReturnType<typeof vi.fn>, n = 0) =>
    ((fetchMock.mock.calls[n] as unknown as Call)[1].headers ?? {}) as Record<string, string>;

describe("the API client", () => {
    const hooks = {
        onSignedOut: vi.fn(),
        onPasswordChangeRequired: vi.fn(),
        onReauthRequired: vi.fn(async (_body: unknown) => false),
    };

    beforeEach(() => {
        configureApi(hooks);
        setCsrfToken("csrf-123");
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        hooks.onSignedOut.mockReset();
        hooks.onPasswordChangeRequired.mockReset();
        hooks.onReauthRequired.mockReset();
    });

    it("sends the CSRF token and the tab's client id with every write", async () => {
        const fetchMock = respond(200, { ok: true });
        vi.stubGlobal("fetch", fetchMock);
        await api.patch("/api/v1/w/acme/p/app/issues/x", { status: "resolved", rev: 3 }, { branch: "main" });
        const [url, init] = fetchMock.mock.calls[0] as unknown as Call;
        expect(url).toBe("/api/v1/w/acme/p/app/issues/x?branch=main");
        expect(init.method).toBe("PATCH");
        expect(init.credentials).toBe("same-origin");
        expect(JSON.parse(init.body as string)).toEqual({ status: "resolved", rev: 3 });
        const headers = headersOf(fetchMock);
        expect(headers["X-CSRF-Token"]).toBe("csrf-123");
        expect(headers["X-Client-Id"]).toBe(CLIENT_ID);
        expect(headers["Content-Type"]).toBe("application/json");
    });

    it("sends no CSRF token with reads", async () => {
        const fetchMock = respond(200, { items: [] });
        vi.stubGlobal("fetch", fetchMock);
        await api.get("/api/v1/workspaces");
        expect(headersOf(fetchMock)["X-CSRF-Token"]).toBeUndefined();
        expect(headersOf(fetchMock)["X-Client-Id"]).toBe(CLIENT_ID);
    });

    it("sends a JSON body with POSTs that have none, as the server requires", async () => {
        const fetchMock = respond(200, {});
        vi.stubGlobal("fetch", fetchMock);
        await api.post("/api/v1/w/acme/p/app/settings/github/webhook-secret");
        expect((fetchMock.mock.calls[0] as unknown as Call)[1].body).toBe("{}");
    });

    it("turns a 409 into an error carrying the current version", async () => {
        const current = { id: "ocr-1", rev: 4, status: "resolved", updatedBy: "Sam" };
        vi.stubGlobal("fetch", respond(409, { error: "Someone else changed ocr-1 since you loaded it.", current }));
        const err = await api.patch("/x", { status: "open", rev: 3 }).catch((e: unknown) => e);
        expect(isApiError(err, 409)).toBe(true);
        expect((err as Error).message).toBe("Someone else changed ocr-1 since you loaded it.");
        expect(conflictCurrent(err)).toEqual(current);
        expect(hooks.onSignedOut).not.toHaveBeenCalled();
    });

    it("has no current version for other errors", async () => {
        vi.stubGlobal("fetch", respond(400, { error: "status: invalid" }));
        const err = await api.patch("/x", {}).catch((e: unknown) => e);
        expect(conflictCurrent(err)).toBeNull();
    });

    it("sends people to sign in on a 401, unless asked not to", async () => {
        vi.stubGlobal("fetch", respond(401, { error: "Sign in." }));
        await expect(api.get("/api/v1/w/acme")).rejects.toThrow("Sign in.");
        expect(hooks.onSignedOut).toHaveBeenCalledTimes(1);
        await expect(api.get("/api/v1/me", undefined, { quiet401: true })).rejects.toThrow();
        expect(hooks.onSignedOut).toHaveBeenCalledTimes(1);
    });

    it("sends people to the forced password change on password_change_required", async () => {
        vi.stubGlobal("fetch", respond(403, { error: "Set a new password before continuing.", code: "password_change_required" }));
        const err = await api.get("/api/v1/w/acme").catch((e: unknown) => e);
        expect(isApiError(err, 403) && err.code).toBe("password_change_required");
        expect(hooks.onPasswordChangeRequired).toHaveBeenCalledTimes(1);
    });

    it("asks the person to confirm it's them on reauth_required, then sends the request once more", async () => {
        const body = { error: "Confirm it's you first.", code: "reauth_required", method: "password" };
        let calls = 0;
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
            ++calls === 1
                ? new Response(JSON.stringify(body), { status: 401 })
                : new Response(JSON.stringify({ set: true }), { status: 200 }),
        );
        vi.stubGlobal("fetch", fetchMock);
        hooks.onReauthRequired.mockResolvedValueOnce(true);
        await expect(api.put("/api/v1/w/acme/settings/review-model/keys/openrouter", { key: "sk-x" })).resolves.toEqual({ set: true });
        expect(hooks.onReauthRequired).toHaveBeenCalledWith(body);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse((fetchMock.mock.calls[1] as unknown as Call)[1].body as string)).toEqual({ key: "sk-x" });
        // Still signed in: a step-up refusal never sends people to the sign-in page.
        expect(hooks.onSignedOut).not.toHaveBeenCalled();
    });

    it("gives up with the server's message if the person doesn't confirm, and asks only once per request", async () => {
        const body = { error: "Confirm it's you first.", code: "reauth_required", method: "password" };
        vi.stubGlobal("fetch", respond(401, body));
        const err = await api.put("/x", {}).catch((e: unknown) => e);
        expect(isApiError(err, 401) && err.code).toBe("reauth_required");
        expect(hooks.onReauthRequired).toHaveBeenCalledTimes(1);
        // Confirmed, but the server still wants more: no loop.
        hooks.onReauthRequired.mockResolvedValue(true);
        await expect(api.put("/x", {})).rejects.toThrow("Confirm it's you first.");
        expect(hooks.onReauthRequired).toHaveBeenCalledTimes(2);
        expect(hooks.onSignedOut).not.toHaveBeenCalled();
    });

    it("builds provider sign-in links that only come back to this site", () => {
        expect(providerSignInUrl("/w/acme/p/app/issues?branch=main")).toBe(
            "/auth/login?next=%2Fw%2Facme%2Fp%2Fapp%2Fissues%3Fbranch%3Dmain",
        );
        expect(providerSignInUrl("//evil.example")).toBe("/auth/login?next=%2F");
        expect(providerSignInUrl("https://evil.example")).toBe("/auth/login?next=%2F");
        expect(providerSignInUrl("/", { prompt: "login" })).toBe("/auth/login?prompt=login&next=%2F");
    });

    it("explains server errors that aren't JSON", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, _init?: RequestInit) => new Response("Bad gateway", { status: 502 })),
        );
        await expect(api.get("/x")).rejects.toThrow("The server had a problem. Try again in a moment.");
    });

    it("builds query strings without empty values", () => {
        expect(queryString({ a: "1", b: "", c: undefined, d: null, e: ["x", "y"], f: [] })).toBe("?a=1&e=x%2Cy");
        expect(queryString({})).toBe("");
    });
});
