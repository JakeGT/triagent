// Reading an Open Code Review JSON report into findings (issues) and the reviewer's summary (tasks).

import { createHash } from "node:crypto";
import { CATEGORIES, type Category, SEVERITIES, type Severity } from "@triagent/shared";

/** One finding as OCR writes it. Findings added by hand carry `added_by` / `added_at`. */
export interface RawComment {
    path: string;
    content: string;
    severity?: unknown;
    category?: unknown;
    start_line?: unknown;
    end_line?: unknown;
    existing_code?: string | null;
    suggestion_code?: string | null;
    added_by?: string;
    added_at?: string;
    /** A review run with several models (domain/merge.ts): the models that found it, the lead first. */
    found_by?: unknown;
    /** …and what the other models said about it. */
    also?: unknown;
}

export interface RawReport {
    comments: RawComment[];
    project_summary?: string | null;
    status?: unknown;
    session_id?: unknown;
    llm?: unknown;
    summary?: unknown;
    warnings?: unknown;
    tool_calls?: unknown;
    /** A review run with several models: those that produced a report, in order. */
    models?: unknown;
    /** …and whether it asked for findings only one of them found to be marked as lower confidence. */
    mark_singles?: unknown;
    [key: string]: unknown;
}

export interface UploadMeta {
    id: string;
    branch: string;
    commit: string | null;
    fileName: string;
    uploadedAt: string;
    uploadedBy: string;
    sha256: string | null;
    scope: "full" | "diff";
}

export interface Issue {
    readonly id: string;
    /** Position in the report, from 1. */
    readonly index: number;
    readonly path: string;
    readonly startLine: number | null;
    readonly endLine: number | null;
    readonly severity: Severity;
    readonly category: Category;
    readonly title: string;
    readonly content: string;
    readonly existingCode: string | null;
    readonly suggestionCode: string | null;
    readonly addedBy: string | null;
    /** The models that found it, when the review ran with several; null otherwise. */
    readonly foundBy: readonly string[] | null;
    /** What the other models that found it said. */
    readonly alsoFound: readonly OtherFinding[];
    /** Only one of the review's models found it, and the review asked for such findings to be marked. */
    readonly lowerConfidence: boolean;
}

export interface OtherFinding {
    readonly model: string;
    readonly severity: Severity | null;
    readonly category: Category | null;
    readonly startLine: number | null;
    readonly endLine: number | null;
    readonly content: string;
    readonly suggestionCode: string | null;
}

export interface Task {
    readonly id: string;
    readonly sectionId: string;
    readonly section: string;
    readonly position: number;
    readonly title: string;
    readonly body: string;
    readonly markdown: string;
    /** Files with findings that the item names. */
    readonly files: readonly string[];
    readonly issueIds: readonly string[];
}

export interface Section {
    readonly id: string;
    readonly title: string;
    readonly intro: string;
    readonly taskIds: readonly string[];
}

export interface ReportWarning {
    file: string;
    message: string;
    type: string;
}

export interface ReviewMeta {
    loaded: boolean;
    upload: UploadMeta | null;
    status: unknown;
    sessionId: unknown;
    llm: unknown;
    summary: unknown;
    warnings: ReportWarning[];
    /** The models a review ran with, when it ran with several (domain/merge.ts); null otherwise. */
    models: string[] | null;
    /** The review asked for findings only one model found to be marked as lower confidence. */
    markSingles: boolean;
}

export interface Review {
    readonly meta: ReviewMeta;
    readonly issues: readonly Issue[];
    readonly byId: ReadonlyMap<string, Issue>;
    readonly paths: readonly string[];
    readonly issuesByPath: ReadonlyMap<string, readonly string[]>;
    readonly summaryMarkdown: string;
    readonly sections: readonly Section[];
    readonly tasks: readonly Task[];
    readonly taskById: ReadonlyMap<string, Task>;
    readonly tasksByPath: ReadonlyMap<string, readonly string[]>;
}

export const MAX_COMMENTS = 50_000;

/** Throws an Error with a message for people if `raw` isn't an Open Code Review JSON report. */
export function validateReport(raw: unknown): asserts raw is RawReport {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("The file isn't a JSON object. Upload the JSON report Open Code Review writes.");
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.comments))
        throw new Error('The file has no "comments" list, so it doesn\'t look like an Open Code Review report.');
    if (r.comments.length > MAX_COMMENTS) throw new Error(`The report has ${r.comments.length} findings; the limit is ${MAX_COMMENTS}.`);
    r.comments.forEach((c: unknown, i: number) => {
        if (!c || typeof c !== "object") throw new Error(`Finding ${i + 1} isn't an object.`);
        const f = c as Record<string, unknown>;
        if (typeof f.path !== "string" || !f.path) throw new Error(`Finding ${i + 1} has no file path.`);
        if (typeof f.content !== "string" || !f.content) throw new Error(`Finding ${i + 1} (${f.path}) has no text.`);
        for (const k of ["existing_code", "suggestion_code"]) {
            if (f[k] != null && typeof f[k] !== "string") throw new Error(`Finding ${i + 1} (${f.path}) has a non-text ${k}.`);
        }
    });
    if (r.project_summary != null && typeof r.project_summary !== "string") throw new Error("project_summary must be text.");
}

/** Two findings are the same if they're at the same place and say the same thing. */
export function sameFinding(a: RawComment, b: RawComment): boolean {
    return (
        a.path === b.path &&
        (a.start_line ?? null) === (b.start_line ?? null) &&
        (a.end_line ?? null) === (b.end_line ?? null) &&
        a.content === b.content
    );
}

/** Stable id for a finding: the same finding in a later report gets the same id, so its triage carries over. */
function findingHash(c: RawComment): string {
    return createHash("sha256")
        .update([c.path, c.start_line ?? "", c.end_line ?? "", c.content].join("\0"))
        .digest("hex");
}

const lineOf = (v: unknown): number | null => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);

/** A short list of model names from a report, or null: anything else is ignored, not refused. */
function modelNames(v: unknown): string[] | null {
    if (!Array.isArray(v)) return null;
    const names = v.filter((x): x is string => typeof x === "string" && x.length > 0).map((x) => x.slice(0, 200));
    return names.length ? [...new Set(names)].slice(0, 10) : null;
}

function otherFindings(v: unknown): OtherFinding[] {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 10).flatMap((o: unknown) => {
        if (!o || typeof o !== "object") return [];
        const x = o as Record<string, unknown>;
        if (typeof x.model !== "string" || !x.model.trim() || typeof x.content !== "string" || !x.content) return [];
        return [
            Object.freeze({
                model: x.model.slice(0, 200),
                severity: (SEVERITIES as readonly unknown[]).includes(x.severity) ? (x.severity as Severity) : null,
                category: (CATEGORIES as readonly unknown[]).includes(x.category) ? (x.category as Category) : null,
                startLine: lineOf(x.start_line),
                endLine: lineOf(x.end_line),
                content: x.content.slice(0, 20_000),
                suggestionCode: typeof x.suggestion_code === "string" ? x.suggestion_code.slice(0, 20_000) : null,
            }),
        ];
    });
}

/** The first sentence of a finding, as its title. */
export function titleOf(text: string, max = 150): string {
    const flat = text.replace(/\s+/g, " ").trim();
    let inCode = false;
    for (let i = 0; i < flat.length; i++) {
        const ch = flat[i] as string;
        if (ch === "`") inCode = !inCode;
        if (inCode || !".?!:;".includes(ch) || !(flat[i + 1] === " " || i === flat.length - 1)) continue;
        const sentence = flat.slice(0, ch === "?" || ch === "!" ? i + 1 : i);
        if (/\b(e\.g|i\.e|etc|vs)$/i.test(sentence) || sentence.length < 12) continue;
        return shorten(sentence, max);
    }
    return shorten(flat, max);
}

function shorten(s: string, max: number): string {
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const space = cut.lastIndexOf(" ");
    const out = (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
    // Keep code spans balanced so the title still renders cleanly.
    return `${(out.match(/`/g) ?? []).length % 2 ? `${out}\`` : out}…`;
}

const slug = (s: string) =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

interface DraftItem {
    raw: string;
}
interface DraftSection {
    id: string;
    title: string;
    intro: string;
    items: DraftItem[];
}

/** Split the reviewer's summary (Markdown) into sections of list items: each item becomes a task. */
function parseSummary(markdown: string): DraftSection[] {
    const sections: DraftSection[] = [];
    let current: DraftSection | null = null;
    let item: DraftItem | null = null;
    for (const line of markdown.split("\n")) {
        const heading = /^#{1,4}\s+(.+?)\s*$/.exec(line);
        if (heading) {
            const title = heading[1] as string;
            current = { id: slug(title) || `section-${sections.length + 1}`, title, intro: "", items: [] };
            sections.push(current);
            item = null;
            continue;
        }
        if (!current) {
            current = { id: "summary", title: "Summary", intro: "", items: [] };
            sections.push(current);
        }
        const bullet = /^\s*(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line);
        if (bullet) {
            item = { raw: bullet[1] as string };
            current.items.push(item);
        } else if (line.trim() && item) {
            item.raw += ` ${line.trim()}`;
        } else if (line.trim()) {
            current.intro += (current.intro ? "\n" : "") + line;
        } else {
            item = null;
        }
    }
    // Two headings with the same text would give two sections the same id; so could "A" twice and an "A 2".
    // Section ids end in a letter or a number, and task ids are "<section>-<n>", so unique section ids
    // keep task ids unique too.
    const seen = new Map<string, number>();
    const taken = new Set<string>();
    for (const s of sections) {
        const n = (seen.get(s.id) ?? 0) + 1;
        seen.set(s.id, n);
        if (n > 1 || taken.has(s.id)) {
            let k = Math.max(n, 2);
            while (taken.has(`${s.id}-${k}`)) k++;
            s.id = `${s.id}-${k}`;
        }
        taken.add(s.id);
    }
    return sections;
}

/** A summary item's title and body: "**Title**: body", "`file` — body", "Title: body", or its first sentence. */
function splitItem(raw: string): { title: string; body: string } {
    let m = /^\*\*(.+?)\*\*\s*[:.—-]?\s*(.*)$/s.exec(raw);
    if (m) return { title: (m[1] as string).replace(/[.:]\s*$/, ""), body: m[2] as string };
    m = /^(`[^`]+`(?:\s*\+\s*`[^`]+`)*)\s+[—–-]\s+(.*)$/s.exec(raw);
    if (m) return { title: m[1] as string, body: m[2] as string };
    const colon = raw.indexOf(": ");
    if (colon > 0 && colon < 110 && (raw.slice(0, colon).match(/`/g) ?? []).length % 2 === 0) {
        return { title: raw.slice(0, colon), body: raw.slice(colon + 2) };
    }
    return { title: titleOf(raw, 110), body: raw };
}

/** Files with findings that a summary item names in `code` spans: exact paths, folders, or bare file names. */
function linkPaths(markdown: string, paths: ReadonlySet<string>, byBase: ReadonlyMap<string, string[]>): string[] {
    const found = new Set<string>();
    for (const [, token] of markdown.matchAll(/`([^`]+)`/g)) {
        const t = (token ?? "").trim().split(":")[0]?.replace(/^\.\//, "") ?? "";
        if (!t || /\s/.test(t) || t.includes("*")) continue;
        if (paths.has(t)) {
            found.add(t);
        } else if (t.includes("/")) {
            const prefix = t.endsWith("/") ? t : `${t}/`;
            for (const p of paths) if (p.startsWith(prefix) || p.endsWith(`/${t}`)) found.add(p);
        } else {
            for (const p of byBase.get(t) ?? []) found.add(p);
        }
    }
    return [...found].sort();
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
}

/** Index a report. `upload` is null for the empty review a branch has before any report. */
export function parseReport(raw: unknown, upload: UploadMeta | null): Review {
    validateReport(raw);
    // Who found what only means something when there was more than one model to ask.
    const models = modelNames(raw.models);
    const several = models !== null && models.length > 1;
    const markSingles = several && raw.mark_singles === true;
    const used = new Set<string>();
    const coerced: string[] = []; // values OCR sent that we don't recognise: reported, not hidden
    const issues: Issue[] = raw.comments.map((c, i) => {
        const hash = findingHash(c);
        // Lengthen the id on a collision; identical findings share the whole hash, so number repeats.
        let n = 8;
        let id = `ocr-${hash.slice(0, n)}`;
        while (used.has(id) && n < 16) id = `ocr-${hash.slice(0, ++n)}`;
        for (let k = 2; used.has(id); k++) id = `ocr-${hash.slice(0, 16)}-${k}`;
        used.add(id);
        const severity = (SEVERITIES as readonly unknown[]).includes(c.severity) ? (c.severity as Severity) : "low";
        const category = (CATEGORIES as readonly unknown[]).includes(c.category) ? (c.category as Category) : "other";
        if (severity !== c.severity) coerced.push(`finding ${i + 1} (${c.path}) had severity ${JSON.stringify(c.severity)}, shown as low`);
        if (category !== c.category)
            coerced.push(`finding ${i + 1} (${c.path}) had category ${JSON.stringify(c.category)}, shown as other`);
        return Object.freeze({
            id,
            index: i + 1,
            path: c.path,
            startLine: lineOf(c.start_line),
            endLine: lineOf(c.end_line),
            severity,
            category,
            title: titleOf(c.content),
            content: c.content,
            existingCode: c.existing_code ?? null,
            suggestionCode: c.suggestion_code ?? null,
            addedBy: typeof c.added_by === "string" ? c.added_by : null,
            foundBy: several ? modelNames(c.found_by) : null,
            alsoFound: several ? otherFindings(c.also) : [],
            lowerConfidence: markSingles && modelNames(c.found_by)?.length === 1,
        });
    });

    const paths = new Set(issues.map((x) => x.path));
    const byBase = new Map<string, string[]>();
    for (const p of paths) pushTo(byBase, p.slice(p.lastIndexOf("/") + 1), p);
    const issuesByPath = new Map<string, string[]>();
    for (const x of issues) pushTo(issuesByPath, x.path, x.id);

    const summaryMarkdown = String(raw.project_summary ?? "");
    const drafts = parseSummary(summaryMarkdown);
    const tasks: Task[] = [];
    const tasksByPath = new Map<string, string[]>();
    const sections: Section[] = drafts.map((s) => {
        const taskIds = s.items.map((item, i) => {
            const { title, body } = splitItem(item.raw);
            const files = linkPaths(item.raw, paths, byBase);
            const task: Task = Object.freeze({
                id: `${s.id}-${i + 1}`,
                sectionId: s.id,
                section: s.title,
                position: i + 1,
                title,
                body,
                markdown: item.raw,
                files,
                issueIds: files.flatMap((p) => issuesByPath.get(p) ?? []),
            });
            tasks.push(task);
            for (const p of files) pushTo(tasksByPath, p, task.id);
            return task.id;
        });
        return Object.freeze({ id: s.id, title: s.title, intro: s.intro, taskIds });
    });

    const warnings: ReportWarning[] = Array.isArray(raw.warnings)
        ? raw.warnings.map((w: Record<string, unknown> | null) => ({
              file: String(w?.file ?? ""),
              message: String(w?.message ?? ""),
              type: String(w?.type ?? ""),
          }))
        : [];
    warnings.push(...coerced.slice(0, 50).map((message) => ({ file: "(report)", message, type: "unrecognised_value" })));
    if (coerced.length > 50)
        warnings.push({
            file: "(report)",
            message: `${coerced.length - 50} more unrecognised severities or categories`,
            type: "unrecognised_value",
        });

    return {
        meta: {
            loaded: upload !== null,
            upload,
            status: raw.status ?? null,
            sessionId: raw.session_id ?? null,
            llm: raw.llm ?? null,
            summary: raw.summary ?? null,
            warnings,
            models: several ? models : null,
            markSingles,
        },
        issues,
        byId: new Map(issues.map((x) => [x.id, x])),
        paths: [...paths].sort(),
        issuesByPath,
        summaryMarkdown,
        sections,
        tasks,
        taskById: new Map(tasks.map((t) => [t.id, t])),
        tasksByPath,
    };
}

export const EMPTY_REVIEW: Review = parseReport({ comments: [], project_summary: "" }, null);

/**
 * Lower is more urgent: severity, then category, then position in the report. Findings marked as lower
 * confidence (only one model found them, and the review asked) come after the others of their severity.
 */
export function priorityCompare(
    a: Pick<Issue, "severity" | "category" | "index"> & { lowerConfidence?: boolean },
    b: Pick<Issue, "severity" | "category" | "index"> & { lowerConfidence?: boolean },
): number {
    return (
        SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
        Number(a.lowerConfidence ?? false) - Number(b.lowerConfidence ?? false) ||
        CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
        a.index - b.index
    );
}

export function severityWeight(s: Severity): number {
    return { critical: 8, high: 4, medium: 2, low: 1 }[s];
}
