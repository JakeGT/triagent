// The one logger, for the server and the runner. A line has a level, a fixed message and named fields
// (`log.warn("Sign-in refused", { ip })`), so lines can be searched and counted; what varies goes in the
// fields, never in the message. Every line is cleaned of credentials before it is printed or handed on.
//
// Lines are printed for people (LOG_FORMAT=text, the default) or as one JSON object each (json). Sinks
// get every line too: that is how they reach an error tracker, and how a runner's reach the server.
//
// Levels: `error` is something that shouldn't happen and someone should look at; `warn` is something
// that went wrong but is expected now and then (another service being away, a refused sign-in).
//
// Not exported from the package index: it's for Node (the runner and the server), not the web app.

import { redact } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "text" | "json";
export type LogValue = string | number | boolean | null;

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** An error as it's written down: what was thrown, without anything that can't be printed. */
export interface LogError {
    name: string;
    message: string;
    stack?: string;
    code?: string;
    cause?: LogError;
}

export interface LogRecord {
    time: string;
    level: LogLevel;
    msg: string;
    fields: Record<string, LogValue>;
    error?: LogError;
}

export interface LogSink {
    write(record: LogRecord): void;
    /** Send what's waiting, giving up after `timeoutMs`. */
    flush?(timeoutMs: number): Promise<void>;
}

/** What a line can carry: `err` is the thrown value; everything else becomes a field. */
export type LogFields = Record<string, unknown> & { err?: unknown };

export interface Logger {
    debug(msg: string, fields?: LogFields): void;
    info(msg: string, fields?: LogFields): void;
    warn(msg: string, fields?: LogFields): void;
    error(msg: string, fields?: LogFields): void;
    /** A logger whose lines all carry `fields`. */
    child(fields: Record<string, unknown>): Logger;
}

export interface LogOptions {
    level: LogLevel;
    format: LogFormat;
    /** On every line a sink gets and every JSON line (which program this is); left out of text lines. */
    base: Record<string, LogValue>;
}

const REDACTED = "[redacted]";
/**
 * Names for something that holds a credential, wherever in a name they come ("apiKey", "refresh_tokens",
 * "sessionId"). Under such a name only a figure is kept (a count of tokens is a number; a token is not).
 */
export const SECRET_NAME = /pass(word|phrase)|secret|token|authori[sz]ation|cookie|api[-_]?key|credential|csrf|session|signature|dsn/i;
const MAX_VALUE = 2000;
const MAX_STACK = 8000;

const state: {
    options: LogOptions;
    sinks: LogSink[];
    context: (() => Record<string, unknown> | undefined) | null;
    print: (level: LogLevel, line: string) => void;
} = {
    options: { level: "info", format: "text", base: {} },
    sinks: [],
    context: null,
    // Through console at the time of the call, so whatever captures console output still sees it.
    print: (level, line) => (level === "error" ? console.error(line) : level === "warn" ? console.warn(line) : console.log(line)),
};

export function configureLog(options: Partial<LogOptions>): void {
    state.options = { ...state.options, ...options };
}

/** LOG_LEVEL and LOG_FORMAT. Throws an Error whose message says what to fix. */
export function logOptionsFromEnv(env: Record<string, string | undefined>): Pick<LogOptions, "level" | "format"> {
    const level = env.LOG_LEVEL || "info";
    if (!LOG_LEVELS.includes(level as LogLevel)) throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got "${level}".`);
    const format = env.LOG_FORMAT || "text";
    if (format !== "text" && format !== "json") throw new Error(`LOG_FORMAT must be "text" or "json", got "${format}".`);
    return { level: level as LogLevel, format };
}

/** Fields to add to every line written while `context` returns them (the request being answered). */
export function setLogContext(context: (() => Record<string, unknown> | undefined) | null): void {
    state.context = context;
}

/** Hand every line to `sink` as well. Returns a function that stops doing so. */
export function addLogSink(sink: LogSink): () => void {
    state.sinks.push(sink);
    return () => {
        const i = state.sinks.indexOf(sink);
        if (i >= 0) state.sinks.splice(i, 1);
    };
}

/** Wait for the sinks to send what they hold: before the process ends. */
export async function flushLogs(timeoutMs = 2000): Promise<void> {
    await Promise.allSettled(state.sinks.map((s) => s.flush?.(timeoutMs)));
}

/** Print lines with `print` instead of the console (tests). Returns a function that puts the console back. */
export function captureLog(print: (level: LogLevel, line: string) => void): () => void {
    const before = state.print;
    state.print = print;
    return () => {
        state.print = before;
    };
}

/**
 * A copy of `value` safe to write down or send on: credentials of known shapes taken out of every string,
 * and under a name that says "credential" (at any depth, and for everything beneath it) nothing kept but
 * figures. Errors, dates and other objects that aren't plain data are passed on as they are. Deeper than
 * it's sensible to look is replaced, rather than kept unread.
 */
export function cleanDeep<T>(value: T, secret = false, depth = 0): T {
    if (typeof value === "string") return (secret ? REDACTED : redact(value, [])) as T;
    if (!value || typeof value !== "object") return value;
    if (depth > 12) return REDACTED as T;
    if (Array.isArray(value)) return value.map((v) => cleanDeep(v, secret, depth + 1)) as T;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return (secret ? REDACTED : value) as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cleanDeep(v, secret || SECRET_NAME.test(k), depth + 1);
    return out as T;
}

/** Credentials of known shapes taken out, and cut to a length worth keeping. */
const clean = (text: string, max = MAX_VALUE) => {
    const out = redact(text, []);
    return out.length > max ? `${out.slice(0, max)}… (${out.length - max} more characters)` : out;
};

function value(key: string, v: unknown): LogValue | undefined {
    if (v === undefined) return undefined;
    if (v === null || typeof v === "number" || typeof v === "boolean") return Number.isNaN(v) ? null : v;
    const secret = SECRET_NAME.test(key);
    if (secret && (typeof v !== "object" || v instanceof Error || v instanceof Date)) return REDACTED;
    if (typeof v === "string") return clean(v);
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (v instanceof Error) return clean(v.message);
    try {
        // Looked through before it's written out: a credential can be anywhere inside.
        return clean(JSON.stringify(cleanDeep(v, secret)) ?? String(v));
    } catch {
        return "[unprintable]";
    }
}

/** What was thrown, as it's written down. Never throws, whatever it's given. */
export function logError(err: unknown, depth = 0): LogError {
    if (!(err instanceof Error))
        return { name: "Thrown", message: clean(typeof err === "string" ? err : (value("", err)?.toString() ?? "")) };
    const out: LogError = { name: err.name || "Error", message: clean(err.message) };
    if (typeof err.stack === "string") out.stack = clean(err.stack, MAX_STACK);
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") out.code = String(code).slice(0, 80);
    if (err.cause !== undefined && depth < 3) out.cause = logError(err.cause, depth + 1);
    return out;
}

/** A value on a text line: bare if it's a simple word, quoted (so it can't run on, or start a new line) otherwise. */
const shown = (v: LogValue) => (typeof v === "string" && !/^[\w.:/@+-]+$/.test(v) ? JSON.stringify(v) : String(v));
/** A message on a text line: anything that would start a new line, written out instead. */
const oneLine = (text: string) => JSON.stringify(text).slice(1, -1).replace(/\\"/g, '"');

export function formatText(record: LogRecord): string {
    const fields = Object.entries(record.fields)
        .map(([k, v]) => ` ${k}=${shown(v)}`)
        .join("");
    const error = record.error;
    const why = error ? `: ${oneLine(error.message)}${error.cause ? ` (${oneLine(error.cause.message)})` : ""}` : "";
    const head = `${record.time} ${record.level.toUpperCase().padEnd(5)} ${oneLine(record.msg)}${why}${fields}`;
    // The stack only for what shouldn't happen: for the rest, the message says enough.
    const stack = record.level === "error" && error?.stack ? error.stack.split("\n").slice(1).join("\n") : "";
    return stack ? `${head}\n${stack}` : head;
}

const RESERVED = new Set(["time", "level", "msg", "error"]);

export function formatJson(record: LogRecord, base: Record<string, LogValue> = {}): string {
    // A field can't pass itself off as part of the line: one named like the line's own parts is set aside.
    const fields = Object.fromEntries(Object.entries({ ...base, ...record.fields }).map(([k, v]) => [RESERVED.has(k) ? `_${k}` : k, v]));
    return JSON.stringify({
        time: record.time,
        level: record.level,
        msg: record.msg,
        ...fields,
        ...(record.error ? { error: record.error } : {}),
    });
}

function toSinks(record: LogRecord): void {
    for (const sink of state.sinks) {
        try {
            sink.write(record);
        } catch {
            // A sink that fails mustn't stop the line being printed, or the program.
        }
    }
}

function write(level: LogLevel, msg: string, bound: Record<string, unknown>, given: LogFields | undefined): void {
    const printed = RANK[level] >= RANK[state.options.level];
    // A debug line never leaves the program, so one that isn't printed isn't built.
    if (!printed && (level === "debug" || !state.sinks.length)) return;
    let context: Record<string, unknown> | undefined;
    try {
        context = state.context?.();
    } catch {
        context = undefined;
    }
    const { err, ...rest } = given ?? {};
    const fields: Record<string, LogValue> = {};
    for (const [k, v] of Object.entries({ ...context, ...bound, ...rest })) {
        const out = value(k, v);
        if (out !== undefined) fields[k] = out;
    }
    const record: LogRecord = {
        time: new Date().toISOString(),
        level,
        msg: clean(msg),
        fields,
        ...(err !== undefined ? { error: logError(err) } : {}),
    };
    if (printed) state.print(level, state.options.format === "json" ? formatJson(record, state.options.base) : formatText(record));
    if (level !== "debug") toSinks({ ...record, fields: { ...state.options.base, ...fields } });
}

/**
 * Hand the sinks a line written by another program (a runner's, sent to the server), without printing
 * it: that program printed it already.
 */
export function relayLog(record: LogRecord, extra: Record<string, LogValue> = {}): void {
    toSinks({ ...record, fields: { ...record.fields, ...extra } });
}

function make(bound: Record<string, unknown>): Logger {
    return {
        debug: (msg, fields) => write("debug", msg, bound, fields),
        info: (msg, fields) => write("info", msg, bound, fields),
        warn: (msg, fields) => write("warn", msg, bound, fields),
        error: (msg, fields) => write("error", msg, bound, fields),
        child: (fields) => make({ ...bound, ...fields }),
    };
}

export const log: Logger = make({});
