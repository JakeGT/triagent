import { afterEach, describe, expect, it, vi } from "vitest";
import { prefs } from "./prefs";

describe("prefs", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("keeps a value in memory when storage refuses it, and drops that copy once storage works again", () => {
        const stored = new Map<string, string>();
        let full = true;
        vi.stubGlobal("localStorage", {
            getItem: (k: string) => stored.get(k) ?? null,
            setItem: (k: string, v: string) => {
                if (full) throw new DOMException("full", "QuotaExceededError");
                stored.set(k, v);
            },
            removeItem: (k: string) => stored.delete(k),
        });
        prefs.set("triagent-test", "a");
        expect(prefs.get("triagent-test")).toBe("a");
        full = false;
        prefs.set("triagent-test", "b");
        expect(prefs.get("triagent-test")).toBe("b");
    });
});
