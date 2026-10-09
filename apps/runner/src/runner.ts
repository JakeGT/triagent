// The runner: asks the server for work, runs Open Code Review on it, and reports back. It has no
// database and keeps nothing between jobs but bare git mirrors; each job's credentials live only in
// memory, for that job.
//
// OCR gets an explicit environment and nothing else: a throwaway HOME (OCR reads its user config, with
// any MCP servers and setup commands, and its global rules from ~/.opencodereview, so there are none
// but what the runner writes there for Amazon Bedrock: a provider, region and model), the model's
// settings, and git settings that keep hooks off. Never telemetry settings, nor anything of Anthropic's.

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { modelSecrets, type RunnerModel } from "../../../packages/shared/src/model.ts";
import { redactDeep, redactor } from "../../../packages/shared/src/redact.ts";
import { type ClaimedJob, type FinishPart, isLost, type RunnerIdentity, ServerClient, ServerError } from "./client.ts";
import type { RunnerConfig } from "./config.ts";
import { Git, gitEnv, mirrorPath } from "./git.ts";
import { start } from "./process.ts";
import { type Progress, readProgress } from "./progress.ts";

const FLUSH_MS = 1000;
const HEARTBEAT_MS = 10_000;
const MAX_BATCH = 500;
const VERSION = "0.1.0";

/**
 * The model's part of OCR's environment, by protocol. OCR takes a URL, key, model and protocol from
 * OCR_LLM_* (its internal/llm/resolver.go, tryOCREnv); OCR_LLM_PROTOCOL wins over OCR_USE_ANTHROPIC,
 * which is set to agree with it anyway. Its Anthropic client sends the key as a bearer token unless told
 * otherwise; Anthropic's API takes it as x-api-key. Bedrock can't be given through OCR_LLM_* (OCR refuses
 * it there): it's a provider in the config file (ocrConfig), signed with AWS credentials from the
 * environment, and never from the instance's own (no metadata service).
 */
function modelEnv(model: RunnerModel): Record<string, string> {
    if (model.protocol === "anthropic-bedrock") {
        if (!model.aws) throw new Error("Amazon Bedrock needs an AWS region and access key.");
        return {
            AWS_ACCESS_KEY_ID: model.aws.accessKeyId,
            AWS_SECRET_ACCESS_KEY: model.apiKey,
            AWS_REGION: model.aws.region,
            AWS_EC2_METADATA_DISABLED: "true",
        };
    }
    return {
        OCR_LLM_URL: model.url,
        OCR_LLM_TOKEN: model.apiKey,
        OCR_LLM_MODEL: model.model,
        OCR_LLM_PROTOCOL: model.protocol,
        OCR_USE_ANTHROPIC: model.protocol === "anthropic" ? "true" : "false",
        ...(model.protocol === "anthropic" ? { OCR_LLM_AUTH_HEADER: "x-api-key" } : {}),
    };
}

/**
 * OCR's user config (~/.opencodereview/config.json in the job's own HOME), for what its environment
 * variables can't say, or null when they can. It holds only the provider, region and model: no keys (they're
 * in the environment), and never MCP servers, setup commands or a key command (api_key_cmd).
 */
export function ocrConfig(job: Pick<ClaimedJob, "model">): Record<string, unknown> | null {
    const m = job.model;
    if (m.protocol !== "anthropic-bedrock") return null;
    return { provider: "bedrock", providers: { bedrock: { aws_region: m.aws?.region, model: m.model } } };
}

/** The environment OCR runs with: built from scratch, never copied from the runner's own. */
export function ocrEnv(
    config: Pick<RunnerConfig, "path" | "llmTimeout">,
    home: string,
    job: Pick<ClaimedJob, "model">,
    attrSource: string | null = null,
): Record<string, string> {
    const git = gitEnv({ gitBin: "git", path: config.path, home }, [["protocol.allow", "never"]]);
    return {
        PATH: config.path,
        HOME: home,
        TMPDIR: path.join(home, "tmp"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        LANG: "C.UTF-8",
        TZ: "UTC",
        OCR_NO_UPDATE: "1",
        ...modelEnv(job.model),
        ...(config.llmTimeout ? { OCR_LLM_TIMEOUT: config.llmTimeout } : {}),
        ...Object.fromEntries(Object.entries(git).filter(([k]) => k.startsWith("GIT_"))),
        // For changes under review, every git command OCR runs reads .gitattributes from the base commit:
        // the change's own could mark its files binary (`-diff`), and OCR skips binary files.
        ...(attrSource ? { GIT_ATTR_SOURCE: attrSource } : {}),
    };
}

/** Write OCR's config into the job's HOME, readable by its owner alone, if the model needs one. */
export function writeOcrConfig(home: string, job: Pick<ClaimedJob, "model">): void {
    const config = ocrConfig(job);
    if (!config) return;
    mkdirSync(path.join(home, ".opencodereview"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(home, ".opencodereview", "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Why OCR failed, from the end of its stderr: its closing "Error:" line, and the first error from the
 * model's provider if there was one (often the real reason: a refused key, an overloaded provider).
 */
export function failureReason(stderr: string, exit: number | string | null): string {
    const lines = stderr
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    const error = lines
        .filter((l) => l.startsWith("Error:"))
        .at(-1)
        ?.replace(/^Error:\s*/, "");
    const provider = lines.find((l) => /LLM completion error|plan request|grouping LLM call/.test(l))?.replace(/^\[ocr\]\s*/, "");
    const why = [error, provider ? `the first model error was: ${provider}` : null].filter(Boolean).join("; ");
    return `Open Code Review failed (exit ${exit}): ${(why || lines.slice(-3).join(" ") || "no message").slice(0, 900)}`;
}

export function ocrArgs(job: Pick<ClaimedJob, "kind" | "maxTokensBudget">, base: string | null, head: string): string[] {
    const args = job.kind === "full" ? ["scan"] : ["review", "--from", base as string, "--to", head];
    args.push("--format", "json", "--audience", "human", "--color", "never");
    if (job.maxTokensBudget) args.push("--max-tokens-budget", String(job.maxTokensBudget));
    return args;
}

class Stop extends Error {}

const minutes = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/** The models a job reviews with, in order: those it lists, or its one model. */
export function modelsOf(job: Pick<ClaimedJob, "model" | "models">): (RunnerModel & { label: string })[] {
    return job.models?.length ? job.models : [{ ...job.model, label: job.model.model }];
}

/**
 * How a job with several models ended, from how each went: done if any finished (the server merges what
 * they found), cancelled if it was, failed otherwise, saying why each failed.
 */
export function overall(
    parts: readonly FinishPart[],
    labels: readonly string[],
    cancelled: boolean,
): Parameters<ServerClient["finish"]>[1] {
    if (cancelled) return { status: "cancelled", parts: [...parts] };
    if (parts.some((p) => p.status === "done")) return { status: "done", parts: [...parts] };
    const why = parts.map((p, i) => `${labels[i]}: ${p.error ?? "failed"}`).join(" ");
    return { status: "failed", parts: [...parts], error: `No model finished. ${why}`.slice(0, 9000) };
}

/** One job in progress: its log buffer, heartbeat and the OCR process. */
export class JobRun {
    private readonly job: Pick<ClaimedJob, "id" | "git" | "model" | "models">;
    private readonly server: Pick<ServerClient, "events" | "heartbeat">;
    private readonly redact: (line: string) => string;
    private buffer: { at: string; line: string }[] = [];
    private progress: Progress = {};
    private progressDirty = false;
    private readonly groups = new Set<string>();
    /** Tokens earlier models used, in a job with several. */
    private tokenBase = 0;
    private stopOcr: (() => void) | null = null;
    cancelled = false;
    lost = false;
    private readonly stopping = new AbortController();
    private readonly timers: ReturnType<typeof setInterval>[] = [];
    private flushing: Promise<void> = Promise.resolve();

    constructor(job: Pick<ClaimedJob, "id" | "git" | "model" | "models">, server: Pick<ServerClient, "events" | "heartbeat">) {
        this.job = job;
        this.server = server;
        // The job's own secrets come out before anything leaves the runner (the server redacts again).
        this.redact = redactor([job.git.token, ...modelsOf(job).flatMap((m) => modelSecrets(m))]);
    }

    /** Lines waiting to be sent. */
    get pending(): number {
        return this.buffer.length;
    }

    say(line: string): void {
        this.log(`[triagent] ${line}`);
    }

    redactLine(line: string): string {
        return this.redact(line);
    }

    /** OCR's report, every string in it redacted (the server does it again). */
    redactReport(report: unknown): unknown {
        return redactDeep(report, this.redact);
    }

    log(line: string): void {
        this.buffer.push({ at: new Date().toISOString(), line: this.redact(line).slice(0, 4000) });
        if (this.buffer.length >= MAX_BATCH) void this.flush();
    }

    get currentProgress(): Progress {
        return this.progress;
    }

    setProgress(p: Progress): void {
        this.progress = p;
        this.progressDirty = true;
    }

    ocrLine(line: string): void {
        this.log(line);
        this.setProgress(readProgress(this.progress, line, this.groups, this.tokenBase));
    }

    /** The next model starts (a job with several): its progress starts afresh, its tokens add to the others'. */
    nextModel(model: string): void {
        this.tokenBase = this.progress.tokens ?? this.tokenBase;
        this.groups.clear();
        this.setProgress({ phase: "starting", model, tokens: this.tokenBase });
    }

    /** Tokens OCR has said the current model used. */
    get modelTokens(): number {
        return Math.max(0, (this.progress.tokens ?? 0) - this.tokenBase);
    }

    /** Send buffered lines and progress; a cancellation or a lost job stops OCR. */
    flush(): Promise<void> {
        this.flushing = this.flushing.then(async () => {
            if (this.lost || (!this.buffer.length && !this.progressDirty)) return;
            const lines = this.buffer.splice(0, MAX_BATCH);
            const progress = this.progressDirty
                ? Object.fromEntries(Object.entries(this.progress).map(([k, v]) => [k, typeof v === "string" ? this.redact(v) : v]))
                : null;
            this.progressDirty = false;
            try {
                const r = await this.server.events(this.job.id, lines, progress);
                if (r.cancel) this.cancel();
            } catch (err) {
                if (isLost(err)) this.lose();
                else if (err instanceof ServerError && err.status >= 400 && err.status < 500)
                    // Refused, not unreachable: sending it again would be refused again, and hold up every line after it.
                    console.error(`The server refused ${lines.length} log line(s) of ${this.job.id} (${err.message}); dropped them.`);
                else {
                    // The server is briefly away: keep the lines for the next try.
                    this.buffer.unshift(...lines);
                    this.buffer.splice(0, Math.max(0, this.buffer.length - 20_000));
                    if (progress) this.progressDirty = true;
                }
            }
        });
        return this.flushing;
    }

    private async heartbeat(): Promise<void> {
        if (this.lost) return;
        try {
            const r = await this.server.heartbeat(this.job.id);
            if (r.cancel) this.cancel();
        } catch (err) {
            if (isLost(err)) this.lose();
        }
    }

    /** Aborted when the job is cancelled or lost: stops git (fetching, adding the worktree) as well as OCR. */
    get signal(): AbortSignal {
        return this.stopping.signal;
    }

    cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        this.stopping.abort();
        this.stopOcr?.();
    }

    private lose(): void {
        this.lost = true;
        this.stopping.abort();
        this.stopOcr?.();
    }

    check(): void {
        if (this.lost) throw new Stop("This job is no longer ours.");
        if (this.cancelled) throw new Stop("Cancelled.");
    }

    begin(): void {
        this.timers.push(
            setInterval(() => void this.flush(), FLUSH_MS),
            setInterval(() => void this.heartbeat(), HEARTBEAT_MS),
        );
        for (const t of this.timers) t.unref();
    }

    async end(): Promise<void> {
        for (const t of this.timers) clearInterval(t);
        // Everything left, a batch at a time, until it's sent or the server stops taking it.
        for (let i = 0; i < 100; i++) {
            const before = this.buffer.length;
            await this.flush();
            if (this.lost || (!this.buffer.length && !this.progressDirty) || this.buffer.length >= before) break;
        }
    }

    attach(stop: () => void): void {
        this.stopOcr = stop;
        if (this.cancelled || this.lost) stop();
    }
}

export class Runner {
    private readonly config: RunnerConfig;
    private readonly server: ServerClient;
    private readonly git: Git;
    readonly id = `runner-${randomBytes(9).toString("base64url")}`;
    private readonly active = new Map<string, JobRun>();
    private stopping = false;
    /** Aborted by stop(), to end the poll loop's wait. */
    private readonly wake = new AbortController();
    private loop: Promise<void> | null = null;
    /** Called when a job ends (tests wait on it). */
    onJobEnd: (jobId: string) => void = () => {};

    constructor(config: RunnerConfig) {
        this.config = config;
        this.server = new ServerClient(config.serverUrl, config.secret, () => this.identity());
        this.git = new Git({ gitBin: config.gitBin, path: config.path, home: path.join(config.workDir, "git-home") });
        mkdirSync(path.join(config.workDir, "git-home"), { recursive: true, mode: 0o700 });
        mkdirSync(config.cacheDir, { recursive: true, mode: 0o700 });
    }

    identity(): RunnerIdentity {
        return { id: this.id, name: this.config.name, version: VERSION, slots: Math.max(0, this.config.concurrency - this.active.size) };
    }

    get running(): number {
        return this.active.size;
    }

    start(): void {
        this.loop ??= this.poll();
    }

    /** Stop asking for work; stop running reviews and tell the server why. */
    async stop(): Promise<void> {
        this.stopping = true;
        this.wake.abort();
        for (const run of this.active.values()) run.cancel();
        while (this.active.size) await sleep(50);
        await this.loop;
    }

    private async poll(): Promise<void> {
        let failures = 0;
        while (!this.stopping) {
            let claimed = false;
            if (this.active.size < this.config.concurrency) {
                try {
                    const job = await this.server.claim();
                    failures = 0;
                    if (job) {
                        claimed = true;
                        void this.execute(job).catch((err) => console.error(`Running ${job.id} failed: ${(err as Error).message}`));
                    }
                } catch (err) {
                    failures++;
                    if (failures === 1 || failures % 20 === 0)
                        console.error(`Asking the server for work failed: ${(err as Error).message}`);
                }
            }
            if (!claimed)
                await sleep(Math.min(this.config.pollMs * 2 ** Math.min(failures, 4), 60_000), undefined, {
                    signal: this.wake.signal,
                }).catch(() => {});
        }
    }

    /** Run one job from start to finish, and report how it went. */
    async execute(job: ClaimedJob): Promise<void> {
        const run = new JobRun(job, this.server);
        this.active.set(job.id, run);
        run.begin();
        try {
            await this.runJob(job, run);
        } finally {
            this.active.delete(job.id);
            this.onJobEnd(job.id);
        }
    }

    private async runJob(job: ClaimedJob, run: JobRun): Promise<void> {
        let work: string | null = null;
        let tree = "";
        const mirror = mirrorPath(this.config.cacheDir, job.repository.cloneUrl);
        let fetched: { head: string; base: string | null } | null = null;
        let outcome: Parameters<ServerClient["finish"]>[1];
        let ocrStarted = false;
        try {
            work = mkdtempSync(path.join(this.config.workDir, "job-"));
            tree = path.join(work, "tree");
            run.setProgress({ phase: "fetching" });
            run.say(
                `Fetching ${job.kind === "pr" ? `pull request #${job.pr?.number}` : job.gitRef}${job.baseRef ? ` and ${job.baseRef}` : ""} from ${job.repository.fullName}…`,
            );
            fetched = await this.git.fetch(
                mirror,
                {
                    kind: job.kind,
                    cloneUrl: job.repository.cloneUrl,
                    username: job.git.username,
                    token: job.git.token,
                    pr: job.pr?.number ?? null,
                    gitRef: job.gitRef,
                    baseRef: job.baseRef,
                },
                run.signal,
            );
            run.check();
            if (job.kind === "pr" && job.headSha && fetched.head !== job.headSha)
                run.say(`The pull request moved on to ${fetched.head.slice(0, 7)} since it was queued; reviewing that.`);
            if (fetched.base && fetched.base === fetched.head)
                throw new Error(
                    `There are no changes to review: ${job.gitRef ?? "the pull request"} has nothing that isn't on ${job.baseRef}.`,
                );
            await this.git.addWorktree(mirror, tree, fetched.head, fetched.base, run.signal);
            run.check();
            if (fetched.base) {
                const rules = await this.git.useBaseReviewRules(mirror, tree, fetched.base);
                if (rules !== "unchanged")
                    run.say(
                        rules === "replaced"
                            ? `Using ${job.baseRef}'s review rules (.opencodereview/), not the ones in the change under review.`
                            : "Ignoring the .opencodereview/ the change adds: changes under review can't set their own review rules.",
                    );
                const restored = (what: string, changed: { path: string; now: "base" | "none" }[]) => {
                    if (changed.length)
                        run.say(
                            `Using ${job.baseRef}'s ${what}, not the change's: ${changed
                                .slice(0, 10)
                                .map((c) => `${c.path}${c.now === "none" ? ` (none on ${job.baseRef})` : ""}`)
                                .join(", ")}${changed.length > 10 ? ` and ${changed.length - 10} more` : ""}.`,
                        );
                };
                restored(".gitignore files", await this.git.useBaseIgnoreFiles(mirror, tree, fetched.base, fetched.head));
                restored(
                    "rule files named in its .opencodereview/rule.json",
                    (await this.git.useBaseRuleFiles(mirror, tree, fetched.base)).filter((c) => c.path !== ".opencodereview/rule.json"),
                );
                run.say(`Reading .gitattributes from ${job.baseRef} (${fetched.base.slice(0, 7)}), not from the change.`);
            }
            run.check();
            const args = ocrArgs(job, fetched.base, fetched.head);
            const models = modelsOf(job);
            const parts: FinishPart[] = [];
            const limit = job.timeoutMinutes ?? null;
            const stall = job.stallMinutes ?? null;
            /** A model's review was stopped at the time limit, or as stalled. */
            let stopped = false;
            for (const [i, model] of models.entries()) {
                run.check();
                const one = { ...job, model };
                const several = models.length > 1;
                const own = path.join(work, `home-${i}`);
                mkdirSync(path.join(own, "tmp"), { recursive: true, mode: 0o700 });
                if (several) {
                    run.say(`Model ${i + 1} of ${models.length}: ${model.label}.`);
                    run.nextModel(`${model.label} (${i + 1} of ${models.length})`);
                } else run.setProgress({ phase: "starting" });
                run.say(
                    `Running ocr ${args.join(" ")} with ${model.model} via ${model.provider}. ${limit ? `Time limit: ${minutes(limit)}.` : "No time limit."}${stall ? ` Stopped as stalled if it prints nothing for ${minutes(stall)}.` : ""}`,
                );
                writeOcrConfig(own, one);
                ocrStarted = true;
                const began = Date.now();
                const ocr = start(this.config.ocrBin, args, {
                    cwd: tree,
                    env: ocrEnv(this.config, own, one, fetched.base),
                    ...(limit ? { timeoutMs: limit * 60_000 } : {}),
                    ...(stall ? { stallMs: stall * 60_000 } : {}),
                    onLine: (line) => run.ocrLine(line),
                });
                run.attach(ocr.stop);
                const exit = await ocr.done;
                let report: unknown = null;
                try {
                    report = exit.stdout.trim() ? run.redactReport(JSON.parse(exit.stdout)) : null;
                } catch {
                    report = null;
                }
                if (run.lost) throw new Stop("This job is no longer ours.");
                const timing = { tokens: run.modelTokens || null, seconds: Math.round((Date.now() - began) / 1000) };
                let part: FinishPart;
                if (run.cancelled) part = { status: "cancelled", ...(report ? { report } : {}) };
                else if (exit.timedOut) {
                    stopped = true;
                    part = {
                        status: "failed",
                        error: `Stopped after ${minutes(limit as number)}, the project's time limit for this kind of review. An admin can raise it in the project's Automation settings.`,
                    };
                } else if (exit.stalled) {
                    stopped = true;
                    part = {
                        status: "failed",
                        error: `Stalled: Open Code Review printed nothing for ${minutes(stall as number)}, so it was stopped (the model may have stopped answering). An admin can change how long it waits in the project's Automation settings.`,
                    };
                } else if (exit.code !== 0)
                    part = {
                        status: "failed",
                        error: run.redactLine(failureReason(exit.stderr, exit.code ?? exit.signal)),
                        ...(report ? { report } : {}),
                    };
                else if (!report || typeof report !== "object")
                    part = { status: "failed", error: "Open Code Review didn't return a JSON report." };
                else part = { status: "done", report };
                if (several && part.status === "failed") run.say(`${model.label} failed: ${part.error}`);
                parts.push({ ...part, ...timing });
                if (run.cancelled) break;
            }
            if (models.length > 1) {
                if (!run.cancelled) {
                    run.setProgress({ ...run.currentProgress, phase: "uploading" });
                    run.say("Reviews finished; sending each model's findings to Triagent to merge…");
                }
                outcome = overall(
                    parts,
                    models.map((m) => m.label),
                    run.cancelled,
                );
            } else {
                // One model: as it always was.
                const [part] = parts as [FinishPart];
                if (stopped && part.status === "failed") throw new Error(part.error as string);
                if (part.status === "done") {
                    run.setProgress({ ...run.currentProgress, phase: "uploading" });
                    run.say("Review finished; sending the findings to Triagent…");
                }
                const { tokens: _t, seconds: _s, ...rest } = part;
                outcome = rest;
            }
        } catch (err) {
            if (err instanceof Stop) outcome = { status: run.cancelled ? "cancelled" : "failed", error: err.message };
            else {
                const message = run.redactLine((err as Error).message);
                run.say(message);
                outcome = { status: run.cancelled ? "cancelled" : "failed", error: message };
            }
        } finally {
            // So the server doesn't charge an estimate for a review that never reached the model.
            if (!ocrStarted) run.setProgress({ ...run.currentProgress, tokens: 0 });
            if (work) {
                await this.git.removeWorktree(mirror, tree).catch(() => {});
                try {
                    rmSync(work, { recursive: true, force: true });
                } catch (err) {
                    console.error(`Couldn't remove ${work}: ${(err as Error).message}`);
                }
            }
            await run.end();
        }
        if (!run.lost) await this.report(job.id, { ...outcome, headSha: fetched?.head ?? null, baseSha: fetched?.base ?? null });
    }

    /** Tell the server how the job ended, trying again for a while if it can't be reached. */
    private async report(jobId: string, outcome: Parameters<ServerClient["finish"]>[1]): Promise<void> {
        for (let attempt = 1; attempt <= 8; attempt++) {
            try {
                await this.server.finish(jobId, outcome);
                return;
            } catch (err) {
                // Lost, or refused (sending it again would be refused again): no point trying again.
                const refused = err instanceof ServerError && err.status >= 400 && err.status < 500;
                if (isLost(err) || refused || attempt === 8) {
                    console.error(`Couldn't report how ${jobId} ended: ${(err as Error).message}`);
                    return;
                }
                await sleep(Math.min(1000 * 2 ** attempt, 30_000));
            }
        }
    }
}
