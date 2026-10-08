// Taking a review's secrets (its GitHub token and model key) out of everything that leaves the runner or
// is kept by the server: log lines, progress, errors and reports. One function, used by both.
//
// A secret can show up encoded: URL-encoded (wholly or in part), JSON-escaped, as hex, or inside base64,
// for example git's basic auth header, base64("x-access-token:" + token), where the secret starts part of
// the way through a 3-byte group. So for base64 every alignment is matched, keeping only the characters
// that come from the secret alone.
//
// Not exported from the package index: it's for Node (the runner and the server), not the web app.

const REDACTED = "[redacted]";
/** Shorter secrets can't be told apart from ordinary text. */
const MIN_SECRET = 6;
/** Shorter encoded fragments are too likely to turn up by chance. */
const MIN_FORM = 8;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The part of base64(`a` unknown bytes + secret + unknown bytes) that only the secret decides. */
function base64Core(secret: Buffer, align: number): string {
    const encoded = Buffer.concat([Buffer.alloc(align), secret])
        .toString("base64")
        .replace(/=+$/, "");
    const total = align + secret.length;
    // Whole groups give 4 characters each; a last part-group of 1 or 2 bytes gives 1 or 2 more that are its alone.
    const whole = Math.floor(total / 3) * 4 + (total % 3);
    // The first characters carry bits of the bytes before the secret.
    const skip = [0, 2, 3][align] as number;
    return encoded.slice(skip, whole);
}

/** Matches the secret written with any of its characters as %XX, \uXXXX (or \/ for "/"), or as is. */
function characterwise(secret: string): string {
    return [...secret]
        .map((c) => {
            const code = c.charCodeAt(0);
            if (code > 0x7f) return escapeRe(c);
            const h = code.toString(16).padStart(2, "0");
            const hexRe = [...h].map((d) => (/[a-f]/.test(d) ? `[${d}${d.toUpperCase()}]` : d)).join("");
            return `(?:${escapeRe(c)}|%${hexRe}|\\\\u00${hexRe}${c === "/" ? "|\\\\/" : ""})`;
        })
        .join("");
}

/** The fixed strings a secret can appear as (besides as itself, written character by character). */
export function secretForms(secrets: readonly string[]): string[] {
    const out = new Set<string>();
    for (const s of secrets) {
        if (!s || s.length < MIN_SECRET) continue;
        const bytes = Buffer.from(s, "utf8");
        out.add(s);
        out.add(bytes.toString("hex"));
        out.add(bytes.toString("hex").toUpperCase());
        for (let align = 0; align < 3; align++) {
            const core = base64Core(bytes, align);
            if (core.length < MIN_FORM) continue;
            out.add(core);
            out.add(core.replace(/\+/g, "-").replace(/\//g, "_"));
        }
    }
    // Longest first, so a form inside a longer one doesn't leave the rest behind.
    return [...out].sort((a, b) => b.length - a.length);
}

/** Credentials of known shapes, redacted even when they weren't handed out for this job. */
const GENERIC: [RegExp, string][] = [
    [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED],
    [/\b(authorization:\s*)(basic|bearer|token)\s+\S+/gi, `$1$2 ${REDACTED}`],
    [/(x-access-token:)[^@\s]+@/gi, `$1${REDACTED}@`],
];

/** Characters Postgres text and jsonb can't hold. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing NUL is the point
const UNSTORABLE = /\u0000/g;

/** One pattern for all of a job's secrets, in all their forms. */
function patternFor(secrets: readonly string[]): RegExp | null {
    const parts = [...secrets.filter((s) => s && s.length >= MIN_SECRET).map(characterwise), ...secretForms(secrets).map(escapeRe)];
    return parts.length ? new RegExp(parts.join("|"), "g") : null;
}

/** `text` without the secrets (in any form), credentials of known shapes, or characters Postgres can't store. */
export function redact(text: string, secrets: readonly string[]): string {
    return redactWith(patternFor(secrets))(text);
}

function redactWith(pattern: RegExp | null): (text: string) => string {
    return (text) => {
        let out = text.replace(UNSTORABLE, "");
        if (pattern) out = out.replace(pattern, REDACTED);
        for (const [re, to] of GENERIC) out = out.replace(re, to);
        return out;
    };
}

/** A redacting function for one job's secrets, with its pattern built once. */
export function redactor(secrets: readonly string[]): (text: string) => string {
    return redactWith(patternFor(secrets));
}

/** A copy of `value` with every string in it (object keys too) passed through `clean`. */
export function redactDeep(value: unknown, clean: (text: string) => string, depth = 0): unknown {
    if (typeof value === "string") return clean(value);
    if (!value || typeof value !== "object" || depth > 64) return value;
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, clean, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[clean(k)] = redactDeep(v, clean, depth + 1);
    return out;
}
