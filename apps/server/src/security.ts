// Passwords, random ids, constant-time comparison and rate limits.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export const MIN_PASSWORD = 12;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomId = (bytes = 9) => randomBytes(bytes).toString("base64url");
export const now = () => new Date().toISOString();

/** Compare in constant time, length included: digests of any two strings are the same size. */
export function safeEqual(a: string, b: string): boolean {
    const digest = (s: string) => createHash("sha256").update(s).digest();
    return timingSafeEqual(digest(a), digest(b));
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password.normalize("NFKC"), salt, KEYLEN, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** False for a wrong password and for a malformed stored hash; never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    try {
        const [scheme, N, r, p, salt, key, ...extra] = stored.split("$");
        if (scheme !== "scrypt" || !salt || !key || extra.length || ![N, r, p].every((v) => /^\d{1,7}$/.test(v ?? ""))) return false;
        const expected = Buffer.from(key, "base64");
        if (expected.length < 16) return false;
        const actual = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64"), expected.length, {
            N: Number(N),
            r: Number(r),
            p: Number(p),
            maxmem: SCRYPT.maxmem,
        });
        return timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

/** Checked against when the account doesn't exist, so timing doesn't reveal which usernames do. */
export const DUMMY_PASSWORD_HASH = await hashPassword(randomBytes(16).toString("hex"));

export function checkNewPassword(password: unknown, username: string | null): string {
    if (typeof password !== "string" || password.length < MIN_PASSWORD)
        throw new Error(`Passwords need at least ${MIN_PASSWORD} characters.`);
    if (password.length > 1024) throw new Error("Passwords can be at most 1024 characters.");
    // Compared as it's hashed (NFKC), so fullwidth or compatibility look-alikes of the username count too.
    if (username && password.normalize("NFKC").toLowerCase().includes(username.normalize("NFKC").toLowerCase()))
        throw new Error("The password must not contain the username.");
    return password;
}

/** A temporary password for accounts an admin creates or resets; the person must replace it. */
export const generatePassword = () => randomBytes(15).toString("base64url");

/** Counts failures per key within a fixed window, to slow down password guessing. */
export class FailureLimiter {
    private readonly hits = new Map<string, { count: number; resetAt: number }>();
    private readonly limit: number;
    private readonly windowMs: number;
    private swept = 0;

    constructor(limit: number, windowMs: number) {
        this.limit = limit;
        this.windowMs = windowMs;
    }

    /** Seconds until `key` may try again, or 0. */
    retryAfter(key: string): number {
        const hit = this.hits.get(key);
        if (!hit || Date.now() > hit.resetAt || hit.count < this.limit) return 0;
        return Math.ceil((hit.resetAt - Date.now()) / 1000);
    }

    fail(key: string): void {
        const t = Date.now();
        const hit = this.hits.get(key);
        if (!hit || t > hit.resetAt) this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
        else hit.count++;
        // Past 50k keys, drop expired ones, but at most once a minute: a spray of live keys mustn't make
        // every failure scan the whole map. (Live keys stay counted; dropping them would undo the limit.)
        if (this.hits.size > 50_000 && t - this.swept > 60_000) {
            this.swept = t;
            this.sweep();
        }
    }

    clear(key: string): void {
        this.hits.delete(key);
    }

    /** Take back one counted failure (an attempt counted up front that turned out to succeed). */
    forgive(key: string): void {
        const hit = this.hits.get(key);
        if (!hit) return;
        // Nothing left to count (or the window has passed): drop the entry rather than keep a zero.
        if (hit.count <= 1 || Date.now() > hit.resetAt) this.hits.delete(key);
        else hit.count--;
    }

    sweep(): void {
        const t = Date.now();
        for (const [k, v] of this.hits) if (t > v.resetAt) this.hits.delete(k);
    }
}

/** A per-client request budget that refills continuously, to blunt floods and scraping. */
export class RequestLimiter {
    private readonly buckets = new Map<string, { tokens: number; at: number }>();
    private readonly perMinute: number;

    constructor(perMinute: number) {
        this.perMinute = perMinute;
        setInterval(() => {
            const t = Date.now();
            for (const [k, v] of this.buckets) if (t - v.at > 120_000) this.buckets.delete(k);
        }, 60_000).unref();
    }

    allow(key: string): boolean {
        const t = Date.now();
        const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: t };
        // max(0, …): a clock stepped backwards mustn't take tokens away.
        b.tokens = Math.min(this.perMinute, b.tokens + (Math.max(0, t - b.at) / 60_000) * this.perMinute);
        b.at = t;
        this.buckets.set(key, b);
        if (b.tokens < 1) return false;
        b.tokens -= 1;
        return true;
    }
}
