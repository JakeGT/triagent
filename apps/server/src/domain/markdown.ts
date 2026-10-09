// Markdown versions of what the API returns, for agents (MCP tool results, `.md` endpoints) and copy/paste.

import type { BranchView, IssueDetail } from "./branch.ts";
import { describeFilters, type IssueFilters } from "./filters.ts";

const LANGS: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    mjs: "js",
    cjs: "js",
    jsx: "jsx",
    css: "css",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    sh: "sh",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    rb: "ruby",
    php: "php",
    cs: "csharp",
    sql: "sql",
    md: "markdown",
    toml: "toml",
    html: "html",
};

export function langOf(path: string): string {
    if (path.endsWith("Dockerfile")) return "dockerfile";
    return LANGS[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "";
}

/** A code block whose fence is longer than any run of backticks inside it. */
export function fence(code: string, lang: string): string {
    // A loop, not Math.max(...runs): code with very many backtick runs would exceed the argument limit.
    let longest = 0;
    for (const m of code.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
    const ticks = "`".repeat(Math.max(3, longest + 1));
    return `${ticks}${lang}\n${code}\n${ticks}`;
}

/** Text that must stay on its line (names, titles): a line break in it could start a heading or list item of its own. */
const oneLine = (s: string) => s.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ");

/** A path inside `inline code`: one line, and no backtick to end the code span early. */
const inCode = (s: string) => oneLine(s).replace(/`/g, "'");

function notesMarkdown(notes: IssueDetail["notes"]): string[] {
    if (!notes.length) return [];
    return [
        "",
        "**Notes:**",
        "",
        ...notes.map((n) => `- [${n.id}] ${n.at} — ${oneLine(n.by)}${n.editedAt ? " (edited)" : ""}: ${oneLine(n.text)}`),
    ];
}

export function issueMarkdown(v: IssueDetail, branch: string): string {
    const loc = v.startLine
        ? `${inCode(v.path)}:${v.startLine}${v.endLine && v.endLine !== v.startLine ? `-${v.endLine}` : ""}`
        : inCode(v.path);
    const facts = [
        `- **Severity:** ${v.severity}${v.reviewerSeverity ? ` (changed from the reviewer's ${v.reviewerSeverity})` : ""}`,
        `- **Category:** ${v.category}${v.reviewerCategory ? ` (changed from the reviewer's ${v.reviewerCategory})` : ""}`,
        `- **Status:** ${v.status}${v.assignee ? ` (assigned to ${oneLine(v.assignee)})` : ""}`,
        `- **Location:** \`${loc}\`${v.sourceUrl ? ` ([view source](${v.sourceUrl}))` : ""}`,
        `- **Branch:** ${branch}`,
        `- **Revision:** ${v.rev}`,
    ];
    if (v.foundBy) facts.push(`- **Found by:** ${v.foundBy.map(oneLine).join(", ")}`);
    if (v.duplicateOf) facts.push(`- **Duplicate of:** ${v.duplicateOf}`);
    if (v.needsDiscussion) facts.push("- **Needs discussion:** yes (agree an approach before fixing)");
    const out = [`## ${v.id}: ${oneLine(v.title)}`, "", ...facts, "", v.content];
    const lang = langOf(v.path);
    if (v.existingCode) out.push("", "**Existing code:**", "", fence(v.existingCode, lang));
    if (v.suggestionCode) out.push("", "**Suggested change:**", "", fence(v.suggestionCode, lang));
    for (const o of v.alsoFound) {
        const where = o.startLine ? ` at line ${o.startLine}${o.endLine && o.endLine !== o.startLine ? `-${o.endLine}` : ""}` : "";
        const rated = [o.severity, o.category].filter(Boolean).join("/");
        out.push("", `**${oneLine(o.model)} also found it**${rated ? ` (${rated})` : ""}${where}:`, "", o.content);
    }
    if (v.duplicates.length) out.push("", `**Duplicates of this issue:** ${v.duplicates.map((d) => d.id).join(", ")}`);
    out.push(...notesMarkdown(v.notes));
    if (v.tasks.length)
        out.push("", `**Related tasks:** ${v.tasks.map((t) => `${t.id} (${oneLine(t.title).replace(/`/g, "")})`).join("; ")}`);
    return out.join("\n");
}

export function issuesMarkdown(
    view: BranchView,
    result: { total: number; offset: number; items: IssueDetail[] },
    filters: IssueFilters,
): string {
    const lines = [
        "# Code review issues",
        "",
        `${result.total} matching issue(s)${oneLine(describeFilters(filters))} on branch ${view.branch}. Showing ${result.items.length} from offset ${result.offset}.`,
        "",
    ];
    for (const item of result.items) lines.push(issueMarkdown(item, view.branch), "");
    if (result.offset + result.items.length < result.total)
        lines.push(`_More results: repeat with offset=${result.offset + result.items.length}._`);
    return lines.join("\n");
}

export function taskMarkdown(t: ReturnType<BranchView["getTask"]>): string {
    const out = [
        `## ${t.id}: ${oneLine(t.title).replace(/`/g, "")}`,
        "",
        `- **Section:** ${oneLine(t.section)}`,
        `- **Status:** ${t.status}${t.assignee ? ` (assigned to ${oneLine(t.assignee)})` : ""}`,
        `- **Linked issues:** ${t.issuesDone}/${t.issueCount} resolved or won't fix`,
        `- **Revision:** ${t.rev}`,
        "",
        t.markdown,
    ];
    if (t.issues.length) {
        out.push("", "**Linked issues:**", "");
        for (const x of t.issues)
            out.push(
                `- ${x.id} [${x.severity}/${x.category}/${x.status}] \`${inCode(x.path)}${x.startLine ? `:${x.startLine}` : ""}\` — ${oneLine(x.title)}`,
            );
    }
    out.push(...notesMarkdown(t.notes));
    return out.join("\n");
}

export function overviewMarkdown(view: BranchView, heading: string): string {
    if (!view.review.meta.loaded)
        return `# Code review overview (${oneLine(heading)})\n\nNo Open Code Review report has been uploaded for this branch yet.`;
    const o = view.overview([]);
    const m = view.review.meta;
    const llm = m.llm && typeof m.llm === "object" && "model" in m.llm ? String((m.llm as { model: unknown }).model) : "an unknown model";
    return [
        `# Code review overview (${oneLine(heading)})`,
        "",
        `Open Code Review report (${oneLine(String(m.status ?? "unknown status"))}) using ${oneLine(llm)}.`,
        `${o.totals.issues} issues across ${o.totals.files} files; ${o.totals.done} done, ${o.totals.remaining} remaining.`,
        "",
        "| Severity | Total | Open | In progress | Resolved | Won't fix |",
        "|---|---|---|---|---|---|",
        ...o.bySeverity.map((s) => `| ${s.severity} | ${s.total} | ${s.open} | ${s.in_progress} | ${s.resolved} | ${s.wont_fix} |`),
        "",
        "## Hotspot files (open issues, weighted by severity)",
        "",
        ...o.hotspots.map(
            (f) => `- \`${inCode(f.path)}\` — ${f.open} open of ${f.total} (critical ${f.severity.critical}, high ${f.severity.high})`,
        ),
        "",
        `## ${oneLine(o.themesTitle ?? "Themes")}`,
        "",
        ...(o.themes.length
            ? o.themes.map((t) => `- ${t.id} [${t.status}] ${oneLine(t.title)} — ${t.issuesDone}/${t.issueCount} linked issues done`)
            : ["_None: the reviewer wrote no summary for this report._"]),
    ].join("\n");
}
