// Where findings came from: reading Git blame as GitHub's GraphQL API gives it, choosing the commit
// behind a finding's lines, and counting findings by how old that code is, the pull request it came in
// by, and who wrote it. Pure: services/origins.ts asks GitHub and saves.
//
// Blame names whoever last changed a line, which isn't always who wrote the problem (a reformat, a moved
// file). The pages say so; nothing here pretends otherwise.

import { DONE_STATUSES, type Severity, type Status } from "@triagent/shared";
import type { FindingOrigin } from "../store/types.ts";

/** Files asked about in one request: blame is slow for GitHub to work out, and one request has a time limit. */
export const BLAME_BATCH = 6;
/** Files looked at in one tracing: a full scan of a large codebase can have findings in thousands. */
export const MAX_BLAME_FILES = 600;

export interface BlameCommit {
    oid: string;
    authoredAt: string;
    headline: string;
    name: string;
    /** For matching a member only: never stored. */
    email: string | null;
    login: string | null;
    pr: { number: number; title: string } | null;
}

export interface BlameRange {
    start: number;
    end: number;
    commit: BlameCommit;
}

const COMMIT_FIELDS =
    "oid authoredDate messageHeadline author { name email user { login } } associatedPullRequests(first: 1) { nodes { number title } }";

/** One request for the blame of `count` files at one commit: `$oid`, and `$p0`, `$p1`… for the paths. */
export function blameQuery(count: number): string {
    const vars = Array.from({ length: count }, (_, i) => `$p${i}: String!`).join(", ");
    const fields = Array.from(
        { length: count },
        (_, i) => `f${i}: blame(path: $p${i}) { ranges { startingLine endingLine commit { ${COMMIT_FIELDS} } } }`,
    ).join("\n");
    return `query($owner: String!, $name: String!, $oid: GitObjectID!, ${vars}) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit {
${fields}
  } } }
}`;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** The blame of each file asked about, in order: null for one GitHub gave nothing for. */
export function readBlame(data: unknown, count: number): (BlameRange[] | null)[] {
    const commit = (data as { repository?: { object?: Record<string, unknown> | null } | null } | null)?.repository?.object;
    return Array.from({ length: count }, (_, i) => {
        const ranges = (commit?.[`f${i}`] as { ranges?: unknown } | null | undefined)?.ranges;
        if (!Array.isArray(ranges)) return null;
        const out: BlameRange[] = [];
        for (const raw of ranges as unknown[]) {
            const r = raw as { startingLine?: unknown; endingLine?: unknown; commit?: Record<string, unknown> | null } | null;
            const c = r?.commit;
            const at = Date.parse(str(c?.authoredDate, 40));
            if (!r || !c || !Number.isInteger(r.startingLine) || !Number.isInteger(r.endingLine) || !Number.isFinite(at)) continue;
            if (!/^[0-9a-f]{40}$/.test(str(c.oid, 40))) continue;
            const author = (c.author ?? {}) as { name?: unknown; email?: unknown; user?: { login?: unknown } | null };
            const pr = ((c.associatedPullRequests as { nodes?: unknown[] } | null)?.nodes ?? [])[0] as
                | { number?: unknown; title?: unknown }
                | undefined;
            out.push({
                start: r.startingLine as number,
                end: r.endingLine as number,
                commit: {
                    oid: str(c.oid, 40),
                    authoredAt: new Date(at).toISOString(),
                    headline: str(c.messageHeadline, 200),
                    name: str(author.name, 100) || "Unknown",
                    email: str(author.email, 200).toLowerCase() || null,
                    login: str(author.user?.login, 60) || null,
                    pr: pr && Number.isInteger(pr.number) ? { number: pr.number as number, title: str(pr.title, 200) } : null,
                },
            });
        }
        return out;
    });
}

/**
 * The commit behind a finding's lines: of those that last changed any of them, the newest. A finding is
 * about the code as it stands, and the newest change to its lines is what made it stand that way.
 */
export function originOf(ranges: readonly BlameRange[], startLine: number, endLine: number | null): BlameCommit | null {
    const end = endLine !== null && endLine >= startLine ? endLine : startLine;
    let newest: BlameCommit | null = null;
    for (const r of ranges) {
        if (r.end < startLine || r.start > end) continue;
        if (!newest || r.commit.authoredAt > newest.authoredAt) newest = r.commit;
    }
    return newest;
}

/** How an author is told apart: by GitHub login when there is one (names vary between machines), else by name. */
export const authorKey = (a: { login: string | null; name: string }): string =>
    a.login ? `@${a.login.toLowerCase()}` : `name:${sameAuthor(a.name)}`;

/** A name or key as it's compared: case and spacing don't tell two authors apart (and a filter's value arrives tidied). */
export const sameAuthor = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Lines of a file each author last changed. */
export function linesByAuthor(ranges: readonly BlameRange[], into: Map<string, number>): void {
    for (const r of ranges) into.set(authorKey(r.commit), (into.get(authorKey(r.commit)) ?? 0) + (r.end - r.start + 1));
}

// ---- counting ------------------------------------------------------------------------------------

export interface TracedFinding {
    id: string;
    severity: Severity;
    status: Status;
    origin: FindingOrigin;
}

const DAY = 86_400_000;
export const AGES = [
    { key: "month", label: "The last 30 days", days: 30 },
    { key: "quarter", label: "1 to 3 months", days: 90 },
    { key: "year", label: "3 to 12 months", days: 365 },
    { key: "older", label: "Over a year", days: Number.POSITIVE_INFINITY },
] as const;
export type AgeKey = (typeof AGES)[number]["key"];

export interface AuthorRow {
    key: string;
    name: string;
    login: string | null;
    memberId: string | null;
    /** Findings in code they last changed: still open, the critical and high among those, and all still reported. */
    open: number;
    serious: number;
    findings: number;
    /** Lines they last changed in the files looked at, and open findings for every thousand of them (null under 200 lines). */
    lines: number;
    perThousand: number | null;
}

/** Fewer lines than this and a rate per thousand says nothing. */
export const MIN_LINES = 200;

export function summarise(
    traced: readonly TracedFinding[],
    lines: Readonly<Record<string, number>>,
    names: Readonly<Record<string, { name: string; login: string | null; memberId: string | null }>>,
    now: number,
) {
    const open = traced.filter((t) => !DONE_STATUSES.has(t.status));
    const age = Object.fromEntries(AGES.map((a) => [a.key, 0])) as Record<AgeKey, number>;
    const pulls = new Map<number, { number: number; title: string; open: number; serious: number; authoredAt: string }>();
    const authors = new Map<string, AuthorRow>();
    const row = (o: FindingOrigin): AuthorRow => {
        const key = authorKey({ login: o.authorLogin, name: o.authorName });
        let a = authors.get(key);
        if (!a) {
            a = {
                key,
                name: o.authorName,
                login: o.authorLogin,
                memberId: o.memberId,
                open: 0,
                serious: 0,
                findings: 0,
                lines: lines[key] ?? 0,
                perThousand: null,
            };
            authors.set(key, a);
        }
        return a;
    };
    for (const t of traced) row(t.origin).findings++;
    for (const t of open) {
        const serious = t.severity === "critical" || t.severity === "high";
        const days = (now - Date.parse(t.origin.authoredAt)) / DAY;
        age[(AGES.find((a) => days < a.days) ?? AGES[3]).key]++;
        const a = row(t.origin);
        a.open++;
        if (serious) a.serious++;
        if (t.origin.prNumber !== null) {
            const p = pulls.get(t.origin.prNumber) ?? {
                number: t.origin.prNumber,
                title: t.origin.prTitle ?? "",
                open: 0,
                serious: 0,
                authoredAt: t.origin.authoredAt,
            };
            p.open++;
            if (serious) p.serious++;
            pulls.set(p.number, p);
        }
    }
    // Authors with lines in the files looked at and no findings there belong on the board too: that's the good end of it.
    for (const [key, n] of Object.entries(lines)) {
        if (authors.has(key) || n < MIN_LINES) continue;
        const who = names[key];
        if (who) authors.set(key, { key, ...who, open: 0, serious: 0, findings: 0, lines: n, perThousand: null });
    }
    for (const a of authors.values()) a.perThousand = a.lines >= MIN_LINES ? (a.open / a.lines) * 1000 : null;
    return {
        traced: traced.length,
        open: open.length,
        age,
        pulls: [...pulls.values()].sort((a, b) => b.serious - a.serious || b.open - a.open || b.number - a.number).slice(0, 10),
        /** The most open findings first. */
        authors: [...authors.values()].sort(
            (a, b) => b.open - a.open || b.serious - a.serious || b.lines - a.lines || a.name.localeCompare(b.name),
        ),
    };
}
