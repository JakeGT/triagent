// Child processes in a process group of their own, so stopping one (on cancel, timeout or stall) stops
// everything it started too.

import { spawn } from "node:child_process";

const MAX_STDOUT = 60 * 1024 * 1024;
const STDERR_TAIL = 8000;

export interface Exit {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    /** The end of stderr, for error messages. */
    stderr: string;
    timedOut: boolean;
    /** Stopped for printing nothing for `stallMs`. */
    stalled: boolean;
    killed: boolean;
}

export interface Running {
    readonly pid: number | undefined;
    readonly done: Promise<Exit>;
    /** Stop the group: SIGTERM, then SIGKILL a few seconds later if it's still there. */
    stop(): void;
}

export interface SpawnOptions {
    cwd?: string;
    /** The whole environment the child gets: nothing is inherited. */
    env: Record<string, string>;
    /** Stop it after this long. Without one it runs until it ends. */
    timeoutMs?: number;
    /** Stop it when it has written nothing (to stdout or stderr) for this long. */
    stallMs?: number;
    /** Each complete stderr line, as it arrives. */
    onLine?: (line: string) => void;
    /** Stops the process group when aborted (a cancelled or lost review). */
    signal?: AbortSignal;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
    if (!pid) return;
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // already gone
        }
    }
}

export function start(cmd: string, args: string[], options: SpawnOptions): Running {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let timedOut = false;
    let stalled = false;
    let killed = false;
    /** Once it has exited, its pid may belong to something else: never signal it again. */
    let exited = false;
    let hardKill: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
        if (killed || exited) return;
        killed = true;
        signalGroup(child.pid, "SIGTERM");
        hardKill = setTimeout(() => signalGroup(child.pid, "SIGKILL"), 5000);
        hardKill.unref();
    };
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", stop, { once: true });
    const timer = options.timeoutMs
        ? setTimeout(() => {
              // Already being stopped (cancelled): that's why it ends, not the time limit.
              if (killed) return;
              timedOut = true;
              stop();
          }, options.timeoutMs)
        : null;
    timer?.unref();
    // Started again by everything the child writes; if it ever runs out, the child has gone quiet.
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const heard = () => {
        if (!options.stallMs || exited) return;
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(() => {
            if (killed) return;
            stalled = true;
            stop();
        }, options.stallMs);
        quiet.unref();
    };
    heard();
    const out: Buffer[] = [];
    let outSize = 0;
    let errTail = "";
    let partial = "";
    // Decoded as a stream, so a character split across chunks arrives whole.
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: Buffer) => {
        heard();
        outSize += d.length;
        if (outSize <= MAX_STDOUT) out.push(d);
    });
    child.stderr.on("data", (text: string) => {
        heard();
        errTail = (errTail + text).slice(-STDERR_TAIL);
        if (!options.onLine) return;
        const lines = (partial + text).split(/\r?\n/);
        partial = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) options.onLine(line);
    });
    const done = new Promise<Exit>((resolve) => {
        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
            // A failure to start can be followed by "close" too.
            if (exited) return;
            if (timer) clearTimeout(timer);
            if (quiet) clearTimeout(quiet);
            options.signal?.removeEventListener("abort", stop);
            if (partial.trim()) options.onLine?.(partial);
            partial = "";
            // Anything the child left behind in its group goes too.
            signalGroup(child.pid, "SIGKILL");
            exited = true;
            if (hardKill) clearTimeout(hardKill);
            resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: errTail, timedOut, stalled, killed });
        };
        child.on("error", (err: NodeJS.ErrnoException) => {
            errTail += err.code === "ENOENT" ? `${cmd} isn't installed.` : err.message;
            finish(127, null);
        });
        child.on("close", finish);
    });
    return { pid: child.pid, done, stop };
}

/** Run to completion; throws (with the end of stderr) if it fails. */
export async function run(cmd: string, args: string[], options: SpawnOptions): Promise<string> {
    const exit = await start(cmd, args, options).done;
    if (exit.code !== 0) {
        const why = exit.timedOut
            ? "took too long and was stopped"
            : exit.stalled
              ? "went quiet and was stopped"
              : exit.killed
                ? "was stopped"
                : `failed (exit ${exit.code ?? exit.signal})`;
        throw new Error(
            `${cmd} ${args[0] === "--git-dir" ? (args[2] ?? "") : (args[0] ?? "")} ${why}: ${exit.stderr.trim().split("\n").slice(-3).join(" ")}`,
        );
    }
    return exit.stdout;
}
