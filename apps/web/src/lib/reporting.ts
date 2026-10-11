// Reporting the app's own faults (an exception nothing caught, a page that failed to render) to Sentry,
// when the instance is set up for it. The server says so in a <meta> element of index.html; without it
// none of this is even downloaded.
//
// Reports go to this site's own server (/api/v1/telemetry), which passes them on: the Content Security
// Policy lets a page talk to nothing else. What's sent is the error, where in the app it happened and
// the requests that led up to it (their paths, never what they carried). No page content, no clicks,
// no recordings, and of the person only their account id.

import { isApiError } from "./api";

type Sdk = typeof import("./reporting-sdk");
type Event = import("@sentry/browser").Event;
type Breadcrumb = import("@sentry/browser").Breadcrumb;

interface Settings {
    dsn: string;
    environment: string;
    release: string | null;
}

export const TUNNEL = "/api/v1/telemetry";

/** What the server put in the page, or null when reporting is off (or the element isn't what's expected). */
export function reportingSettings(doc: Document = document): Settings | null {
    const raw = doc.querySelector('meta[name="triagent-reporting"]')?.getAttribute("content");
    if (!raw) return null;
    try {
        const s = JSON.parse(raw) as Partial<Settings>;
        if (typeof s.dsn !== "string" || typeof s.environment !== "string") return null;
        return { dsn: s.dsn, environment: s.environment, release: typeof s.release === "string" ? s.release : null };
    } catch {
        return null;
    }
}

/** A URL without what follows "?" or "#": search text, and the one-time codes a sign-in comes back with. */
export const withoutQuery = (url: string) => url.replace(/[?#].*$/s, "");

/** Credentials of known shapes, wherever they turn up in a message. */
const CREDENTIALS: [RegExp, string][] = [
    [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|tri_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted]"],
    [/\b(authorization:\s*)(basic|bearer|token)\s+\S+/gi, "$1$2 [redacted]"],
];
const clean = (text: string) => CREDENTIALS.reduce((out, [re, to]) => out.replace(re, to), text);

function cleanCrumb(crumb: Breadcrumb): Breadcrumb {
    const data = crumb.data ? { ...crumb.data } : undefined;
    if (data) for (const key of ["url", "from", "to"]) if (typeof data[key] === "string") data[key] = withoutQuery(data[key] as string);
    return { ...crumb, ...(crumb.message ? { message: clean(crumb.message) } : {}), ...(data ? { data } : {}) };
}

/** An event as it leaves: addresses without their query strings, the person as an id and nothing more. */
export function cleanEvent<E extends Event>(event: E): E {
    if (event.request) {
        const { url, headers } = event.request;
        const agent = headers?.["User-Agent"];
        // Which browser it was is half of finding a fault in one; where the person came from isn't.
        event.request = { ...(url ? { url: withoutQuery(url) } : {}), ...(agent ? { headers: { "User-Agent": agent } } : {}) };
    }
    if (event.user) event.user = event.user.id === undefined ? {} : { id: event.user.id };
    if (event.transaction) event.transaction = withoutQuery(event.transaction);
    if (event.message) event.message = clean(event.message);
    for (const e of event.exception?.values ?? []) if (e.value) e.value = clean(e.value);
    if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(cleanCrumb);
    return event;
}

/**
 * Whether a failure is worth a report. Not the server's answers (it reports its own faults, and a refusal
 * isn't one), not a lost connection, and not a page from before an update asking for files that are gone.
 */
export function worthReporting(err: unknown): boolean {
    if (isApiError(err)) return false;
    // Something given up on purpose (leaving a page mid-load), whatever kind of object says so.
    if ((err as { name?: unknown } | null)?.name === "AbortError") return false;
    if (!(err instanceof Error)) return err !== undefined && err !== null;
    if (err instanceof TypeError && /failed to fetch|networkerror|load failed|network request failed/i.test(err.message)) return false;
    if (/dynamically imported module|importing a module script failed|unable to preload css/i.test(err.message)) return false;
    return true;
}

const state: { sdk: Sdk | null; waiting: { err: unknown; where: string }[]; seen: WeakSet<object>; user: string | null } = {
    sdk: null,
    waiting: [],
    seen: new WeakSet(),
    user: null,
};

function send(sdk: Sdk, err: unknown, where: string): void {
    sdk.withScope((scope) => {
        scope.setTag("where", where);
        sdk.captureException(err);
    });
}

/** Report a fault the app caught itself (a page that failed to render, a failed load). `where` says which kind. */
export function reportError(err: unknown, where: string): void {
    if (!worthReporting(err)) return;
    // The same error often arrives twice: from React, and from the page that then shows it.
    if (typeof err === "object" && err !== null) {
        if (state.seen.has(err)) return;
        state.seen.add(err);
    }
    if (state.sdk) send(state.sdk, err, where);
    // Kept until the SDK has loaded, if it's going to: a fault in the first moments is the one most worth having.
    else if (state.waiting.length < 20) state.waiting.push({ err, where });
}

/** Whose reports these are from now on: the account's id, or null once signed out. */
export function setReportingUser(id: string | null): void {
    state.user = id;
    state.sdk?.setUser(id ? { id } : null);
}

/** Start reporting, if the instance asks for it. Returns once it's running (or straight away if it's off). */
export async function startReporting(settings: Settings | null = reportingSettings()): Promise<boolean> {
    if (!settings || state.sdk) return Boolean(state.sdk);
    // Until the SDK is in, what goes wrong is kept for it.
    const early = (e: ErrorEvent | PromiseRejectionEvent) => reportError("reason" in e ? e.reason : e.error, "window");
    window.addEventListener("error", early);
    window.addEventListener("unhandledrejection", early);
    try {
        const sdk = await import("./reporting-sdk");
        sdk.init({
            dsn: settings.dsn,
            tunnel: TUNNEL,
            environment: settings.environment,
            ...(settings.release ? { release: settings.release } : {}),
            // Named one by one: nothing that records the page, the console or what was clicked.
            defaultIntegrations: false,
            integrations: [
                sdk.eventFiltersIntegration(),
                sdk.functionToStringIntegration(),
                sdk.browserApiErrorsIntegration(),
                sdk.breadcrumbsIntegration({ dom: false, xhr: false, fetch: true, history: true, sentry: true }),
                sdk.globalHandlersIntegration(),
                sdk.linkedErrorsIntegration(),
                sdk.dedupeIntegration(),
                sdk.httpContextIntegration(),
            ],
            dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
            tracesSampleRate: 0,
            ignoreErrors: [/ResizeObserver loop/, /dynamically imported module/i, /Importing a module script failed/i],
            beforeSend: (event, hint) =>
                worthReporting(hint.originalException ?? new Error(event.message ?? "")) ? cleanEvent(event) : null,
            beforeBreadcrumb: (crumb) =>
                typeof crumb.data?.url === "string" && crumb.data.url.includes(TUNNEL) ? null : cleanCrumb(crumb),
        });
        if (state.user) sdk.setUser({ id: state.user });
        state.sdk = sdk;
        for (const { err, where } of state.waiting.splice(0)) send(sdk, err, where);
        return true;
    } catch {
        // The app works without it.
        state.waiting = [];
        return false;
    } finally {
        window.removeEventListener("error", early);
        window.removeEventListener("unhandledrejection", early);
    }
}
