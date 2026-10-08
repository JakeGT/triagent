// What the analytics, prices, catalogue and allowance endpoints return (see apps/server/src/domain/analytics.ts).

import type { Severity, Via } from "@triagent/shared";
import type { SecretView } from "./types";

export type Days = 7 | 30 | 90 | 365 | 0;
export type ReviewStatus = "done" | "partial" | "failed" | "cancelled";
export type PriceSource = "workspace" | "instance" | "openrouter";

export interface Price {
    input: number;
    output: number;
    cacheRead: number | null;
}

export interface ReviewGroup {
    key: string;
    reviews: number;
    done: number;
    partial: number;
    failed: number;
    cancelled: number;
    tokens: number;
    cost: number | null;
    findings: number;
    medianRunSeconds: number | null;
    costPerFinding: number | null;
}

export interface HotspotRow extends Record<Severity, number> {
    key: string;
    open: number;
}

export interface PerfRow {
    key: string;
    reviews: number;
    failed: number;
    partialRate: number | null;
    medianRunSeconds: number | null;
    tokensPerMinute: number | null;
    retries: number;
    llmFailures: number;
}

export interface Analytics {
    range: { days: Days; from: string; to: string; unit: "day" | "week"; buckets: string[] };
    scope: { project: string | null; branch: string | null; projects: { slug: string; name: string }[] };
    truncated: { history: boolean; activity: boolean };
    unpriced: { model: string; reviews: number; tokens: number }[];
    reviews: {
        total: number;
        byStatus: Record<ReviewStatus, number>;
        runs: number;
        uploads: number;
        runSeconds: { median: number | null; p90: number | null; recorded: number };
        queueSeconds: { median: number | null; p90: number | null; recorded: number };
        /** `estimated`: reviews whose tokens are the budget they were given, as they ended without a figure. */
        tokens: {
            total: number;
            input: number;
            output: number;
            cacheRead: number;
            recorded: number;
            estimated: number;
            estimatedTotal: number;
        };
        findings: number;
        cost: {
            total: number | null;
            pricedReviews: number;
            perReview: number | null;
            perPr: number | null;
            prs: number;
            perFinding: number | null;
        };
        series: ({ date: string; tokens: number; cost: number } & Record<ReviewStatus, number>)[];
        byModel: ReviewGroup[];
        byKind: ReviewGroup[];
        latest: {
            id: string;
            at: string;
            project: string | null;
            branch: string;
            kind: string;
            source: "run" | "upload";
            status: ReviewStatus;
            model: string | null;
            prNumber: number | null;
            requestedBy: string | null;
            runSeconds: number | null;
            tokens: number | null;
            tokensEstimated: boolean;
            cost: number | null;
            findings: number | null;
        }[];
    };
    findings: {
        open: number;
        inProgress: number;
        unassigned: number;
        needsDiscussion: number;
        openBySeverity: Record<Severity, number>;
        age: { under7: number; under30: number; under90: number; older: number; notRecorded: number };
        added: number;
        removed: number;
        resolved: number;
        wontFix: number;
        closed: number;
        wontFixRate: number | null;
        reopenedByReview: number;
        reopenedByPeople: number;
        duplicates: number;
        flagged: number;
        corrections: { severity: number; category: number; severityChanges: { from: string; to: string; n: number }[] };
        series: { date: string; added: number; closed: number; reopened: number }[];
        hotspots: { folders: HotspotRow[]; files: HotspotRow[]; categories: HotspotRow[] };
    };
    triage: {
        closed: number;
        byAgents: number;
        agentShare: number | null;
        closedPerWeek: number;
        series: { date: string; closed: number; byAgents: number }[];
        timeToResolve: {
            medianHours: number | null;
            p90Hours: number | null;
            notRecorded: number;
            bySeverity: { severity: Severity; resolved: number; medianHours: number | null; p90Hours: number | null }[];
        };
        people: {
            actor: string;
            agent: boolean;
            via: Via[];
            resolved: number;
            wontFix: number;
            reopened: number;
            notes: number;
            corrections: number;
            claims: number;
            releases: number;
            flags: number;
            lastAt: string;
        }[];
    };
    performance: {
        reviews: number;
        partial: number;
        partialRate: number | null;
        groups: { total: number; failed: number; recorded: number };
        llm: { requests: number; retries: number; failures: number; recorded: number };
        tokensPerMinute: { value: number | null; recorded: number };
        tokensPerFile: { value: number | null; recorded: number };
        tools: {
            calls: number;
            failures: number;
            recorded: number;
            failureRate: number | null;
            byTool: { tool: string; calls: number; failures: number; failureRate: number | null }[];
        };
        byModel: PerfRow[];
        ocrVersions: PerfRow[];
    };
}

export interface CatalogueModel {
    id: string;
    name: string;
    price: Price;
    contextLength: number | null;
}

export interface Catalogue {
    enabled: boolean;
    fetchedAt: string | null;
    error: string | null;
    models: CatalogueModel[];
}

export interface PriceEntry extends Price {
    model: string;
    setBy: string;
    setAt: string;
}

export interface WorkspacePrices {
    prices: PriceEntry[];
    instance: PriceEntry[];
    used: { model: string; reviews: number; tokens: number; price: (Price & { source: PriceSource }) | null }[];
}

export interface Allowance {
    granted: boolean;
    monthlyTokens: number | null;
    used: number;
    remaining: number | null;
    resetsAt: string;
    grantedBy: string | null;
    grantedAt: string | null;
    instance: { provider: string; providerName: string; model: string; keySet: boolean };
    now: { ready: true; keySource: "workspace" | "instance"; provider: string; model: string } | { ready: false; reason: string };
}

export interface InstanceModel {
    provider: string;
    model: string;
    ready: boolean;
    providers: { id: string; name: string; url: string; defaultModel: string; keysUrl: string | null; model: string; key: SecretView }[];
}

export interface InstanceWorkspace {
    id: string;
    slug: string;
    name: string;
    kind: "personal" | "org";
    grant: { monthlyTokens: number; grantedBy: string; grantedAt: string } | null;
    used: number;
    remaining: number | null;
}
