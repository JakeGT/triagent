/**
 * A server-supplied URL, only if it's http or https; otherwise undefined, so the link isn't rendered
 * as one. Use it for every URL that comes from the API or from report content.
 */
export function safeHref(value: string | null | undefined): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
        const url = new URL(trimmed);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
    } catch {
        return undefined;
    }
}

/**
 * `value` if it's a path on this site, else null. Refuses another origin, a protocol-relative `//host`,
 * the `/\host` that browsers read the same way, and control characters (the server's `safeNext` rules).
 */
export function localPath(value: string | null | undefined): string | null {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
    return /[\\\u0000-\u001f\u007f]/.test(value) ? null : value;
}
