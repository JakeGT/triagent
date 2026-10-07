/** An error with an HTTP status and a message written for the person or agent who made the request. */
export class ApiError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    /** Extra fields for the response body, e.g. `current` on a 409 so the caller can retry. */
    readonly details: Record<string, unknown> | undefined;

    constructor(status: number, message: string, options: { code?: string; details?: Record<string, unknown> } = {}) {
        super(message);
        this.status = status;
        this.code = options.code;
        this.details = options.details;
    }
}

export const badRequest = (message: string) => new ApiError(400, message);
export const forbidden = (message: string) => new ApiError(403, message);
export const notFound = (message: string) => new ApiError(404, message);
export const conflict = (message: string, details?: Record<string, unknown>) => new ApiError(409, message, details ? { details } : {});
