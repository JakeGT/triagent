// A stand-in for Sentry's ingest, for the end-to-end tests: it takes envelopes on FAKE_SENTRY_PORT as
// Sentry does (/api/<project>/envelope/) and hands back what it was sent (/_fake/items), so a test can
// check what would have left the instance. Nothing here talks to Sentry.

import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

interface Item {
    /** The envelope item's type: "event", "log", "transaction", … */
    type: string;
    /** Which project it was sent to. */
    project: string;
    payload: unknown;
    /** The whole item as text, for checking what isn't in it. */
    raw: string;
}

const items: Item[] = [];
const port = Number(process.env.FAKE_SENTRY_PORT ?? 0);

function take(project: string, body: Buffer): void {
    const lines = body.toString("utf8").split("\n");
    // The first line is the envelope's own header; then a header and a payload for each item.
    for (let i = 1; i + 1 < lines.length; i += 2) {
        try {
            const header = JSON.parse(lines[i] as string) as { type?: string };
            items.push({ type: header.type ?? "?", project, payload: JSON.parse(lines[i + 1] as string), raw: lines[i + 1] as string });
        } catch {
            // Not JSON (an attachment): nothing the tests look at.
        }
    }
    items.splice(0, Math.max(0, items.length - 5000));
}

const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    };
    if (url.pathname === "/_fake/health") return send(200, { ok: true });
    if (url.pathname === "/_fake/items") return send(200, items);
    const m = /^\/api\/(\d+)\/envelope\/$/.exec(url.pathname);
    if (req.method !== "POST" || !m) return send(404, { error: "Not found" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
        const body = Buffer.concat(chunks);
        try {
            take(m[1] as string, req.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body);
        } catch {
            return send(400, { error: "Not an envelope" });
        }
        send(200, {});
    });
});
server.listen(port, "127.0.0.1", () => console.log(`Fake Sentry at http://127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
