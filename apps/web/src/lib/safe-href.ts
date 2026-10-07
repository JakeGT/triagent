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
