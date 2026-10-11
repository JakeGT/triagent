// The web app's error reports, on their way to Sentry. The browser never talks to Sentry itself: the
// Content Security Policy lets a page reach its own server and nothing else (connect-src 'self'), and
// that stays so. The app posts Sentry's envelopes here; the server checks each is for the project it was
// set up with and passes it on as it is. People's addresses aren't passed on with them.

import { log } from "@triagent/shared/log";
import { parseDsn, type TelemetryConfig } from "../config.ts";
import { ApiError, badRequest } from "../errors.ts";

export const MAX_ENVELOPE_BYTES = 512 * 1024;

export class BrowserReports {
    private readonly dsn: string;
    private readonly url: string;
    private readonly fetch: typeof fetch;

    constructor(dsn: string, fetcher: typeof fetch = fetch) {
        this.dsn = dsn;
        const parsed = parseDsn(dsn);
        if (!parsed) throw new Error("The web app's reports need a Sentry DSN to be passed on to.");
        this.url = parsed.envelopeUrl;
        this.fetch = fetcher;
    }

    /** What the page is told, so the app knows where its reports belong (http/static.ts writes it into index.html). */
    static forPage(telemetry: TelemetryConfig | null): { dsn: string; environment: string; release: string | null } | null {
        if (!telemetry?.browserDsn) return null;
        return { dsn: telemetry.browserDsn, environment: telemetry.environment, release: telemetry.release };
    }

    /**
     * Pass one envelope on. Returns the status to answer with: 200 whatever became of it, except when
     * Sentry says to slow down (429), which the app's SDK needs to hear.
     */
    async forward(raw: Buffer): Promise<{ status: 200 | 429; retryAfter: string | null }> {
        // An envelope starts with a line of JSON saying where it's for.
        const end = raw.indexOf(0x0a);
        let header: { dsn?: unknown };
        try {
            header = JSON.parse(raw.subarray(0, end === -1 ? raw.length : end).toString("utf8")) as { dsn?: unknown };
        } catch {
            throw badRequest("Not a Sentry envelope.");
        }
        // Only ours: this isn't a way to send anything to any Sentry project.
        if (!header || typeof header !== "object" || header.dsn !== this.dsn)
            throw new ApiError(403, "That report isn't for this instance's project.");
        try {
            const res = await this.fetch(this.url, {
                method: "POST",
                headers: { "content-type": "application/x-sentry-envelope" },
                body: new Uint8Array(raw),
                signal: AbortSignal.timeout(5000),
            });
            await res.body?.cancel().catch(() => {});
            if (res.status === 429) return { status: 429, retryAfter: res.headers.get("retry-after") };
            if (!res.ok) log.debug("Sentry refused a report from the web app", { status: res.status });
        } catch (err) {
            // Lost, and not worth more than a note: a report about a report would only follow it.
            log.debug("Couldn't pass a report from the web app on to Sentry", { err });
        }
        return { status: 200, retryAfter: null };
    }
}
