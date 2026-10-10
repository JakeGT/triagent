// One job at a time on a path in the cache directory (a repository's mirror, while it's fetched into):
// a queue inside this process, and a lock on disk for other runners sharing the cache volume.
//
// The lock on disk is a directory, `<path>.lock`, holding one file named by its holder. It's taken by
// renaming a directory made ready beforehand (the file already in it) into place, which the file system
// only allows onto nothing or onto an empty directory: so the lock appears with its holder's file in it,
// and whoever holds a lock that's still there is the only one who took it. Releasing removes the file,
// then the empty directory.
//
// A holder that crashed leaves its file behind. The holder rewrites its file every few seconds; anyone
// waiting watches it, and takes a file that hasn't changed for `staleMs` *of the waiter's own time* to be
// abandoned, and removes that file, by its name. Nothing compares clocks, so runners whose clocks differ
// agree, and no process id is read, so runners in different containers (where a pid means nothing) or a
// pid used again can't mislead. Removing a file by its holder's name can only ever release that holder:
// two waiters breaking the same lock, or one that's slow to act on what it saw, never touch the lock of
// whoever took it next.
//
// A holder that was only slow (its process stopped for longer than `staleMs`) loses the lock to a waiter
// and carries on unaware until its next refresh. Then two git commands work on one mirror for a while,
// which git survives (it locks each ref it writes): one of them may fail and say so. That's the cost of
// a lock that can't stick for ever.

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface LockOptions {
    /** A lock whose holder hasn't refreshed it for this long, as its waiter saw it, is taken over. */
    staleMs?: number;
    /** How often a holder refreshes its lock. Well under `staleMs`. */
    refreshMs?: number;
    /** How often a waiter looks again. */
    pollMs?: number;
}

export interface HoldOptions {
    /** Stops the wait when aborted (a cancelled or lost review): nothing is left behind. */
    signal?: AbortSignal | undefined;
    /** Called once, if the lock isn't free at once. */
    onWait?: (() => void) | undefined;
}

/** Thrown when the wait is aborted. */
export class LockAborted extends Error {}

/** Thrown when the lock can't be taken for a reason waiting won't fix (the cache directory can't be written to). */
export class LockUnusable extends Error {}

const FULL = new Set(["ENOTEMPTY", "EEXIST"]);
const code = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? "";

export class PathLocks {
    private readonly staleMs: number;
    private readonly refreshMs: number;
    private readonly pollMs: number;
    /** The end of this process's queue for each path. */
    private readonly tails = new Map<string, Promise<void>>();

    constructor(options: LockOptions = {}) {
        this.staleMs = options.staleMs ?? 30_000;
        this.refreshMs = options.refreshMs ?? Math.max(10, Math.min(5000, Math.floor(this.staleMs / 6)));
        this.pollMs = options.pollMs ?? 200;
    }

    /** Where the lock for `target` is kept: beside it, so it can be taken before `target` exists. */
    static dir(target: string): string {
        return `${target}.lock`;
    }

    /** Run `fn` while nothing else, in this process or another, holds `target`. */
    async hold<T>(target: string, fn: () => Promise<T>, options: HoldOptions = {}): Promise<T> {
        const { signal } = options;
        let waited = false;
        const wait = () => {
            if (!waited) options.onWait?.();
            waited = true;
        };
        const before = this.tails.get(target);
        let done = () => {};
        const mine = new Promise<void>((resolve) => {
            done = resolve;
        });
        // Whoever comes next waits for everyone before us too, even if we give up waiting.
        const tail = (before ?? Promise.resolve()).then(() => mine);
        this.tails.set(target, tail);
        void tail.then(() => {
            if (this.tails.get(target) === tail) this.tails.delete(target);
        });
        try {
            if (before) {
                wait();
                await aborted(before, signal);
            }
            const release = await this.take(target, signal, wait);
            try {
                return await fn();
            } finally {
                release();
            }
        } finally {
            done();
        }
    }

    /** Take the lock on disk, waiting for (or taking over from) whoever has it. Returns how to release it. */
    private async take(target: string, signal: AbortSignal | undefined, wait: () => void): Promise<() => void> {
        const dir = PathLocks.dir(target);
        const holder = `${process.pid}-${randomBytes(9).toString("hex")}`;
        const ready = `${dir}.${holder}`;
        const file = path.join(dir, holder);
        /** What each file in the lock looked like, and when (by our own clock) it last looked different. */
        const seen = new Map<string, { state: string; since: number }>();
        for (;;) {
            if (signal?.aborted) throw new LockAborted("Stopped while waiting for another review's fetch of this repository.");
            try {
                mkdirSync(ready, { recursive: true, mode: 0o700 });
                writeFileSync(path.join(ready, holder), "0", { mode: 0o600 });
                renameSync(ready, dir);
                break;
            } catch (err) {
                rmSync(ready, { recursive: true, force: true });
                if (!FULL.has(code(err)))
                    throw new LockUnusable(
                        `The runner can't write to its cache directory (RUNNER_CACHE_DIR, ${path.dirname(dir)}): ${(err as Error).message}`,
                    );
            }
            wait();
            this.breakStale(dir, seen);
            await sleep(this.pollMs, undefined, signal ? { signal } : {}).catch(() => {});
        }
        let beat = 0;
        let lost = false;
        const timer = setInterval(() => {
            try {
                // Only if it's still there ("r+" never creates it): a new file would land in someone else's lock.
                writeFileSync(file, String(++beat), { flag: "r+" });
            } catch {
                if (!lost) console.error(`Lost the lock on ${target}: it was taken over as abandoned. Carrying on.`);
                lost = true;
            }
        }, this.refreshMs);
        timer.unref();
        return () => {
            clearInterval(timer);
            rmSync(file, { force: true });
            try {
                rmdirSync(dir);
            } catch {
                // Taken again already, or gone: either way not ours to remove.
            }
        };
    }

    /** Remove from the lock any holder's file that hasn't changed for `staleMs` since we first saw it as it is. */
    private breakStale(dir: string, seen: Map<string, { state: string; since: number }>): void {
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            return;
        }
        const t = performance.now();
        for (const name of names) {
            const at = path.join(dir, name);
            let state: string;
            try {
                state = `${statSync(at).mtimeMs} ${readFileSync(at, "utf8").slice(0, 40)}`;
            } catch {
                // Gone since it was listed, or not a file: the latter never changes, so it goes once it's stale.
                state = "?";
            }
            const was = seen.get(name);
            if (!was || was.state !== state) seen.set(name, { state, since: t });
            else if (t - was.since >= this.staleMs) {
                rmSync(at, { recursive: true, force: true });
                seen.delete(name);
            }
        }
        for (const name of seen.keys()) if (!names.includes(name)) seen.delete(name);
    }
}

/** `p`, or a LockAborted as soon as `signal` aborts. */
function aborted(p: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return p;
    const stopped = () => new LockAborted("Stopped while waiting for another review's fetch of this repository.");
    if (signal.aborted) return Promise.reject(stopped());
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(stopped());
        signal.addEventListener("abort", onAbort, { once: true });
        void p.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        });
    });
}
