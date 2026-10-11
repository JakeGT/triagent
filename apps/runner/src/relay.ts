// The runner's log lines, passed on to the server. The server has the error tracker (if one is set up);
// the runner reports to nothing outside itself, and needs no key or way out for it: its lines travel the
// way everything else it says does, with the runner secret.
//
// Nothing here may log: a line about a line that couldn't be sent would be the next line to send.

import type { LogRecord, LogSink } from "../../../packages/shared/src/log.ts";

const BATCH = 100;
const KEEP = 500;
const WAIT_MS = 2000;
/** How long to stop sending for once the server says it has no use for the lines, or doesn't know how to take them. */
const PAUSE_MS = 10 * 60_000;

export class LogRelay implements LogSink {
    private readonly send: (records: LogRecord[]) => Promise<{ wanted: boolean }>;
    private readonly now: () => number;
    private buffer: LogRecord[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private sending: Promise<void> = Promise.resolve();
    private pausedUntil = 0;

    constructor(send: (records: LogRecord[]) => Promise<{ wanted: boolean }>, now: () => number = Date.now) {
        this.send = send;
        this.now = now;
    }

    write(record: LogRecord): void {
        if (this.now() < this.pausedUntil) return;
        this.buffer.push(record);
        // The server away for a long while: the oldest lines go, as they would from any log that fills up.
        if (this.buffer.length > KEEP) this.buffer.splice(0, this.buffer.length - KEEP);
        if (this.timer) return;
        // An error goes at once; the rest wait a moment for company.
        this.timer = setTimeout(() => void this.drain(), record.level === "error" ? 100 : WAIT_MS);
        this.timer.unref();
    }

    private drain(): Promise<void> {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.sending = this.sending.then(async () => {
            while (this.buffer.length) {
                const batch = this.buffer.splice(0, BATCH);
                try {
                    if ((await this.send(batch)).wanted) continue;
                    this.pause();
                } catch (err) {
                    const status = (err as { status?: unknown }).status;
                    // Refused (a server from before it took these, most likely): the same lines would be refused again.
                    if (typeof status === "number" && status >= 400 && status < 500) this.pause();
                    // Away: keep them for the next line's turn.
                    else this.buffer.unshift(...batch);
                }
                return;
            }
        });
        return this.sending;
    }

    private pause(): void {
        this.buffer = [];
        this.pausedUntil = this.now() + PAUSE_MS;
    }

    async flush(timeoutMs: number): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            this.drain(),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
        clearTimeout(timer);
    }
}
