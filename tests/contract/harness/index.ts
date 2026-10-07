import assert from "node:assert/strict";
import { after, before } from "node:test";
import { LegacyTarget } from "./legacy.ts";
import type { Caller, Finding, Report, Target } from "./types.ts";
import { V1Target } from "./v1.ts";

export type * from "./types.ts";

const TARGETS: Record<string, () => Promise<Target>> = {
    legacy: () => LegacyTarget.start(),
    v1: () => V1Target.start(),
};

const chosen = process.env.TRIAGENT_CONTRACT_TARGET;

/**
 * Pass to `describe` as `{ skip }`: the contract runs only against a chosen target, so the suite stays
 * green (and quick) where none is available, e.g. in CI before the rebuilt server exists.
 */
export const skip: string | false = !chosen
    ? "No contract target: set TRIAGENT_CONTRACT_TARGET (see tests/contract/README.md)."
    : TARGETS[chosen]
      ? false
      : `Unknown TRIAGENT_CONTRACT_TARGET "${chosen}". Known: ${Object.keys(TARGETS).join(", ")}.`;

/**
 * Options for a test the prototype is known to fail: it runs and is reported as "todo" there (so the gap
 * stays visible without failing the suite), and must pass on every other target.
 */
export function knownGap(target: string, reason: string): { todo?: string } {
    return chosen === target ? { todo: `known gap in ${target}: ${reason}` } : {};
}

/** Start one server for the enclosing `describe`, and stop it afterwards. */
export function useTarget(): () => Target {
    let target: Target | null = null;
    before(async () => {
        const start = chosen ? TARGETS[chosen] : undefined;
        if (!start) throw new Error(String(skip));
        target = await start();
    });
    after(async () => {
        await target?.close();
    });
    return () => {
        if (!target) throw new Error("The target hasn't started.");
        return target;
    };
}

let counter = 0;
/** A name that won't clash with other tests' projects or branches. */
export function unique(prefix: string): string {
    return `${prefix}-${process.pid.toString(36)}-${(++counter).toString(36)}`;
}

/** One finding. Different `content` gives a different finding id. */
export function finding(path: string, content: string, extra: Partial<Finding> = {}): Finding {
    return { path, content, severity: "medium", category: "bug", start_line: 1, end_line: 2, ...extra };
}

export function report(...comments: Finding[]): Report {
    return { status: "completed", comments, project_summary: "" };
}

/** The issue reported at `path` on a branch (there must be exactly one). */
export async function issueAt(target: Target, c: Caller, project: string, branch: string, path: string) {
    const r = await target.listIssues(c, project, branch);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const matches = r.body.items.filter((x: { path: string }) => x.path === path);
    assert.equal(matches.length, 1, `expected one issue at ${path}, found ${matches.length}`);
    return matches[0];
}

/** Assert a reply's status, showing the body when it's wrong. */
export function expectStatus(r: { status: number; body: unknown }, status: number): void {
    assert.equal(r.status, status, `expected HTTP ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
}
