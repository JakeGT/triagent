// Common issues and likely false positives (apps/server/src/services/patterns.ts): what the server
// answers with, and the queries. Under the branch's own key, so triage there refreshes them.

import { queryOptions } from "@tanstack/react-query";
import type { Category, Severity } from "@triagent/shared";
import type { Analysis, AnalysisModel } from "./analysis";
import { api, paths } from "./api";
import { keys } from "./queries";

export interface CommonIssue {
    id: string;
    title: string;
    /** What goes wrong, and how to avoid it. */
    summary: string;
    guidance: string;
    category: Category | null;
    hidden: boolean;
    source: "model" | "person";
    createdBy: string;
    createdAt: string;
    updatedBy: string | null;
    updatedAt: string;
    /** Its findings still open on the branch, and all it has had on any branch. */
    open: number;
    total: number;
    openBySeverity: Record<Severity, number>;
    files: { path: string; open: number }[];
    examples: { id: string; title: string; path: string; startLine: number | null; severity: Severity }[];
    lastSeenAt: string | null;
}

export interface CommonIssues {
    branch: string;
    items: CommonIssue[];
    /** Open findings on the branch, and those under no common issue yet. */
    open: number;
    ungrouped: number;
    /** The last time a model was asked to group them. */
    grouping:
        | (Analysis & { result: { created?: number; grouped?: number; considered?: number; left?: number; warning?: string } | null })
        | null;
    model: AnalysisModel;
}

export interface CommonIssueInput {
    title?: string;
    summary?: string;
    guidance?: string;
    category?: Category | null;
    hidden?: boolean;
}

/** The common issue a finding is under, as its own page shows it. */
export interface IssueCommonIssue {
    id: string;
    title: string;
    summary: string;
    guidance: string;
}

export interface FalsePositives {
    branch: string;
    analysis: (Analysis & { result: { considered?: number; left?: number; warning?: string } | null }) | null;
    /** The suggestions still open. */
    items: {
        id: string;
        title: string;
        path: string;
        startLine: number | null;
        severity: Severity;
        foundBy: number | null;
        why: string;
        /** The dismissed finding it's like, and the reason that was given for that one. */
        like: { id: string; branch: string; title: string; reason: string };
    }[];
    /** Findings dismissed with a reason in the project; fewer than `enough` and suggestions are guesses. */
    dismissed: number;
    enough: number;
    model: AnalysisModel;
}

const WAIT_MS = 2000;

export const patternKeys = {
    list: (ws: string, project: string, branch: string) => [...keys.branch(ws, project, branch), "patterns"] as const,
    falsePositives: (ws: string, project: string, branch: string) => [...keys.branch(ws, project, branch), "false-positives"] as const,
};

export const commonIssuesQuery = (ws: string, project: string, branch: string) =>
    queryOptions({
        queryKey: patternKeys.list(ws, project, branch),
        queryFn: ({ signal }) => api.get<CommonIssues>(`${paths.project(ws, project)}/patterns`, { branch }, { signal }),
        refetchInterval: (q) => (q.state.data?.grouping?.status === "running" ? WAIT_MS : false),
    });

export const falsePositivesQuery = (ws: string, project: string, branch: string) =>
    queryOptions({
        queryKey: patternKeys.falsePositives(ws, project, branch),
        queryFn: ({ signal }) => api.get<FalsePositives>(`${paths.project(ws, project)}/false-positives`, { branch }, { signal }),
        refetchInterval: (q) => (q.state.data?.analysis?.status === "running" ? WAIT_MS : false),
    });

export const patternApi = {
    group: (ws: string, project: string, branch: string) =>
        api.post<Analysis>(`${paths.project(ws, project)}/patterns/group`, {}, { branch }),
    create: (ws: string, project: string, body: CommonIssueInput) => api.post<CommonIssue>(`${paths.project(ws, project)}/patterns`, body),
    update: (ws: string, project: string, id: string, body: CommonIssueInput) =>
        api.patch<CommonIssue>(`${paths.project(ws, project)}/patterns/${encodeURIComponent(id)}`, body),
    merge: (ws: string, project: string, id: string, into: string) =>
        api.post<CommonIssue>(`${paths.project(ws, project)}/patterns/${encodeURIComponent(id)}/merge`, { into }),
    remove: (ws: string, project: string, id: string) => api.delete(`${paths.project(ws, project)}/patterns/${encodeURIComponent(id)}`),
    findFalsePositives: (ws: string, project: string, branch: string) =>
        api.post<Analysis>(`${paths.project(ws, project)}/false-positives`, {}, { branch }),
};
