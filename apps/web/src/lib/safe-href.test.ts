import { describe, expect, it } from "vitest";
import { safeHref } from "./safe-href";

describe("safeHref", () => {
    it("allows http and https links", () => {
        expect(safeHref("https://github.com/acme/app/blob/main/a.ts#L3")).toBe("https://github.com/acme/app/blob/main/a.ts#L3");
        expect(safeHref(" http://example.com ")).toBe("http://example.com/");
    });

    it("refuses every other scheme, relative links and junk", () => {
        for (const bad of [
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            " javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox",
            "file:///etc/passwd",
            "//evil.example/x",
            "/relative/path",
            "mailto:someone@example.com",
            "not a url",
            "",
            null,
            undefined,
        ])
            expect(safeHref(bad), String(bad)).toBeUndefined();
    });
});
