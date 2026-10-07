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

export function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
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
    if (username && password.toLowerCase().includes(username.toLowerCase())) throw new Error("The password must not contain the username.");
    return password;
}

/** A temporary password for accounts an admin creates or resets; the person must replace it. */
export const generatePassword = () => randomBytes(15).toString("base64url");

/** Counts failures per key within a fixed window, to slow down password guessing. */
export class FailureLimiter {
    private readonly hits = new Map<string, { count: number; resetAt: number }>();
    private readonly limit: number;
    private readonly windowMs: number;

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
        if (this.hits.size > 50_000) this.sweep();
    }

    clear(key: string): void {
        this.hits.delete(key);
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
        b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
        b.at = t;
        this.buckets.set(key, b);
        if (b.tokens < 1) return false;
        b.tokens -= 1;
        return true;
    }
}
