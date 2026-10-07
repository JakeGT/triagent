// How the router reads and writes ?query strings: plain strings, lists joined with commas, and empty
// values left out. (TanStack Router's default is JSON, which makes links like ?severity=%5B%22high%22%5D.)

export function parseSearch(search: string): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(search.startsWith("?") ? search.slice(1) : search));
}

export function stringifySearch(search: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(search)) {
        if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
        params.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : "";
}
