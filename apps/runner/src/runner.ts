// The runner: asks the server for work, runs Open Code Review on it, and reports back. It has no
// database and keeps nothing between jobs but bare git mirrors; each job's credentials live only in
// memory, for that job.
//
// OCR gets an explicit environment and nothing else: a throwaway HOME (OCR reads its user config, with
// any MCP servers and setup commands, and its global rules from ~/.opencodereview, so there are none
// but what the runner writes there for Amazon Bedrock: a provider, region and model), the model's
// settings, and git settings that keep hooks off. Never telemetry settings, nor anything of Anthropic's.
//
// A job with several models runs one OCR per model at once, each with a HOME, environment and limits of
// its own, all reading the same checkout (OCR 1.12.12 writes nothing into it: its sessions go under HOME).
// One model failing, stalling or being stopped for passing its token budget leaves the others alone. OCR
// ends a review that reaches its budget by itself, keeping what it found, so a model the server says is
// over budget is given a while to do that, and only stopped if it's still going after it.

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { modelSecrets, type RunnerModel } from "../../../packages/shared/src/model.ts";
import { redactDeep, redactor } from "../../../packages/shared/src/redact.ts";
import {
    type ClaimedJob,
    type FinishPart,
    isLost,
    type ModelStop,
    type Orders,
    type RunnerIdentity,
    ServerClient,
    ServerError,
} from "./client.ts";
import type { RunnerConfig } from "./config.ts";
import { Git, gitEnv, mirrorPath, WORKTREE_KEEP_MS } from "./git.ts";
import { type Judged, judgeFindings, whyNot } from "./judge.ts";
import { type LockOptions, PathLocks } from "./lock.ts";
import { start } from "./process.ts";
import { combined, type ModelProgress, type Progress, readProgress } from "./progress.ts";

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
    shared = false,
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
        // Several OCRs reading one checkout: none of their git commands may take its index lock to tidy it.
        ...(shared ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
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
/** "2 minutes", "90 seconds". */
const span = (seconds: number) => (seconds % 60 === 0 ? minutes(seconds / 60) : `${seconds} second${seconds === 1 ? "" : "s"}`);

/** The models a job reviews with, in order: those it lists, or its one model. */
export function modelsOf(job: Pick<ClaimedJob, "model" | "models">): NonNullable<ClaimedJob["models"]> {
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

/** One of a job's several models: its own progress and OCR process. */
interface Slot {
    progress: ModelProgress;
    groups: Set<string>;
    stop: (() => void) | null;
    /**
     * Set when the server says it has passed its token budget (null when it gave no figure). It has until
     * `timer` runs out to finish by itself; `stopped` once it didn't, and was stopped for it.
     */
    overBudget: { budget: number | null; timer: ReturnType<typeof setTimeout> | null; stopped: boolean } | null;
}

/** One job in progress: its log buffer, heartbeat and the OCR process (or one per model). */
export class JobRun {
    private readonly job: Pick<ClaimedJob, "id" | "git" | "model" | "models" | "judge">;
    private readonly server: Pick<ServerClient, "events" | "heartbeat">;
    private readonly redact: (line: string) => string;
    private buffer: { at: string; line: string }[] = [];
    private progress: Progress = {};
    private progressDirty = false;
    private readonly groups = new Set<string>();
    private stopOcr: (() => void) | null = null;
    /** The job's models, when it reviews with several at once. */
    private slots: Slot[] = [];
    cancelled = false;
    lost = false;
    private readonly stopping = new AbortController();
    private readonly timers: ReturnType<typeof setInterval>[] = [];
    private flushing: Promise<void> = Promise.resolve();

    /** How long a model over its token budget gets to finish by itself. */
    private readonly graceSeconds: number;

    constructor(
        job: Pick<ClaimedJob, "id" | "git" | "model" | "models" | "judge">,
        server: Pick<ServerClient, "events" | "heartbeat">,
        graceSeconds = 120,
    ) {
        this.graceSeconds = graceSeconds;
        this.job = job;
        this.server = server;
        // The job's own secrets come out before anything leaves the runner (the server redacts again).
        this.redact = redactor([job.git.token, ...[...modelsOf(job), ...(job.judge ? [job.judge] : [])].flatMap((m) => modelSecrets(m))]);
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
        this.setProgress(readProgress(this.progress, line, this.groups));
    }

    /** Tokens OCR has said the model used (a job with one model). */
    get modelTokens(): number {
        return this.progress.tokens ?? 0;
    }

    // ---- several models at once ------------------------------------------------------------------

    /** The job reviews with several models: each gets progress of its own, waiting until it starts. */
    several(labels: readonly string[]): void {
        this.slots = labels.map((label) => ({ progress: { label, phase: "waiting" }, groups: new Set(), stop: null, overBudget: null }));
        this.progress = { phase: "starting" };
        this.together();
    }

    /** The job's progress, from its models'. */
    private together(): void {
        this.setProgress(
            combined(
                this.progress,
                this.slots.map((s) => s.progress),
            ),
        );
    }

    private slot(i: number): Slot {
        return this.slots[i] as Slot;
    }

    /** A line about one model, from the runner: it starts with the model's label, like OCR's own lines for it. */
    sayFor(i: number, line: string): void {
        this.log(`[${this.slot(i).progress.label}] [triagent] ${line}`);
    }

    /** A line of one model's OCR: logged under its label, and read for that model's progress. */
    modelLine(i: number, line: string): void {
        const slot = this.slot(i);
        this.log(`[${slot.progress.label}] ${line}`);
        slot.progress = { ...readProgress(slot.progress, line, slot.groups), label: slot.progress.label };
        this.together();
    }

    setModel(i: number, change: Partial<ModelProgress>): void {
        const slot = this.slot(i);
        slot.progress = { ...slot.progress, ...change };
        this.together();
    }

    /** Tokens OCR has said this model used. */
    tokensOf(i: number): number {
        return this.slot(i).progress.tokens ?? 0;
    }

    /** One model's OCR process has started; it's stopped at once if the job already is. */
    attachModel(i: number, stop: () => void): void {
        const slot = this.slot(i);
        slot.stop = stop;
        if (this.cancelled || this.lost) stop();
    }

    /** One model's OCR process has ended: if it was over its budget, it's no longer waited for. */
    detachModel(i: number): void {
        const slot = this.slot(i);
        slot.stop = null;
        if (slot.overBudget?.timer) clearTimeout(slot.overBudget.timer);
    }

    /**
     * The budget this model was stopped for passing, having not finished by itself in time (null when the
     * server gave no figure), or undefined if it wasn't stopped for that.
     */
    stoppedOverBudget(i: number): number | null | undefined {
        const over = this.slot(i).overBudget;
        return over?.stopped ? over.budget : undefined;
    }

    /** "… and didn't finish by itself within 2 minutes", for a model stopped after its time to finish; nothing when it got none. */
    get graceText(): string {
        return this.graceSeconds ? ` and didn't finish by itself within ${span(this.graceSeconds)}` : "";
    }

    /** What the server said back: stop everything, or only the models it names (the others carry on). */
    private obey(orders: Orders): void {
        if (orders.cancel) this.cancel();
        for (const order of Array.isArray(orders.stop) ? orders.stop : []) this.stopModel(order);
    }

    private stopModel(order: ModelStop): void {
        const slot = this.slots[order.index];
        // Only a model that is running: one that has ended, or hasn't had its turn, has nothing to stop.
        // The server names it every time until it ends: only the first starts the wait.
        if (!slot?.stop || slot.overBudget || order.reason !== "overBudget") return;
        const over: NonNullable<Slot["overBudget"]> = {
            budget: typeof order.budget === "number" ? order.budget : null,
            timer: null,
            stopped: false,
        };
        slot.overBudget = over;
        const stop = () => {
            over.timer = null;
            if (!slot.stop) return;
            over.stopped = true;
            slot.stop();
        };
        const passed = `Passed its token budget${over.budget === null ? "" : ` of ${over.budget.toLocaleString("en-GB")} tokens`}`;
        // OCR winds a review up by itself when it reaches its budget, and its findings are kept: give it the chance.
        this.sayFor(
            order.index,
            this.graceSeconds ? `${passed}; it has ${span(this.graceSeconds)} to finish by itself.` : `${passed}; stopping it.`,
        );
        if (this.graceSeconds) {
            over.timer = setTimeout(stop, this.graceSeconds * 1000);
            over.timer.unref();
        } else stop();
    }

    /** Send buffered lines and progress; a cancellation or a lost job stops OCR. */
    flush(): Promise<void> {
        this.flushing = this.flushing.then(async () => {
            if (this.lost || (!this.buffer.length && !this.progressDirty)) return;
            const lines = this.buffer.splice(0, MAX_BATCH);
            const clean = (p: object) =>
                Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? this.redact(v) : v]));
            const progress = this.progressDirty
                ? { ...clean(this.progress), ...(this.progress.models ? { models: this.progress.models.map(clean) } : {}) }
                : null;
            this.progressDirty = false;
            try {
                this.obey(await this.server.events(this.job.id, lines, progress));
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
            this.obey(await this.server.heartbeat(this.job.id));
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
        this.stopAll();
    }

    private lose(): void {
        this.lost = true;
        this.stopping.abort();
        this.stopAll();
    }

    /** Stop every OCR process of the job. */
    private stopAll(): void {
        this.stopOcr?.();
        for (const slot of this.slots) slot.stop?.();
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
    /** One fetch at a time into each repository's mirror, among this runner's jobs and any other runner sharing the cache. */
    private readonly locks: PathLocks;
    readonly id = `runner-${randomBytes(9).toString("base64url")}`;
    private readonly active = new Map<string, JobRun>();
    private stopping = false;
    /** Aborted by stop(), to end the poll loop's wait. */
    private readonly wake = new AbortController();
    private loop: Promise<void> | null = null;
    /** Called when a job ends (tests wait on it). */
    onJobEnd: (jobId: string) => void = () => {};

    constructor(config: RunnerConfig, locks: LockOptions = {}) {
        this.config = config;
        this.locks = new PathLocks(locks);
        this.server = new ServerClient(config.serverUrl, config.secret, () => this.identity());
        this.git = new Git({ gitBin: config.gitBin, path: config.path, home: path.join(config.workDir, "git-home") });
        mkdirSync(path.join(config.workDir, "git-home"), { recursive: true, mode: 0o700 });
        mkdirSync(config.cacheDir, { recursive: true, mode: 0o700 });
    }

    identity(): RunnerIdentity {
        return {
            id: this.id,
            name: this.config.name,
            version: VERSION,
            slots: Math.max(0, this.config.concurrency - this.active.size),
            capacity: this.config.concurrency,
        };
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
        const run = new JobRun(job, this.server, this.config.overBudgetGraceSeconds);
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
        let keep: ReturnType<typeof setInterval> | null = null;
        try {
            work = mkdtempSync(path.join(this.config.workDir, "job-"));
            tree = path.join(work, "tree");
            run.setProgress({ phase: "fetching" });
            run.say(
                `Fetching ${job.kind === "pr" ? `pull request #${job.pr?.number}` : job.gitRef}${job.baseRef ? ` and ${job.baseRef}` : ""} from ${job.repository.fullName}…`,
            );
            // One fetch at a time into a repository's mirror: two at once would trip over each other's refs. Jobs
            // for other repositories don't wait, and nor does anything after the fetch (each job has its own worktree).
            fetched = await this.locks.hold(
                mirror,
                async () => {
                    run.check();
                    this.git.sweepWorktrees(mirror);
                    let got = await this.git.fetch(
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
                    if (job.commit) {
                        // A model of a finished review, run again: the commit that review was of, not where things are now.
                        const now = got.head;
                        got = await this.git.pin(
                            mirror,
                            { cloneUrl: job.repository.cloneUrl, username: job.git.username, token: job.git.token },
                            job.commit,
                            run.signal,
                        );
                        run.check();
                        run.say(
                            `Reviewing ${got.head.slice(0, 7)}, the commit the review this belongs to was of${now === got.head ? "" : ` (it's at ${now.slice(0, 7)} now)`}.`,
                        );
                    }
                    return got;
                },
                { signal: run.signal, onWait: () => run.say("Waiting for another review's fetch of this repository…") },
            );
            if (job.kind === "pr" && job.headSha && fetched.head !== job.headSha)
                run.say(`The pull request moved on to ${fetched.head.slice(0, 7)} since it was queued; reviewing that.`);
            if (fetched.base && fetched.base === fetched.head)
                throw new Error(
                    `There are no changes to review: ${job.gitRef ?? "the pull request"} has nothing that isn't on ${job.baseRef}.`,
                );
            await this.git.addWorktree(mirror, tree, fetched.head, fetched.base, run.signal);
            // A long review keeps showing that its worktree is in use, so its record isn't taken for one left by a dead runner.
            keep = setInterval(() => this.git.keepWorktree(mirror, tree), WORKTREE_KEEP_MS);
            keep.unref();
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
            const models = modelsOf(job);
            const limits = { limit: job.timeoutMinutes ?? null, stall: job.stallMinutes ?? null };
            const where = { work, tree, base: fetched.base, head: fetched.head };
            const started = () => {
                ocrStarted = true;
            };
            if (models.length > 1) {
                // Each model in a process of its own, as many at once as the runner allows; the rest wait their turn.
                const atOnce = Math.min(models.length, Math.max(1, this.config.modelParallelism));
                run.several(models.map((m) => m.label));
                run.say(
                    `Reviewing with ${models.length} models${atOnce < models.length ? `, ${atOnce} at a time` : " at once"}: ${models.map((m) => m.label).join(", ")}.`,
                );
                const parts: FinishPart[] = [];
                let next = 0;
                const turn = async () => {
                    while (next < models.length && !run.cancelled && !run.lost) {
                        const i = next++;
                        const began = Date.now();
                        let part: FinishPart;
                        try {
                            part = await this.review(job, run, where, limits, i, started);
                        } catch (err) {
                            // The job is no longer ours: nothing more to say about this model.
                            if (err instanceof Stop) return;
                            // It couldn't even start: that's this model's failure, not the others'.
                            part = { status: "failed", error: run.redactLine((err as Error).message), tokens: null, seconds: 0 };
                        }
                        parts[i] = part;
                        const seconds = Math.round((Date.now() - began) / 1000);
                        run.setModel(i, { phase: part.status, seconds, ...(part.reason ? { reason: part.reason } : {}) });
                        run.sayFor(
                            i,
                            part.status === "done" ? "Finished." : part.status === "cancelled" ? "Cancelled." : `Failed: ${part.error}`,
                        );
                    }
                };
                await Promise.all(Array.from({ length: atOnce }, turn));
                if (run.lost) throw new Stop("This job is no longer ours.");
                if (!run.cancelled) {
                    run.setProgress({ ...run.currentProgress, phase: "uploading" });
                    run.say("Reviews finished; sending each model's findings to Triagent to merge…");
                }
                // Models start in order, so those that had a turn come first; one that never did has no part.
                outcome = overall(
                    parts,
                    models.map((m) => m.label),
                    run.cancelled,
                );
                // The review chose to have a model asked which of the findings left apart are the same problem.
                if (job.judge && outcome.status === "done") {
                    const judged = await this.judge(job.judge, run, parts);
                    if (run.lost) throw new Stop("This job is no longer ours.");
                    // Cancelled while asking: the review ends as cancelled, as it would have a moment earlier.
                    outcome = run.cancelled
                        ? overall(
                              parts,
                              models.map((m) => m.label),
                              true,
                          )
                        : { ...outcome, judged };
                }
            } else {
                // One model: as it always was.
                run.setProgress({ phase: "starting" });
                const part = await this.review(job, run, where, limits, null, started);
                if (part.reason && part.status === "failed") throw new Error(part.error as string);
                if (part.status === "done") {
                    run.setProgress({ ...run.currentProgress, phase: "uploading" });
                    run.say("Review finished; sending the findings to Triagent…");
                }
                const { tokens: _t, seconds: _s, reason: _r, ...rest } = part;
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
            if (keep) clearInterval(keep);
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

    /**
     * Ask the job's judging model about the findings its reviews left apart, saying in the log how it went.
     * It never throws: the reviews are done by now, and whatever goes wrong here they're merged by place.
     */
    private async judge(model: NonNullable<ClaimedJob["judge"]>, run: JobRun, parts: readonly FinishPart[]): Promise<Judged> {
        let judged: Judged;
        try {
            run.setProgress({ ...run.currentProgress, phase: "merging" });
            run.say(`Asking ${model.label} which findings from different models are the same problem…`);
            judged = await judgeFindings(model, parts, {
                ...(this.config.llmTimeout ? { timeoutMs: Number(this.config.llmTimeout) * 1000 } : {}),
                signal: run.signal,
            });
        } catch (err) {
            judged = { pairs: [], total: 0, tokens: null, seconds: 0, error: whyNot(err).slice(0, 500) };
        }
        const error = judged.error ? run.redactLine(judged.error) : undefined;
        const same = judged.pairs.filter((p) => p.same).length;
        const asked = `${judged.pairs.length} pair${judged.pairs.length === 1 ? "" : "s"}`;
        run.say(
            error
                ? `${model.label} couldn't be asked (${error}), so findings are merged by where they are only.`
                : judged.pairs.length
                  ? `${model.label} compared ${asked}${judged.total > judged.pairs.length ? ` (the closest of ${judged.total})` : ""}: ${same} the same problem.`
                  : "No findings from different models were left to compare.",
        );
        run.setProgress({ ...run.currentProgress, phase: "uploading" });
        return { ...judged, ...(error ? { error } : {}) };
    }

    /**
     * One model's review: OCR in the job's checkout with a HOME, environment and limits of its own. `i` is the
     * model's place in a job with several (its lines and progress are its own), or null for a job with one.
     */
    private async review(
        job: ClaimedJob,
        run: JobRun,
        where: { work: string; tree: string; base: string | null; head: string },
        limits: { limit: number | null; stall: number | null },
        i: number | null,
        started: () => void,
    ): Promise<FinishPart> {
        const model = modelsOf(job)[i ?? 0] as NonNullable<ClaimedJob["models"]>[number];
        const { limit, stall } = limits;
        const one = { ...job, model };
        // A model with a token budget of its own (the instance's, out of an allowance) uses that, not the job's.
        const args = ocrArgs(
            model.maxTokensBudget === undefined ? job : { ...job, maxTokensBudget: model.maxTokensBudget },
            where.base,
            where.head,
        );
        const own = path.join(where.work, `home-${i ?? 0}`);
        mkdirSync(path.join(own, "tmp"), { recursive: true, mode: 0o700 });
        const running = `Running ocr ${args.join(" ")} with ${model.model} via ${model.provider}. ${limit ? `Time limit: ${minutes(limit)}.` : "No time limit."}${stall ? ` Stopped as stalled if it prints nothing for ${minutes(stall)}.` : ""}`;
        if (i === null) run.say(running);
        else {
            run.setModel(i, { phase: "starting", startedAt: new Date().toISOString() });
            run.sayFor(i, running);
        }
        writeOcrConfig(own, one);
        started();
        const began = Date.now();
        const ocr = start(this.config.ocrBin, args, {
            cwd: where.tree,
            env: ocrEnv(this.config, own, one, where.base, i !== null),
            ...(limit ? { timeoutMs: limit * 60_000 } : {}),
            ...(stall ? { stallMs: stall * 60_000 } : {}),
            onLine: (line) => (i === null ? run.ocrLine(line) : run.modelLine(i, line)),
        });
        if (i === null) run.attach(ocr.stop);
        else run.attachModel(i, ocr.stop);
        const exit = await ocr.done;
        if (i !== null) run.detachModel(i);
        let report: unknown = null;
        try {
            report = exit.stdout.trim() ? run.redactReport(JSON.parse(exit.stdout)) : null;
        } catch {
            report = null;
        }
        if (run.lost) throw new Stop("This job is no longer ours.");
        const timing = {
            tokens: (i === null ? run.modelTokens : run.tokensOf(i)) || null,
            seconds: Math.round((Date.now() - began) / 1000),
        };
        const overBudget = i === null ? undefined : run.stoppedOverBudget(i);
        let part: FinishPart;
        if (run.cancelled) part = { status: "cancelled", ...(report ? { report } : {}) };
        else if (exit.timedOut)
            part = {
                status: "failed",
                reason: "timeLimit",
                error: `Stopped after ${minutes(limit as number)}, the project's time limit for this kind of review. An admin can raise it in the project's Automation settings.`,
            };
        else if (exit.stalled)
            part = {
                status: "failed",
                reason: "stalled",
                error: `Stalled: Open Code Review printed nothing for ${minutes(stall as number)}, so it was stopped (the model may have stopped answering). An admin can change how long it waits in the project's Automation settings.`,
            };
        else if (overBudget !== undefined && exit.killed)
            // What it wrote before it was stopped (if anything) still says what it used.
            part = {
                status: "failed",
                reason: "overBudget",
                error: `Stopped: it passed its token budget${overBudget === null ? "" : ` of ${overBudget.toLocaleString("en-GB")} tokens`}${run.graceText}.`,
                ...(report ? { report } : {}),
            };
        else if (exit.code !== 0)
            part = {
                status: "failed",
                error: run.redactLine(failureReason(exit.stderr, exit.code ?? exit.signal)),
                ...(report ? { report } : {}),
            };
        else if (!report || typeof report !== "object") part = { status: "failed", error: "Open Code Review didn't return a JSON report." };
        else part = { status: "done", report };
        return { ...part, ...timing };
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
