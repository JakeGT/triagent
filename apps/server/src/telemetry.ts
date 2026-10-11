// Reporting to Sentry, when SENTRY_DSN is set: errors as issues, log lines as logs, and (if asked for)
// a share of requests as traces. Without a DSN none of this runs and nothing leaves the instance.
//
// What is sent is kept to what's needed to find a fault: where it happened, which request, which
// account (its id, never a name or address). Never cookies, headers, request or response bodies, query
// strings, the values in a database query, or the variables on the stack; and everything that is sent
// goes through `scrub`, which takes out credentials of known shapes wherever they turn up. A finding's
// text, a diff and a review's log never go into a log line (packages/shared/src/log.ts), so they
// never get here.
//
// Everything Sentry-specific on the server is in this file: the rest of the code only logs.

import * as Sentry from "@sentry/node";
import { addLogSink, type LogError, type LogRecord, type LogSink } from "@triagent/shared/log";
import { redact } from "@triagent/shared/redact";
import type { TelemetryConfig } from "./config.ts";

const REDACTED = "[redacted]";
/** Named for what they hold: taken out whatever the value looks like. */
const SECRET_KEY = /(pass(word|phrase)|secret|token|authori[sz]ation|cookie|api[-_]?key|credential|csrf|session|signature|dsn)/i;
/** Token counts and the like are named "tokens": figures, not credentials. */
const SAFE_KEY = /tokens|^sentry\./i;

/** The parts of the SDK that are used: the ones that read variables, console output or request data in full are left out. */
const INTEGRATIONS = new Set([
    "EventFilters",
    "FunctionToString",
    "LinkedErrors",
    "Dedupe",
    "NodeSystemError",
    "RequestData",
    "Http",
    "NodeFetch",
    "ContextLines",
    "Context",
    "Hono",
    "PostgresJs",
]);

/** A URL without what follows "?" or "#", where search text, tokens and one-time codes travel. */
export const withoutQuery = (url: string) => url.replace(/[?#].*$/s, "");

/**
 * A copy of `value` with credentials taken out of every string, and anything under a key named for a
 * credential replaced whole. Deeper than it's sensible to look is replaced, rather than kept unread.
 */
export function scrub<T>(value: T, depth = 0): T {
    if (typeof value === "string") return redact(value, []) as T;
    if (!value || typeof value !== "object") return value;
    if (depth > 12) return REDACTED as T;
    if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as T;
    // Errors, dates and the like are passed on as they are: the SDK reads them itself.
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
        out[k] = SECRET_KEY.test(k) && !SAFE_KEY.test(k) && v !== null && typeof v !== "boolean" ? REDACTED : scrub(v, depth + 1);
    return out as T;
}

/** Who asked: their address and browser. Not needed to find a fault, so not sent. */
const CALLER = /^(client\.|user_agent\.|http\.client_ip$|network\.peer\.|net\.peer\.|net\.sock\.peer\.)/;

/**
 * What a span or a breadcrumb says about a request, under whichever names the SDK gave it: URLs without
 * their query strings, and nothing about who asked.
 */
function withoutQueries(data: Record<string, unknown> | undefined): void {
    if (!data) return;
    for (const key of Object.keys(data)) {
        const v = data[key];
        if (/(^|\.)(query|fragment)$|query_string/.test(key) || CALLER.test(key)) delete data[key];
        else if (typeof v === "string" && /(^|[._])(url|target|full|description)$|^url$/i.test(key)) data[key] = withoutQuery(v);
    }
}

/** An error or a trace as it leaves: no request data beyond the method and path, no account beyond its id. */
export function scrubEvent<E extends Sentry.Event>(event: E): E {
    if (event.request) {
        const { method, url } = event.request;
        event.request = { ...(method ? { method } : {}), ...(url ? { url: withoutQuery(url) } : {}) };
    }
    if (event.user) event.user = event.user.id === undefined ? {} : { id: event.user.id };
    for (const exception of event.exception?.values ?? []) for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
    for (const crumb of event.breadcrumbs ?? []) withoutQueries(crumb.data);
    for (const span of event.spans ?? []) {
        withoutQueries(span.data);
        if (span.description && /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) /.test(span.description))
            span.description = withoutQuery(span.description);
    }
    withoutQueries(event.contexts?.trace?.data);
    if (event.transaction) event.transaction = withoutQuery(event.transaction);
    return scrub(event);
}

/** The error a line carried, as an Error again, so the SDK reads its stack as it would the original's. */
function toError(e: LogError): Error {
    const err = new Error(e.message, e.cause ? { cause: toError(e.cause) } : undefined);
    err.name = e.name;
    // Without a stack of its own it mustn't get this function's.
    err.stack = e.stack ?? `${e.name}: ${e.message}`;
    return err;
}

/** Fields about a person, kept in the instance's own log and left out of what's sent on. */
const PERSONAL = new Set(["ip", "username", "email", "subject", "name"]);

/** Fields that become tags, to search and group issues by. */
const TAGS = ["service", "runner", "route", "method", "request", "workspace", "project", "run", "status"] as const;
/** The same error line at most this often becomes an issue event: an outage repeats one line for as long as it lasts. */
const ISSUE_EVERY_MS = 60_000;

export function sentrySink(config: Pick<TelemetryConfig, "logs">, now: () => number = Date.now): LogSink {
    const last = new Map<string, number>();
    return {
        write(record: LogRecord) {
            const { level, msg, error } = record;
            const fields = Object.fromEntries(Object.entries(record.fields).filter(([k]) => !PERSONAL.has(k)));
            if (config.logs)
                Sentry.logger[level](msg, {
                    ...fields,
                    ...(error
                        ? { "error.type": error.name, "error.message": error.message, ...(error.code ? { "error.code": error.code } : {}) }
                        : {}),
                });
            if (level !== "error") return;
            const key = `${msg}\n${error?.name ?? ""}\n${fields.service ?? ""}`;
            const at = now();
            if (at - (last.get(key) ?? Number.NEGATIVE_INFINITY) < ISSUE_EVERY_MS) return;
            if (last.size > 500) last.clear();
            last.set(key, at);
            Sentry.withScope((scope) => {
                scope.setLevel("error");
                for (const tag of TAGS)
                    if (fields[tag] !== undefined && fields[tag] !== null) scope.setTag(tag, String(fields[tag]).slice(0, 200));
                scope.setTag("log", msg.slice(0, 200));
                if (fields.user) scope.setUser({ id: String(fields.user) });
                scope.setContext("log", { message: msg, time: record.time, ...fields });
                if (error)
                    Sentry.captureException(toError(error), {
                        mechanism: { type: fields.unhandled ? "onunhandled" : "generic", handled: !fields.unhandled },
                    });
                else Sentry.captureMessage(msg, "error");
            });
        },
        async flush(timeoutMs: number) {
            await Sentry.flush(timeoutMs);
        },
    };
}

/** What Sentry.init is given. On its own so tests can check what would be sent without sending it. */
export function sentryOptions(config: TelemetryConfig): Sentry.NodeOptions {
    return {
        dsn: config.dsn,
        environment: config.environment,
        ...(config.release ? { release: config.release } : {}),
        tracesSampleRate: config.tracesSampleRate,
        // A request's spans are sent together once it's answered, so they can be cleaned together (beforeSendTransaction).
        traceLifecycle: "static",
        integrations: (defaults) => defaults.filter((i) => INTEGRATIONS.has(i.name)),
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: false,
            httpBodies: [],
            urlQueryParams: false,
            databaseQueryData: false,
            queues: false,
            stackFrameVariables: false,
            graphQL: { document: false, variables: false },
            genAI: { inputs: false, outputs: false },
        },
        // Sentry's own name for the machine is the container's id: no use to anyone.
        includeServerName: false,
        // Fetch errors keep the message the code that catches them expects.
        enhanceFetchErrorMessages: "report-only",
        // Health checks and the runners asking for work, every few seconds, aren't worth a trace each.
        ignoreTransactions: [/\/healthz$/, /\/internal\/runner\//],
        // Every error reaches here through the log (the sink below), with the request it belongs to. The SDK's own
        // catch in the web framework would report each a second time, and every refused request (a 404, a 403) with it.
        beforeSend: (event) => (event.exception?.values?.some((v) => v.mechanism?.type?.startsWith("auto.")) ? null : scrubEvent(event)),
        beforeSendTransaction: (event) => scrubEvent(event),
        beforeSendLog: (entry) => ({ ...entry, ...(entry.attributes ? { attributes: scrub(entry.attributes) } : {}) }),
        beforeBreadcrumb(crumb) {
            withoutQueries(crumb.data);
            return scrub(crumb);
        },
    };
}

/** Start reporting. Called once, before anything else is loaded (instrument.ts). */
export function startTelemetry(config: TelemetryConfig): void {
    Sentry.init(sentryOptions(config));
    Sentry.setTag("service", "server");
    addLogSink(sentrySink(config));
}
