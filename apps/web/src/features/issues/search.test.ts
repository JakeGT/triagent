import { describe, expect, it } from "vitest";
import { parseSearch, stringifySearch } from "@/lib/search-params";
import { activeFilters, issueApiQuery, parseIssueSearch, toggle, withFilter, withoutFilters } from "./search";

describe("issue filters in the URL", () => {
    it("reads lists, text, flags, sort and page from the query string", () => {
        const s = parseIssueSearch(
            parseSearch(
                "?branch=feature%2Fx&severity=high,critical&status=open&q=sql+injection&path=src/db/&needsDiscussion=true&duplicates=false&sort=path&page=3",
            ),
        );
        expect(s).toEqual({
            branch: "feature/x",
            severity: ["critical", "high"],
            status: ["open"],
            q: "sql injection",
            path: "src/db/",
            needsDiscussion: true,
            duplicates: false,
            sort: "path",
            page: 3,
        });
    });

    it("reads the found-by filter (at least two models) and the agreement sort", () => {
        const s = parseIssueSearch(parseSearch("?foundBy=2&sort=agreement"));
        expect(s).toEqual({ foundBy: 2, sort: "agreement" });
        expect(issueApiQuery(s).foundBy).toBe("2");
        expect(activeFilters(s)).toBe(1);
        expect(parseIssueSearch(parseSearch("?foundBy=1"))).toEqual({});
        expect(parseIssueSearch(parseSearch("?foundBy=two"))).toEqual({});
    });

    it("drops values the server wouldn't accept", () => {
        expect(parseIssueSearch(parseSearch("?severity=urgent,low&status=done&sort=random&page=-2&hasSuggestion=maybe"))).toEqual({
            severity: ["low"],
        });
        expect(parseIssueSearch({ page: "1", sort: "priority", q: "   " })).toEqual({});
        // Pages past the server's 1,000,000 offset, and task ids past its 100 characters.
        expect(parseIssueSearch({ page: "10001" })).toEqual({ page: 10001 });
        expect(parseIssueSearch({ page: "10002" })).toEqual({});
        expect(parseIssueSearch({ task: "t".repeat(350) }).task).toHaveLength(300);
    });

    it("writes readable URLs and reads them back unchanged", () => {
        const s = parseIssueSearch(parseSearch("?severity=critical,high&assignee=none&adjusted=true"));
        const url = stringifySearch({ ...s });
        expect(url).toBe("?severity=critical%2Chigh&assignee=none&adjusted=true");
        expect(parseIssueSearch(parseSearch(url))).toEqual(s);
    });

    it("turns the filters into the API's query, one page at a time", () => {
        expect(issueApiQuery({ severity: ["high"], hasSuggestion: false, page: 2, q: "x" }, 100)).toEqual({
            severity: "high",
            category: undefined,
            status: undefined,
            path: undefined,
            q: "x",
            assignee: undefined,
            task: undefined,
            hasSuggestion: "false",
            needsDiscussion: undefined,
            duplicates: undefined,
            adjusted: undefined,
            sort: undefined,
            limit: "100",
            offset: "100",
        });
    });

    it("toggles list values, with an empty list meaning no filter", () => {
        expect(toggle(undefined, "high")).toEqual(["high"]);
        expect(toggle(["high", "low"], "high")).toEqual(["low"]);
        expect(toggle(["high"], "high")).toBeUndefined();
    });

    it("goes back to the first page when a filter changes, and clears filters but not the branch or sort", () => {
        const s = { branch: "dev", severity: ["high" as const], sort: "path" as const, page: 4, q: "x" };
        expect(withFilter(s, { q: undefined })).toEqual({ branch: "dev", severity: ["high"], sort: "path" });
        expect(withFilter(s, { severity: [] })).toEqual({ branch: "dev", sort: "path", q: "x" });
        expect(withoutFilters(s)).toEqual({ branch: "dev", sort: "path" });
        expect(activeFilters(s)).toBe(2);
    });
});
