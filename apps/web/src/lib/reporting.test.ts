import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { cleanEvent, reportingSettings, startReporting, withoutQuery, worthReporting } from "./reporting";

const page = (head: string) =>
    new DOMParser().parseFromString(`<!doctype html><html><head>${head}</head><body></body></html>`, "text/html");

describe("reporting settings", () => {
    it("are off unless the server put them in the page", async () => {
        expect(reportingSettings(page(""))).toBeNull();
        // Nothing is loaded, and nothing is listening, when reporting is off.
        expect(await startReporting(null)).toBe(false);
    });

    it("are read from the page's meta element", () => {
        const content = JSON.stringify({ dsn: "https://k@o1.ingest.sentry.io/2", environment: "production", release: "1f0f033" }).replace(
            /"/g,
            "&quot;",
        );
        expect(reportingSettings(page(`<meta name="triagent-reporting" content="${content}" />`))).toEqual({
            dsn: "https://k@o1.ingest.sentry.io/2",
            environment: "production",
            release: "1f0f033",
        });
    });

    it("are ignored if they aren't what's expected", () => {
        expect(reportingSettings(page('<meta name="triagent-reporting" content="not json" />'))).toBeNull();
        expect(reportingSettings(page('<meta name="triagent-reporting" content="{&quot;dsn&quot;:5}" />'))).toBeNull();
    });
});

describe("what's worth a report", () => {
    it("isn't the server's answers, a lost connection, or a page from before an update", () => {
        expect(worthReporting(new ApiError(404, { error: "No such project." }))).toBe(false);
        expect(worthReporting(new ApiError(500, { error: "Internal error.", requestId: "abcdef123456" }))).toBe(false);
        expect(worthReporting(new TypeError("Failed to fetch"))).toBe(false);
        expect(worthReporting(new TypeError("NetworkError when attempting to fetch resource."))).toBe(false);
        expect(worthReporting(new DOMException("The operation was aborted.", "AbortError"))).toBe(false);
        expect(worthReporting(new TypeError("Failed to fetch dynamically imported module: /assets/issues-page-abc.js"))).toBe(false);
        expect(worthReporting(undefined)).toBe(false);
    });

    it("is a fault of the app's own", () => {
        expect(worthReporting(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(true);
        expect(worthReporting(new Error("Minified React error #310"))).toBe(true);
        expect(worthReporting("a string someone threw")).toBe(true);
    });
});

describe("what leaves with a report", () => {
    it("is the address without its query, the browser, and the account's id", () => {
        const event = cleanEvent({
            request: {
                url: "https://triagent.example/w/acme/p/app/issues?q=private+search#frag",
                headers: { "User-Agent": "Firefox/140", Referer: "https://triagent.example/auth/callback?code=one-time" },
            },
            user: { id: "u1", email: "sam@example.com", ip_address: "203.0.113.9" },
            message: "sent Authorization: Bearer tri_abcdefghijklmnop",
            exception: { values: [{ type: "Error", value: "token ghp_abcdefghijklmnopqrstuvwxyz012345 refused" }] },
            breadcrumbs: [
                { category: "fetch", data: { method: "GET", url: "/api/v1/w/acme/p/app/issues?q=private+search", status_code: 200 } },
                { category: "navigation", data: { from: "/sign-in?redirect=%2Fw%2Facme", to: "/w/acme?tab=runs" } },
            ],
        });
        expect(event.request).toEqual({ url: "https://triagent.example/w/acme/p/app/issues", headers: { "User-Agent": "Firefox/140" } });
        expect(event.user).toEqual({ id: "u1" });
        expect(event.exception?.values?.[0]?.value).toBe("token [redacted] refused");
        expect(event.breadcrumbs?.[0]?.data).toEqual({ method: "GET", url: "/api/v1/w/acme/p/app/issues", status_code: 200 });
        expect(event.breadcrumbs?.[1]?.data).toEqual({ from: "/sign-in", to: "/w/acme" });
        const text = JSON.stringify(event);
        for (const never of ["private", "one-time", "sam@example.com", "203.0.113.9", "tri_abcdefghijklmnop", "ghp_"])
            expect(text).not.toContain(never);
        expect(withoutQuery("/a?b#c")).toBe("/a");
    });
});

describe("a failure on the server", () => {
    it("gives the person a reference to quote", () => {
        const err = new ApiError(500, { error: "Internal error. Check the server log.", requestId: "EzDkHlbkPFmN" });
        expect(err.message).toBe("Internal error. Check the server log. (Reference: EzDkHlbkPFmN)");
        expect(err.requestId).toBe("EzDkHlbkPFmN");
        // Only something that looks like one of the server's ids is shown.
        expect(new ApiError(500, { error: "Oops.", requestId: "<b>not an id</b>" }).message).toBe("Oops.");
        expect(new ApiError(404, { error: "No such project." }).message).toBe("No such project.");
    });
});
