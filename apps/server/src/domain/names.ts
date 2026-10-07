// Names that end up in URLs, logs, git commands and file names, so they're checked strictly.

/** Git-style branch names: no spaces, no "..", no leading "-", "/" or ".", no trailing "/", "." or ".lock". */
export function isValidBranch(name: unknown): boolean {
    return (
        typeof name === "string" &&
        /^[A-Za-z0-9._/+@-]{1,200}$/.test(name) &&
        !name.includes("..") &&
        !name.includes("//") &&
        !/^[-/.]/.test(name) &&
        !/[/.]$/.test(name) &&
        !name.endsWith(".lock")
    );
}

/** Workspace and project slugs: lower-case letters, digits and dashes, starting with a letter or digit. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidSlug(value: unknown): boolean {
    return typeof value === "string" && SLUG.test(value);
}

/** Local account names. */
export const USERNAME = /^[a-zA-Z0-9._@-]{1,64}$/;

/** A git commit SHA, abbreviated or full. */
export const COMMIT = /^[0-9a-f]{7,40}$/i;

/** Remove control characters (except tab and newlines) from text people or agents send. */
export function cleanText(value: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/**
 * A repository address as https://host/owner/repo, from the https or SSH forms GitHub shows.
 * Returns null if it isn't one.
 */
export function normaliseRepoUrl(input: string): string | null {
    const value = input.trim();
    let m = /^https:\/\/([A-Za-z0-9.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(value);
    if (!m) m = /^git@([A-Za-z0-9.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(value);
    if (!m) m = /^ssh:\/\/git@([A-Za-z0-9.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(value);
    if (!m) return null;
    const [, host, owner, repo] = m;
    if (!host || !owner || !repo || owner.startsWith(".") || repo.startsWith(".")) return null;
    return `https://${host.toLowerCase()}/${owner}/${repo}`;
}
