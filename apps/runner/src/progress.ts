// Progress, read from Open Code Review's human-readable stderr. OCR doesn't print an overall "n of m",
// so this reports what it does say, for example:
//
//   [ocr] 12 file(s) changed, reviewing 10 in /path
//   [ocr] Skipping plan phase for group "src/db" (3 file(s), …)
//   [ocr] Round 2/2 added no new findings for group "src/db"; stopping early
//   [ocr] Round 2 failed for group "src/db": LLM completion error: … (keeping earlier findings)
//   [ocr]   ▶ file_read path=…      [ocr]   ✔ file_read (4ms)      [ocr]   ✘ file_read failed: …
//
// Groups are reviewed in parallel, so "current" and "round" are whichever group spoke last. Tokens come
// from what OCR says when a budget stops it and from the usage record it writes when it fails or is
// stopped, so a review that ends without a report still says what it cost.

export interface Progress {
    phase?: string;
    files?: number;
    filesChanged?: number;
    groups?: number;
    current?: string;
    round?: string;
    roundsFailed?: number;
    toolCalls?: number;
    toolFailures?: number;
    /** The most model tokens OCR has said it used so far (its report may never come: a time limit, a cancel). */
    tokens?: number;
    /** With several models: which one is reviewing now, e.g. "gpt-5 (2 of 3)". */
    model?: string;
}

const UNIT: Record<string, number> = { "": 1, K: 1_000, M: 1_000_000 };

/**
 * Tokens used, from a line of OCR's stderr: its usage record (JSON, written to stderr when a review fails
 * or is stopped), its text summary on failure, or a budget stop ("used 12K").
 */
export function tokensSaid(line: string): number | null {
    const record = /^\s*"total_tokens":\s*(\d{1,15}),?\s*$/.exec(line);
    if (record) return Number(record[1]);
    const usage = /^\s*\[ocr\] usage on failure:.*= (\d{1,15}) total tokens\b/.exec(line);
    if (usage) return Number(usage[1]);
    const budget = /^\s*\[ocr\] token budget reached \(used (\d+(?:\.\d+)?)([KM]?) /.exec(line);
    if (budget) return Math.round(Number(budget[1]) * (UNIT[budget[2] as string] ?? 1));
    return null;
}

/**
 * Progress after one more line of OCR's stderr. `seen` collects the group names met so far; `base` is
 * the tokens earlier models used, in a job with several.
 */
export function readProgress(before: Progress, line: string, seen: Set<string>, base = 0): Progress {
    const p: Progress = { toolCalls: 0, toolFailures: 0, ...before };
    const changed = /\b(\d+) file\(s\) (?:changed|selected|to scan)[^,]*, reviewing (\d+)/.exec(line);
    const scanning = /\b(?:scanning|reviewing) (\d+) file\(s\)/i.exec(line);
    if (changed) {
        p.filesChanged = Number(changed[1]);
        p.files = Number(changed[2]);
    } else if (scanning) p.files = Number(scanning[1]);
    const group = /group "([^"]{1,200})"/.exec(line);
    if (group) {
        if (seen.size < 5000) seen.add(group[1] as string);
        p.groups = seen.size;
        p.current = group[1] as string;
    }
    const round = /\bRound (\d+)\/(\d+)/.exec(line);
    // "Round 2 failed …" or "Round 2/3 failed …": a failure either way.
    const failed = /\bRound (\d+)(\/\d+)? failed for group/.exec(line);
    if (failed) {
        p.round = `${failed[1]}${failed[2] ?? (p.round?.includes("/") ? p.round.slice(p.round.indexOf("/")) : "")}`;
        p.roundsFailed = (p.roundsFailed ?? 0) + 1;
    } else if (round) p.round = `${round[1]}/${round[2]}`;
    const said = tokensSaid(line);
    if (said !== null) p.tokens = Math.max(p.tokens ?? 0, base + said);
    if (/^\s*\[ocr\]\s+▶/.test(line)) p.toolCalls = (p.toolCalls ?? 0) + 1;
    if (/^\s*\[ocr\]\s+✘/.test(line)) p.toolFailures = (p.toolFailures ?? 0) + 1;
    if (/\bplan(?:ning)? phase\b/i.test(line) && !/skipping/i.test(line)) p.phase = "planning";
    // Only OCR's own lines: the JSON it prints when it fails has a "summary" key too.
    else if (/^\s*\[ocr\].*\bsummar/i.test(line)) p.phase = "summarising";
    else if (/group "|▶|✔/.test(line)) p.phase = "reviewing";
    return p;
}
