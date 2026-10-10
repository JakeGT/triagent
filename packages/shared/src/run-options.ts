// What a review run with several models can be asked to do beyond reviewing and merging. Each is off
// unless chosen for the run (Start a review, the API, the MCP `start_review` tool), or by the project
// for reviews that don't say. A review with one model has none of them.

export interface RunOptions {
    /** Run a model that failed or was stopped once more by itself, and add its findings to the report. */
    retryFailed: boolean;
    agreement: {
        /** Fail the pull request's check only for critical findings at least this many models found; null for any critical. */
        failAt: number | null;
        /** Mark findings only one model found as lower confidence. */
        markSingles: boolean;
    };
    /**
     * Ask a model whether findings the lines and category leave apart are the same problem: a favourite
     * model's id, JUDGE_FIRST for the review's first model that can, or null for nobody.
     */
    judge: string | null;
    /** Compare the models only: the branch's report and triage are left alone. */
    bakeOff: boolean;
}

/** Where a favourite's id goes, for "the review's first model that can be asked". */
export const JUDGE_FIRST = "first";

export const NO_OPTIONS: RunOptions = { retryFailed: false, agreement: { failAt: null, markSingles: false }, judge: null, bakeOff: false };

/** Whether any option is on. */
export function anyOption(o: RunOptions | null | undefined): boolean {
    return Boolean(o && (o.retryFailed || o.agreement.failAt !== null || o.agreement.markSingles || o.judge !== null || o.bakeOff));
}
