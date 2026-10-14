import { describe, expect, it } from "vitest";
import { offeredInstallations } from "./github-app-connection";

/** As the server signs it: base64url of the payload's UTF-8, then a MAC (not checked here). */
const signed = (payload: unknown) => {
    const binary = String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload)));
    return `${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.mac`;
};

describe("offeredInstallations", () => {
    it("reads the installations offered from the signed list", () => {
        const options = [
            { id: 1, account: "acme" },
            { id: 2, account: "säm" },
        ];
        expect(offeredInstallations(signed({ purpose: "link-choice", options }))).toEqual(options);
    });

    it("offers nothing for a missing, garbled or odd list", () => {
        expect(offeredInstallations(undefined)).toEqual([]);
        expect(offeredInstallations("not base64!.x")).toEqual([]);
        expect(offeredInstallations(signed({ options: "acme" }))).toEqual([]);
        expect(offeredInstallations(signed({ options: [{ id: "1", account: "acme" }, null] }))).toEqual([]);
    });
});
