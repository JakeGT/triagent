// The server's internal runner API, with the shared secret.

import type { RunnerModel } from "../../../packages/shared/src/model.ts";

export interface ClaimedJob {
    id: string;
    kind: "pr" | "changes" | "full";
    title: string;
    leaseSeconds: number;
    repository: { fullName: string; cloneUrl: string };
    git: { username: string; token: string };
    pr: { number: number } | null;
    gitRef: string | null;
    baseRef: string | null;
    headSha: string | null;
    /** The project's time limit, or null (or absent) for none. */
    timeoutMinutes?: number | null;
    /** Stop a model's review that has printed nothing for this long; null (or absent) to never. */
    stallMinutes?: number | null;
    maxTokensBudget: number | null;
    /** The protocol OCR speaks to the model, and this job's credentials for it: the first of `models`. */
    model: RunnerModel;
    /** Every model to review with (all at once), in order, each with how people know it, and its own token budget if it has one (else the job's). */
    models?: (RunnerModel & { label: string; maxTokensBudget?: number | null })[];
}

/** How one model's review went, in a job with several. */
export interface FinishPart {
    status: "done" | "failed" | "cancelled";
    report?: unknown;
    error?: string | null;
    tokens?: number | null;
    seconds?: number | null;
    /** Why it was stopped, when it was: it went quiet, or passed the time limit or its token budget. */
    reason?: "stalled" | "timeLimit" | "overBudget";
}

/** A model the server wants stopped while the job's others carry on: by its place in the job's `models`. */
export interface ModelStop {
    index: number;
    label?: string;
    reason: "overBudget";
    /** The token budget it passed. */
    budget?: number | null;
}

/**
 * What the server says back to a heartbeat or a batch of events: stop the whole job (`cancel`), or only
 * some of its models (`stop`; absent from a server older than models reviewing at once).
 */
export interface Orders {
    cancel: boolean;
    stop?: ModelStop[];
}

export interface RunnerIdentity {
    id: string;
    name: string;
    version: string | null;
    slots: number;
}

export class ServerError extends Error {
    readonly status: number;
    readonly code: string | null;

    constructor(status: number, message: string, code: string | null = null) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** The job is no longer this runner's (cancelled elsewhere, lease lost, or finished). */
export const isLost = (err: unknown) => err instanceof ServerError && err.status === 409;

export class ServerClient {
    private readonly url: string;
    private readonly secret: string;
    private readonly identity: () => RunnerIdentity;

    constructor(url: string, secret: string, identity: () => RunnerIdentity) {
        this.url = url;
        this.secret = secret;
        this.identity = identity;
    }

    private async post<T>(path: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
        let res: Response;
        try {
            res = await fetch(`${this.url}${path}`, {
                method: "POST",
                headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
                body: JSON.stringify({ runner: this.identity(), ...body }),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw new ServerError(0, `Couldn't reach the server (${(err as Error).message}).`);
        }
        const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        if (!res.ok) throw new ServerError(res.status, data.error ?? `The server answered ${res.status}.`, data.code ?? null);
        return data as T;
    }

    async claim(): Promise<ClaimedJob | null> {
        return (await this.post<{ job: ClaimedJob | null }>("/internal/runner/claim", {})).job;
    }

    heartbeat(jobId: string): Promise<Orders> {
        return this.post(`/internal/runner/jobs/${encodeURIComponent(jobId)}/heartbeat`, {});
    }

    events(jobId: string, lines: { at: string; line: string }[], progress: Record<string, unknown> | null): Promise<Orders> {
        return this.post(`/internal/runner/jobs/${encodeURIComponent(jobId)}/events`, { lines, ...(progress ? { progress } : {}) });
    }

    finish(
        jobId: string,
        outcome: {
            status: "done" | "failed" | "cancelled";
            report?: unknown;
            parts?: FinishPart[];
            error?: string | null;
            headSha?: string | null;
            baseSha?: string | null;
        },
    ): Promise<{ ok: boolean }> {
        return this.post(`/internal/runner/jobs/${encodeURIComponent(jobId)}/finish`, outcome, 120_000);
    }
}
