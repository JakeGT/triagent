// Model URLs people type in (a custom OpenAI-compatible server, an Azure OpenAI endpoint) are fetched by
// the server (model lists) and by the runner (reviews), so they could be pointed at the instance's own
// network: the database, a cloud metadata service, an admin page. They must be https and resolve only to
// public addresses, checked when they're saved and again when a review starts. Every address the name
// resolves to is checked, not just the first.
//
// ALLOW_PRIVATE_MODEL_URLS=true lets an instance use private and loopback addresses (a self-hosted Ollama),
// and then plain http for those addresses only.
//
// Not covered: DNS rebinding (a name that resolves to a public address when checked and a private one
// when used). The check narrows what a URL can reach; it isn't a network boundary.

import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIPv4, isIPv6 } from "node:net";

export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

export const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export class UnsafeUrl extends Error {}

const v4 = new BlockList();
for (const [net, bits] of [
    ["0.0.0.0", 8], // "this network"
    ["10.0.0.0", 8],
    ["100.64.0.0", 10], // carrier-grade NAT
    ["127.0.0.0", 8],
    ["169.254.0.0", 16], // link-local, cloud metadata services
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved, and broadcast
] as const)
    v4.addSubnet(net, bits, "ipv4");

const v6 = new BlockList();
for (const [net, bits] of [
    ["::", 128],
    ["::1", 128],
    ["::ffff:0:0", 96], // IPv4-mapped: checked as IPv4 below, and never a public answer anyway
    ["64:ff9b:1::", 48], // local-use NAT64
    ["100::", 64], // discard
    ["2001::", 23], // IETF protocol assignments (Teredo, ORCHID, benchmarking…)
    ["2001:db8::", 32], // documentation
    ["fc00::", 7], // unique local
    ["fe80::", 10], // link-local
    ["fec0::", 10], // old site-local
    ["ff00::", 8], // multicast
] as const)
    v6.addSubnet(net, bits, "ipv6");

/** The 16 bytes of an IPv6 address. */
function v6Bytes(address: string): number[] | null {
    let a = address.replace(/%.*$/, "");
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (dotted) {
        const p = (dotted[1] as string).split(".").map(Number);
        a = `${a.slice(0, -(dotted[1] as string).length)}${(((p[0] as number) << 8) | (p[1] as number)).toString(16)}:${(((p[2] as number) << 8) | (p[3] as number)).toString(16)}`;
    }
    const [head, tail] = a.includes("::") ? (a.split("::") as [string, string]) : [a, null];
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
    if (groups.length !== 8) return null;
    return groups.flatMap((g) => {
        const n = Number.parseInt(g, 16);
        return [n >> 8, n & 0xff];
    });
}

/** An IPv4 address carried inside an IPv6 one (mapped, NAT64, 6to4), if there is one. */
function embeddedV4(address: string): string | null {
    const b = v6Bytes(address);
    if (!b) return null;
    const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
    if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12).join("."); // ::ffff:a.b.c.d
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return b.slice(12).join("."); // 64:ff9b::/96
    if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6).join("."); // 2002::/16, 6to4
    return null;
}

/** Whether an address is private, loopback, link-local or otherwise not on the public internet. */
export function isPrivateAddress(address: string): boolean {
    if (isIPv4(address)) return v4.check(address, "ipv4");
    if (!isIPv6(address)) return true;
    const inner = embeddedV4(address);
    if (inner && v4.check(inner, "ipv4")) return true;
    return v6.check(address.replace(/%.*$/, ""), "ipv6");
}

export interface UrlPolicy {
    allowPrivate: boolean;
    lookup: Lookup;
}

/**
 * The URL, tidied (no trailing slash), if it's safe to send a model key to; otherwise UnsafeUrl, saying why.
 * `what` names it for people: "The custom provider's URL".
 */
export async function checkModelUrl(raw: string, policy: UrlPolicy, what = "The URL"): Promise<string> {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new UnsafeUrl(`${what} isn't a valid address. Give the full address, starting https://.`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrl(`${what} must start https://.`);
    if (url.username || url.password) throw new UnsafeUrl(`${what} mustn't contain a user name or password. Use the key field.`);
    if (url.search || url.hash) throw new UnsafeUrl(`${what} mustn't have a query string or fragment.`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];
    if (isIPv4(host) || isIPv6(host)) addresses = [host];
    else {
        try {
            addresses = (await policy.lookup(host)).map((a) => a.address);
        } catch {
            addresses = [];
        }
        if (!addresses.length) throw new UnsafeUrl(`${what} names a host that doesn't resolve (${host}).`);
    }
    const isPrivate = addresses.some(isPrivateAddress);
    if (isPrivate && !policy.allowPrivate)
        throw new UnsafeUrl(
            `${what} points at a private or loopback address (${host}). This instance only sends model keys to public addresses; its administrator can allow private ones with ALLOW_PRIVATE_MODEL_URLS=true.`,
        );
    // Plain http only where the instance has allowed private addresses, and only to them.
    if (url.protocol === "http:" && !(policy.allowPrivate && addresses.every(isPrivateAddress)))
        throw new UnsafeUrl(`${what} must use https.`);
    return url.href.replace(/\/+$/, "");
}
