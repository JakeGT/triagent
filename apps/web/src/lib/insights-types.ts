// What the analytics, prices, catalogue and allowance endpoints return (see apps/server/src/domain/analytics.ts).

import type { Category, Severity, Status, Via } from "@triagent/shared";
import type { ReviewModel } from "./types";

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

/** The parts of the answer: each tab of the page asks for its own. */
export type AnalyticsSection = "reviews" | "findings" | "triage" | "performance" | "models";

/** One model, over the range: how its reviews went, what it found and what became of that. */
export interface ModelRow {
    /** The provider's model id. */
    key: string;
    provider: string | null;
    /** What reviews called it (a nickname, if it has one), most used first. */
    labels: string[];
    reviews: number;
    failed: number;
    stalled: number;
    failureRate: number | null;
    medianRunSeconds: number | null;
    tokens: number;
    cost: number | null;
    findings: number;
    /** Of its findings from reviews with other models, those no other model found. */
    unique: number;
    accepted: number;
    rejected: number;
    acceptanceRate: number | null;
    costPerFinding: number | null;
    costPerAccepted: number | null;
    /**
     * What its reviews with other models would have been without it: how many there were, the findings only
     * it found that were critical or high, those since accepted, and how much sooner those reviews would
     * have ended (it was the last to finish in `slowestIn` of them), and what it cost in them (null: no price).
     */
    without: { reviews: number; serious: number; accepted: number; slowestIn: number; secondsSaved: number; cost: number | null };
}

export interface DisagreementSide {
    id: string;
    title: string;
    severity: Severity;
    category: Category;
    startLine: number;
    endLine: number;
    foundBy: string[];
    status: Status;
}

/** Where the models of a branch's review disagreed (GET …/disagreements). */
export interface Disagreements {
    branch: string;
    /** The review's models; null when it ran with one. */
    models: string[] | null;
    /** Findings several models found and gave different severities: the first rating is the one shown on the finding. */
    rated: {
        total: number;
        items: {
            id: string;
            path: string;
            startLine: number | null;
            title: string;
            ratings: { model: string; severity: Severity | null; category: Category | null }[];
            spread: number;
            status: Status;
        }[];
    };
    /** Pairs of findings from different models, in the same file and within a few lines, that weren't merged. */
    apart: { total: number; items: { path: string; gap: number; a: DisagreementSide; b: DisagreementSide }[] };
}

export interface ModelsSection {
    rows: ModelRow[];
    /** Reviews that didn't say which model they used. */
    withoutModel: number;
    agreement: {
        findings: number;
        all: number;
        several: number;
        one: number;
        /** Of `a`'s findings in reviews it shared with `b`, the share `b` found too. */
        overlap: { a: string; b: string; of: number; shared: number; share: number | null }[];
    };
    series: { date: string; models: Record<string, { cost: number; accepted: number; rejected: number }> }[];
    /** Fewer decided findings than this and a rate is shown as a guess. */
    smallSample: number;
}

/** A review's models side by side (GET …/runs/{id}/models). */
export interface RunBreakdown {
    /** Whether who found what was kept for this review. */
    recorded: boolean;
    models: {
        label: string;
        provider: string;
        model: string;
        status: string;
        reason: string | null;
        findings: number | null;
        unique: number | null;
        bySeverity: Record<Severity, number> | null;
        accepted: number | null;
        rejected: number | null;
        tokens: { input: number; output: number; cacheRead: number; total: number } | null;
        tokensTotal: number | null;
        seconds: number | null;
        cost: number | null;
    }[];
}

export interface Analytics {
    range: { days: Days; from: string; to: string; unit: "day" | "week"; buckets: string[] };
    scope: { project: string | null; branch: string | null; projects: { slug: string; name: string }[] };
    truncated: { history: boolean; activity: boolean; current: boolean; sources: boolean };
    models?: ModelsSection;
    /** With the reviews: what a model was asked to write in the range, apart from the reviews' own figures. */
    analysis?: { count: number; tokens: number; cost: number | null; unpricedTokens: number };
    unpriced: { model: string; reviews: number; tokens: number }[];
    reviews?: {
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
            /** Reviews some of whose models have no price: their known cost is in `total`, and in no average. */
            partlyPriced: number;
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
            /** Some of its models have no price, so it cost more than `cost`. */
            costPartial: boolean;
            findings: number | null;
            /** The run it was, when it was run here: its page has each model side by side. */
            runId: string | null;
        }[];
    };
    findings?: {
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
    triage?: {
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
    performance?: {
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

/** The instance key's provider and model: the same shape as a workspace's. */
export type InstanceModel = ReviewModel;

export interface InstanceWorkspace {
    id: string;
    slug: string;
    name: string;
    kind: "personal" | "org";
    grant: { monthlyTokens: number; grantedBy: string; grantedAt: string } | null;
    used: number;
    remaining: number | null;
    /** Its own limit on reviews running at once; null: the one for every workspace. */
    reviewLimit: number | null;
}

/** The limits on reviews running at once that a workspace without its own goes by. */
export interface ReviewLimits {
    instance: number;
    perWorkspace: number;
}

export interface InstanceWorkspaces {
    resetsAt: string;
    reviewLimits: ReviewLimits;
    items: InstanceWorkspace[];
}

/** A connected runner: how many reviews it works on at once (`slots`), and how many it's working on now. */
export interface InstanceRunner {
    name: string;
    version: string | null;
    slots: number;
    busy: number;
    lastSeenAt: string;
    /** Finishing the reviews it has before it stops (it's being replaced), and taking no more. */
    draining?: boolean;
}

/** Settings → Instance → Reviews. */
export interface InstanceReviews {
    limits: ReviewLimits;
    /** The server's environment: what applies until limits are saved. */
    defaults: ReviewLimits;
    saved: { by: string; at: string } | null;
    runners: InstanceRunner[];
    /** Reviews running and queued on the whole instance. */
    running: number;
    queued: number;
}
