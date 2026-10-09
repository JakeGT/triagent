import { describe, expect, it } from "vitest";
import { localPath, safeHref } from "./safe-href";

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

describe("localPath", () => {
    it("allows paths on this site", () => {
        expect(localPath("/")).toBe("/");
        expect(localPath("/w/acme/p/app/issues?branch=main#x")).toBe("/w/acme/p/app/issues?branch=main#x");
    });

    it("refuses anything a browser could read as another origin", () => {
        for (const bad of ["//evil.example", "/\\evil.example", "/\tevil", "https://evil.example", "evil", "", null, undefined])
            expect(localPath(bad), String(bad)).toBeNull();
    });
});
