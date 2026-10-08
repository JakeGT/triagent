#!/usr/bin/env node
// A stand-in for Open Code Review's `ocr` binary, for tests. It writes a report on stdout (a finding for
// each file the change touches, or every file for a scan) and progress on stderr, like the real one.
//
// It gets only the environment the runner allows, so tests choose its behaviour through the model name
// (OCR_LLM_MODEL): "fake/fail", "fake/partial", "fake/empty", "fake/sleep-5", "fake/orphan" (leaves a process behind
// in its group), and for reviews with several models "wordy" (the same findings, put another way, two lines
// lower) and "extra" (one more finding, at line 40 of the first file). It also prints what tests check: its arguments, which environment variables it got,
// the model key (the server must redact it), its user config (~/.opencodereview/config.json, which the
// runner writes for Amazon Bedrock, taking the model from it as OCR does), and the review rules it found. Like the real one, it leaves
// out files the root .gitignore matches and files git calls binary, and reads rule files rule.json names.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
    console.log("ocr version 1.12.12 (fake)");
    process.exit(0);
}
const userConfigFile = `${process.env.HOME}/.opencodereview/config.json`;
const userConfig = existsSync(userConfigFile) ? readFileSync(userConfigFile, "utf8") : null;
const configured = userConfig ? (JSON.parse(userConfig) as { provider: string; providers: Record<string, { model?: string }> }) : null;
const model = process.env.OCR_LLM_MODEL ?? (configured ? (configured.providers[configured.provider]?.model ?? "") : "");
const say = (line: string) => process.stderr.write(`${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

say(`[fake-ocr] args: ${args.join(" ")}`);
say(`[fake-ocr] env: ${Object.keys(process.env).sort().join(",")}`);
say(`[fake-ocr] key: ${process.env.OCR_LLM_TOKEN ?? process.env.AWS_SECRET_ACCESS_KEY ?? "none"}`);
if (process.env.AWS_ACCESS_KEY_ID) say(`[fake-ocr] aws access key id: ${process.env.AWS_ACCESS_KEY_ID}`);
say(`[fake-ocr] config: ${userConfig ? JSON.stringify(JSON.parse(userConfig)) : "none"}`);
const rulesFile = ".opencodereview/rule.json";
const rules = existsSync(rulesFile) ? readFileSync(rulesFile, "utf8").trim() : "none";
say(`[fake-ocr] rules: ${rules.replace(/\s+/g, " ")}`);

// Rule entries can name a file of instructions, which OCR reads from the repository.
try {
    for (const r of (JSON.parse(rules) as { rules?: { rule?: string }[] }).rules ?? [])
        if (r.rule && /^\S+\.(md|txt|markdown)$/.test(r.rule))
            say(`[fake-ocr] rule file ${r.rule}: ${existsSync(r.rule) ? readFileSync(r.rule, "utf8").trim() : "missing"}`);
} catch {
    // no rules
}

// git with the environment OCR was given (GIT_ATTR_SOURCE included), as OCR runs it.
const gitOut = (a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();
let files: string[];
if (args[0] === "review") {
    const from = args[args.indexOf("--from") + 1] as string;
    const to = args[args.indexOf("--to") + 1] as string;
    files = [];
    // Like OCR, files git calls binary aren't reviewed.
    for (const line of gitOut(["diff", "--numstat", "--no-renames", from, to]).split("\n").filter(Boolean)) {
        const [added, , file] = line.split("\t") as [string, string, string];
        if (added === "-") say(`[ocr] Skipping ${file} — binary file`);
        else files.push(file);
    }
} else files = gitOut(["ls-files"]).split("\n").filter(Boolean);
// Like OCR, files the root .gitignore (read from the worktree) matches are left out.
const ignores = existsSync(".gitignore")
    ? readFileSync(".gitignore", "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
    : [];
const ignored = (f: string) =>
    ignores.some((pattern) =>
        new RegExp(`^(?:.*/)?${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}(?:/.*)?$`).test(f),
    );
files = files.filter((f) => !ignored(f));
// Honour the rules' simple exclusions, so tests can tell whose rules were used.
let excluded: string[] = [];
try {
    excluded = (JSON.parse(rules) as { exclude?: string[] }).exclude ?? [];
} catch {
    // none
}
files = files.filter((f) => !f.startsWith(".opencodereview/") && !excluded.some((x) => f.startsWith(x.replace(/\*+$/, ""))));

say(`[ocr] ${files.length} file(s) changed, reviewing ${files.length} in ${process.cwd()}`);
say('[ocr] Planning phase for group "src"');

if (model.includes("orphan")) {
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    child.unref();
    say(`[fake-ocr] orphan: ${child.pid}`);
}
const m = /sleep-(\d+)/.exec(model);
if (m) {
    // Like the real one, stopping it (SIGTERM) ends the review gracefully, writing what it used to stderr.
    process.on("SIGTERM", () => {
        process.stderr.write(
            `${JSON.stringify({ status: "failed", summary: { total_tokens: 4321, input_tokens: 4000, output_tokens: 321 } }, null, 2)}\n`,
        );
        process.exit(1);
    });
    const until = Date.now() + Number(m[1]) * 1000;
    let n = 0;
    while (Date.now() < until) {
        say(`[ocr]   ▶ file_read path=${files[n % Math.max(files.length, 1)] ?? "x"}`);
        say(`[ocr]   ✔ file_read (${n}ms)`);
        say(`[ocr] Round 1/2 for group "src"`);
        n++;
        await sleep(100);
    }
}
if (model.includes("fail")) {
    say('[ocr] Subtask error for group "src": LLM completion error: POST "https://llm.test/chat/completions": 503 Service Unavailable');
    process.stdout.write(
        JSON.stringify({ status: "failed", comments: null, summary: { total_tokens: 40, input_tokens: 40, output_tokens: 0 } }),
    );
    say("Error: review failed: all 1 file review(s) failed — check your LLM configuration and API key");
    process.exit(1);
}
for (const f of files) {
    say(`[ocr] Reviewing group "${f.split("/")[0]}"`);
    say(`[ocr]   ▶ file_read path=${f}`);
    say("[ocr]   ✔ file_read (2ms)");
}
say("[ocr] Writing the summary");

const content = (f: string) => {
    try {
        return readFileSync(f, "utf8");
    } catch {
        return "";
    }
};
const report = {
    status: "completed",
    session_id: "fake-session",
    comments: [
        ...files.map((path) => ({
            path,
            content: model.includes("wordy")
                ? `Looking closely at ${path}, the fake reviewer sees a problem here.`
                : `A problem found in ${path} by the fake reviewer.`,
            severity: content(path).includes("CRITICAL") ? "critical" : model.includes("wordy") ? "medium" : "high",
            category: "bug",
            start_line: model.includes("wordy") ? 3 : 1,
            end_line: model.includes("wordy") ? 3 : 1,
        })),
        ...(model.includes("extra") && files[0]
            ? [{ path: files[0], content: `Only ${model} noticed this.`, severity: "low", category: "style", start_line: 40, end_line: 40 }]
            : []),
    ],
    project_summary: args[0] === "scan" ? "## Top issues\n\n- **Everything**: it's all fake.\n" : "",
    summary: { total_tokens: 1500, input_tokens: 1200, output_tokens: 300, cache_read_tokens: 100, files_reviewed: files.length },
    manifest: { execution: { ocr_version: "v1.12.12-fake" } },
    llm: { model, provider: configured?.provider ?? process.env.OCR_LLM_PROTOCOL ?? "openai" },
    tool_calls: { total: files.length, failure: 0, by_tool: { file_read: files.length } },
    groups: [{ name: "src" }],
    warnings: model.includes("partial")
        ? [
              {
                  type: "review_round_failed",
                  file: files.slice(-2).join(","),
                  message: "round 2: LLM completion error: context deadline exceeded",
              },
          ]
        : [],
};
// Like the real one, nothing found is written as "comments": null.
process.stdout.write(JSON.stringify(model.includes("empty") ? { ...report, comments: null } : report));
