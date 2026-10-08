// Redaction: the one function the runner and the server both use to take a job's secrets out of log
// lines, progress, errors and reports, in every form they can appear in: as they are, URL-encoded (all or
// some characters), JSON-escaped, hex, and base64 at any alignment (a secret inside a longer string, such
// as git's basic auth "user:secret"), standard or URL-safe. Secrets are made up here, at random.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { redact, redactDeep, redactor, secretForms } from "@triagent/shared/redact";

const modelKey = () => `sk-or-v1-${randomBytes(24).toString("hex")}`;
const ghToken = () => `ghs_${randomBytes(18).toString("base64url").replace(/[-_]/g, "x")}`;
const b64 = (s: string) => Buffer.from(s).toString("base64");
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const hex = (s: string) => Buffer.from(s).toString("hex");
const pct = (s: string, upper = false) =>
    [...s].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")[upper ? "toUpperCase" : "toLowerCase"]()}`).join("");

function encodings(secret: string): Record<string, string> {
    const out: Record<string, string> = {
        plain: secret,
        "mid-string": `abc${secret}def`,
        "URL-encoded": encodeURIComponent(`k=${secret}&x`),
        "every character %xx": pct(secret),
        "every character %XX": pct(secret, true),
        "some characters %xx": [...secret].map((c, i) => (i % 3 ? c : pct(c))).join(""),
        "JSON \\u00xx": JSON.stringify(secret).replace(/[a-z0-9]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`),
        hex: hex(secret),
        HEX: hex(secret).toUpperCase(),
        "hex mid-string": hex(`prefix-${secret}-suffix`),
        "git's basic auth": b64(`x-access-token:${secret}`),
        "basic auth, another user": b64(`user:${secret}`),
    };
    for (let pre = 0; pre < 6; pre++)
        for (let post = 0; post < 3; post++) {
            const s = `${"p".repeat(pre)}${secret}${"q".repeat(post)}`;
            out[`base64 +${pre}/+${post}`] = b64(s);
            out[`base64url +${pre}/+${post}`] = b64url(s);
            out[`base64, unpadded +${pre}/+${post}`] = b64(s).replace(/=+$/, "");
        }
    return out;
}

test("a secret is taken out in every form it can take", () => {
    for (const secret of [modelKey(), ghToken(), `glpat-${randomBytes(10).toString("hex")}`]) {
        const clean = redactor([secret]);
        for (const [what, form] of Object.entries(encodings(secret))) {
            const line = `before ${form} after`;
            const out = clean(line);
            assert.ok(out.includes("[redacted]"), `${what}: ${line}`);
            assert.ok(out.startsWith("before ") && out.endsWith(" after"), `${what} kept the rest: ${out}`);
            for (const leftover of [secret, secret.slice(4, -4), hex(secret).slice(4, -4), b64(secret).slice(4, -4)])
                assert.ok(!out.includes(leftover), `${what} left ${leftover} in ${out}`);
        }
    }
});

test("credentials of GitHub's shapes and authorization headers are taken out even when not handed out", () => {
    const pat = `github_pat_${randomBytes(30).toString("hex")}`;
    assert.equal(redact(`token ${pat} here`, []), "token [redacted] here");
    assert.equal(redact(`Authorization: Bearer ${randomBytes(20).toString("hex")}`, []), "Authorization: Bearer [redacted]");
    assert.equal(
        redact(`https://x-access-token:${randomBytes(20).toString("hex")}@github.com/a/b`, []),
        "https://x-access-token:[redacted]@github.com/a/b",
    );
});

test("ordinary text is left alone, and redacting twice changes nothing", () => {
    const secret = modelKey();
    const clean = redactor([secret]);
    const text = "[ocr] 12 file(s) changed, reviewing 10 in /work/tree: src/a.ts, aGVsbG8gd29ybGQ= and 0123456789abcdef";
    assert.equal(clean(text), text);
    const once = clean(`key ${secret} and ${b64(`u:${secret}`)}`);
    assert.equal(clean(once), once);
    // Too short to tell apart from ordinary text: not a secret worth matching.
    assert.deepEqual(secretForms(["abc", ""]), []);
});

test("every string in a report or progress, keys and all, is redacted", () => {
    const secret = modelKey();
    const clean = redactor([secret]);
    const report = {
        comments: [{ path: `src/${secret}.ts`, content: `Uses ${b64(`user:${secret}`)}`, severity: "high" }, null, 5],
        warnings: [{ type: "review_round_failed", file: "a.ts", message: `401 for key ${secret}` }],
        summary: { total_tokens: 10, note: [secret] },
        [secret]: "a key that is a secret",
    };
    const out = redactDeep(report, clean) as typeof report;
    assert.ok(!JSON.stringify(out).includes(secret));
    assert.ok(!JSON.stringify(out).includes(b64(`user:${secret}`).slice(8, -4)));
    assert.equal(out.summary.total_tokens, 10);
    assert.equal(out.comments[1], null);
    assert.equal(out.comments[2], 5);
    assert.equal(out.warnings[0]?.message, "401 for key [redacted]");
    // Characters Postgres text can't hold go too.
    assert.equal(redactDeep("a\u0000b", clean), "ab");
});
