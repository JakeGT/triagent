// Where findings came from (apps/server/src/services/origins.ts): the commits behind a branch's
// findings, for workspaces that turn it on, and the authors leaderboard for those that turn that on too.

import { queryOptions } from "@tanstack/react-query";
import { api, paths } from "./api";
import { keys } from "./queries";

export type OriginLevel = "off" | "on" | "leaderboard";

export interface OriginScan {
    commit: string | null;
    status: "running" | "done" | "failed";
    startedAt: string;
    finishedAt: string | null;
    /** Files looked at, findings traced, and findings that couldn't be. */
    files: number;
    traced: number;
    skipped: number;
    error: string | null;
}

export type AgeKey = "month" | "quarter" | "year" | "older";

export interface OriginAuthor {
    /** "@login", or "name:…" for an author GitHub doesn't know: what the issues list filters by. */
    key: string;
    name: string;
    login: string | null;
    /** Their name in this workspace, when they're a member. */
    member: string | null;
    /** Findings in code they last changed: open, the critical and high among those, and all still reported. */
    open: number;
    serious: number;
    findings: number;
    lines: number;
    /** Open findings for every thousand lines; null with too few lines to say. */
    perThousand: number | null;
}

export interface Origins {
    level: OriginLevel;
    branch: string;
    scan: OriginScan | null;
    /** The report has moved on to another commit since its findings were traced. */
    stale: boolean;
    traced: number;
    open: number;
    /** Open findings by how old the code behind them is. */
    age: Record<AgeKey, number> | null;
    /** The pull requests behind the most open findings. */
    pulls: { number: number; title: string; open: number; serious: number }[];
    /** Null unless the workspace shows its leaderboard. */
    authors: OriginAuthor[] | null;
}

/** The commit behind one finding. */
export interface IssueOrigin {
    commit: string;
    headline: string;
    authoredAt: string;
    author: string;
    login: string | null;
    pr: { number: number; title: string } | null;
    /** The author as a member of this workspace: who the finding could be assigned to. */
    suggested: string | null;
}

export const originKeys = {
    level: (ws: string) => keys.wsSettings(ws, "origins"),
    branch: (ws: string, project: string, branch: string) => [...keys.branch(ws, project, branch), "origins"] as const,
};

export const originLevelQuery = (ws: string) =>
    queryOptions({
        queryKey: originKeys.level(ws),
        queryFn: ({ signal }) => api.get<{ level: OriginLevel }>(`${paths.workspace(ws)}/settings/origins`, undefined, { signal }),
        staleTime: 60_000,
    });

export const originsQuery = (ws: string, project: string, branch: string) =>
    queryOptions({
        queryKey: originKeys.branch(ws, project, branch),
        queryFn: ({ signal }) => api.get<Origins>(`${paths.project(ws, project)}/origins`, { branch }, { signal }),
        refetchInterval: (q) => (q.state.data?.scan?.status === "running" ? 2000 : false),
    });

export const saveOriginLevel = (ws: string, level: OriginLevel) =>
    api.put<{ level: OriginLevel }>(`${paths.workspace(ws)}/settings/origins`, { level });

export const traceOrigins = (ws: string, project: string, branch: string) =>
    api.post<OriginScan>(`${paths.project(ws, project)}/origins`, {}, { branch });
