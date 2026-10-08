// Progress, read from Open Code Review's human-readable stderr. OCR doesn't print an overall "n of m",
// so this reports what it does say, for example:
//
//   [ocr] 12 file(s) changed, reviewing 10 in /path
//   [ocr] Skipping plan phase for group "src/db" (3 file(s), …)
//   [ocr] Round 2/2 added no new findings for group "src/db"; stopping early
//   [ocr] Round 2 failed for group "src/db": LLM completion error: … (keeping earlier findings)
//   [ocr]   ▶ file_read path=…      [ocr]   ✔ file_read (4ms)      [ocr]   ✘ file_read failed: …
//
// Groups are reviewed in parallel, so "current" and "round" are whichever group spoke last.

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
}

/** Progress after one more line of OCR's stderr. `seen` collects the group names met so far. */
export function readProgress(before: Progress, line: string, seen: Set<string>): Progress {
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
    const failed = /\bRound (\d+) failed for group/.exec(line);
    if (round) p.round = `${round[1]}/${round[2]}`;
    else if (failed) {
        p.round = `${failed[1]}${p.round?.includes("/") ? p.round.slice(p.round.indexOf("/")) : ""}`;
        p.roundsFailed = (p.roundsFailed ?? 0) + 1;
    }
    if (/^\s*\[ocr\]\s+▶/.test(line)) p.toolCalls = (p.toolCalls ?? 0) + 1;
    if (/^\s*\[ocr\]\s+✘/.test(line)) p.toolFailures = (p.toolFailures ?? 0) + 1;
    if (/\bplan(?:ning)? phase\b/i.test(line) && !/skipping/i.test(line)) p.phase = "planning";
    // Only OCR's own lines: the JSON it prints when it fails has a "summary" key too.
    else if (/^\s*\[ocr\].*\bsummar/i.test(line)) p.phase = "summarising";
    else if (/group "|▶|✔/.test(line)) p.phase = "reviewing";
    return p;
}
