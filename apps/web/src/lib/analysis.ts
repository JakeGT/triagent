// What a model has been asked to write (apps/server/src/services/analyst.ts): the types the server
// answers with, and the queries. A piece of writing is "running" until the model has answered, so its
// queries ask again every couple of seconds while anything in them still is.

import { queryOptions } from "@tanstack/react-query";
import type { Category, Severity, Status } from "@triagent/shared";
import { api, paths } from "./api";
import type { Days } from "./insights-types";
import { keys } from "./queries";

export type AnalysisKind = "comparison" | "summary" | "answer";

/** One look at an issues list a question asked for, as the Issues page can show it. */
export interface AnalysisLookup {
    project: string;
    branch?: string;
    severity?: Severity[];
    category?: Category[];
    status?: Status[];
    path?: string;
    q?: string;
    model?: string;
    onlyModel?: boolean;
    foundBy?: number;
    /** In words: "open findings in src/ in app". */
    label: string;
    total: number;
    /** Why it couldn't be looked at. */
    error?: string;
}

export interface Analysis {
    id: string;
    kind: AnalysisKind;
    status: "running" | "done" | "failed";
    requestedBy: { name: string };
    model: { label: string; model: string } | null;
    tokens: { input: number; output: number; total: number } | null;
    input: { question?: string; project?: string | null; branch?: string | null; days?: Days } | null;
    result: {
        markdown?: string;
        /** There was little to go on, and why. */
        warning?: string;
        /** A question: the scope it was asked in, and what it looked at beyond the analytics. */
        scope?: string;
        lookups?: AnalysisLookup[];
        /** A comparison: whether it had the findings themselves, or only each model's figures. */
        withFindings?: boolean;
    } | null;
    error: string | null;
    createdAt: string;
    finishedAt: string | null;
}

/** Whether there's a model to ask now, and if not, why. */
export type AnalysisModel = { ready: true; label: string } | { ready: false; reason: string };

export interface RunAnalysis {
    comparison: Analysis | null;
    summary: Analysis | null;
    /** Why each can't be written for this review; null when it can. */
    unavailable: { comparison: string | null; summary: string | null };
    model: AnalysisModel;
}

export interface BranchAnalysis {
    branch: string;
    /** The branch's latest review each can be written for, and what's been written. */
    summary: { run: { id: string; title: string; finishedAt: string | null } | null; analysis: Analysis | null };
    comparison: { run: { id: string; title: string; finishedAt: string | null } | null; analysis: Analysis | null };
    model: AnalysisModel;
}

export interface AnalysisSettings {
    model: string | null;
    afterReview: { comparison: boolean; summary: boolean };
    ready: boolean;
    reason: string | null;
    label: string | null;
    models: {
        id: string;
        name: string;
        model: string;
        providerName: string;
        ready: boolean;
        missing: string | null;
        canBeAsked: boolean;
    }[];
    limit: { perHour: number; lastHour: number };
}

const WAIT_MS = 2000;
const running = (...list: (Analysis | null | undefined)[]) => list.some((a) => a?.status === "running");

export const analysisKeys = {
    all: (ws: string) => ["ws", ws, "analysis"] as const,
    settings: (ws: string) => keys.wsSettings(ws, "analysis"),
    run: (ws: string, runId: string) => ["ws", ws, "analysis", "run", runId] as const,
    branch: (ws: string, project: string, branch: string) => ["ws", ws, "analysis", "branch", project, branch] as const,
    one: (ws: string, id: string) => ["ws", ws, "analysis", "one", id] as const,
};

export const analysisSettingsQuery = (ws: string) =>
    queryOptions({
        queryKey: analysisKeys.settings(ws),
        queryFn: ({ signal }) => api.get<AnalysisSettings>(`${paths.workspace(ws)}/settings/analysis`, undefined, { signal }),
    });

export const runAnalysisQuery = (ws: string, runId: string) =>
    queryOptions({
        queryKey: analysisKeys.run(ws, runId),
        queryFn: ({ signal }) =>
            api.get<RunAnalysis>(`${paths.workspace(ws)}/runs/${encodeURIComponent(runId)}/analysis`, undefined, { signal }),
        refetchInterval: (q) => (running(q.state.data?.comparison, q.state.data?.summary) ? WAIT_MS : false),
    });

export const branchAnalysisQuery = (ws: string, project: string, branch: string) =>
    queryOptions({
        queryKey: analysisKeys.branch(ws, project, branch),
        queryFn: ({ signal }) => api.get<BranchAnalysis>(`${paths.project(ws, project)}/analysis`, { branch }, { signal }),
        refetchInterval: (q) => (running(q.state.data?.comparison.analysis, q.state.data?.summary.analysis) ? WAIT_MS : false),
    });

export const analysisQuery = (ws: string, id: string) =>
    queryOptions({
        queryKey: analysisKeys.one(ws, id),
        queryFn: ({ signal }) => api.get<Analysis>(`${paths.workspace(ws)}/analyses/${encodeURIComponent(id)}`, undefined, { signal }),
        refetchInterval: (q) => (running(q.state.data) ? WAIT_MS : false),
    });

export const writeForRun = (ws: string, runId: string, kind: "comparison" | "summary") =>
    api.post<Analysis>(`${paths.workspace(ws)}/runs/${encodeURIComponent(runId)}/analysis`, { kind });

export const askQuestion = (ws: string, body: { question: string; project?: string; branch?: string; days: Days }) =>
    api.post<Analysis>(`${paths.workspace(ws)}/ask`, body);
