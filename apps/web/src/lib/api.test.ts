import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, CLIENT_ID, configureApi, conflictCurrent, isApiError, queryString, setCsrfToken } from "./api";

type Call = [string, RequestInit];

function respond(status: number, body: unknown) {
    return vi.fn(async (_url: string, _init?: RequestInit) => new Response(body === undefined ? null : JSON.stringify(body), { status }));
}

const headersOf = (fetchMock: ReturnType<typeof vi.fn>, n = 0) =>
    ((fetchMock.mock.calls[n] as unknown as Call)[1].headers ?? {}) as Record<string, string>;

describe("the API client", () => {
    const hooks = { onSignedOut: vi.fn(), onPasswordChangeRequired: vi.fn() };

    beforeEach(() => {
        configureApi(hooks);
        setCsrfToken("csrf-123");
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        hooks.onSignedOut.mockReset();
        hooks.onPasswordChangeRequired.mockReset();
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
