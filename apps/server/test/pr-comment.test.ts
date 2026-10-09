// The pull request comment: text from the model (finding titles, file names, OCR's warnings) is untrusted,
// so it's rendered here with a CommonMark + GFM renderer that, like GitHub, lets raw HTML through, and the
// result must have no links but Triagent's own, no mentions or cross-references, and no HTML.

import assert from "node:assert/strict";
import { test } from "node:test";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { type CommentInput, commentBody, plain, reviewGaps } from "../src/domain/review-run.ts";

const OURS = "https://triagent.test/";

const HOSTILE = [
    String.raw`Null check \[Click to fix\](//evil.example/x) here`,
    "[Click](https://evil.example/a) or ![img](https://evil.example/i.png)",
    "See www.evil.example now",
    "Visit https://evil.example/path and http://evil.example",
    "ping @acme/security and @octocat",
    "ping &#64;acme/security, &commat;octocat and &#x40;someone",
    "Mail admin@evil.example",
    "Fixes #12 and acme/app#34 and GH-56",
    "<img src=x onerror=alert(1)> <a href='https://evil.example'>x</a> <details>",
    "&lt;script&gt; and &#60;b&#62;",
    "`code` **bold** _it_ ~~strike~~ | pipe | table",
    "<https://evil.example/autolink> and <admin@evil.example>",
    "[ref][1]\n\n[1]: https://evil.example/ref",
    "line one\nline two\r\n# heading",
    "back\\slash \\@octocat \\#99",
    "x](https://evil.example) [y",
];

function render(body: string): string {
    return micromark(body, { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] });
}

/** What GitHub would turn into links, mentions or references, or let through as HTML. */
function problems(html: string): string[] {
    const out: string[] = [];
    for (const m of html.matchAll(/<a\b[^>]*href="([^"]*)"/g)) if (!m[1]?.startsWith(OURS)) out.push(`link to ${m[1]}`);
    for (const m of html.matchAll(/<(\/?)([a-z][\w-]*)/gi)) {
        const tag = (m[2] as string).toLowerCase();
        if (!["a", "p", "h3", "ul", "li", "strong", "code", "table", "thead", "tbody", "tr", "th", "td", "blockquote"].includes(tag))
            out.push(`<${tag}>`);
    }
    // Text GitHub links after rendering: mentions, references, bare addresses.
    const text = html
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&#x?\w+;|&\w+;/g, " ");
    for (const re of [/@[A-Za-z0-9]/, /(^|[^\w])#\d/, /\bGH-\d/i, /www\./i, /:\/\//, /\w@\w/])
        if (re.test(text)) out.push(`${re} in "${text.trim().slice(0, 120)}"`);
    return out;
}

function comment(title: string, extra: Partial<CommentInput> = {}): string {
    return commentBody({
        marker: "<!-- triagent-review -->",
        total: 1,
        bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
        urgent: [{ id: "ocr-1", severity: "high", path: "src/a.ts", startLine: 3, title }],
        gaps: null,
        failOnCritical: true,
        commit: "0123456789abcdef",
        issuesUrl: `${OURS}w/acme/p/app/issues?branch=main`,
        issueUrl: (id) => `${OURS}w/acme/p/app/issues/${id}?branch=main`,
        ...extra,
    });
}

test("finding titles can't add links, mentions, references or HTML to the comment", () => {
    for (const title of HOSTILE) {
        const html = render(comment(title));
        assert.deepEqual(problems(html), [], `${JSON.stringify(title)} rendered as ${html}`);
        // The finding still links to Triagent, once.
        assert.equal([...html.matchAll(/href="https:\/\/triagent\.test\/w\/acme\/p\/app\/issues\/ocr-1/g)].length, 1, html);
    }
});

test("the partial-review note (file names and OCR's warnings) is escaped too", () => {
    const gaps = reviewGaps({
        warnings: HOSTILE.map((h, i) => ({ type: "review_round_failed", file: `src/${i}.ts,${h}`, message: h })),
    });
    assert.ok(gaps);
    // Every warning's text reaches the note's reasons, a few at a time.
    for (let i = 0; i < HOSTILE.length; i++) {
        const one = reviewGaps({ warnings: [{ type: "review_round_failed", file: HOSTILE[i], message: HOSTILE[i] }] });
        const html = render(comment("A plain title", { gaps: one }));
        assert.deepEqual(problems(html), [], `${JSON.stringify(HOSTILE[i])} rendered as ${html}`);
    }
    assert.deepEqual(problems(render(comment("A plain title", { gaps }))), []);
});

test("plain text stays readable", () => {
    const html = render(comment("Use a constant-time comparison (crypto.timingSafeEqual) for tokens."));
    const text = html.replace(/<[^>]+>/g, "").replace(/​/g, "");
    assert.match(text, /Use a constant-time comparison \(crypto\.timingSafeEqual\) for tokens\./);
    assert.equal(plain("a & b"), "a &amp; b");
    assert.equal(plain("x".repeat(200)).length, 140);
});

test("a branch name with parentheses keeps the links whole", () => {
    const branch = encodeURIComponent("fix/x) (y");
    const html = render(
        comment("A title", {
            issuesUrl: `${OURS}w/acme/p/app/issues?branch=${branch}`,
            issueUrl: (id) => `${OURS}w/acme/p/app/issues/${id}?branch=${branch}`,
        }),
    );
    assert.deepEqual(problems(html), [], html);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(hrefs.length, 2, html);
    for (const h of hrefs) assert.ok(h?.endsWith("branch=fix%2Fx%29%20%28y"), h);
});

test("a long title is cut between characters, not inside an emoji", () => {
    const cut = plain(`${"a".repeat(138)}😀 and more`, 140);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), cut);
    assert.ok(cut.endsWith("…"));
});
