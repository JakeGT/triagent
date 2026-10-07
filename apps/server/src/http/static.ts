// Serves the built web app (apps/web/dist). Only files that exist in the build are served: the list is
// read once at start-up, and a request matches an entry exactly or not at all, so no path can reach
// outside it. Fingerprinted files under /assets are cached for a year; everything else, index.html
// included, is revalidated on each load. Other GET requests that aren't for the API get index.html,
// so the app's own routes (/w/acme/p/app/issues) work on reload.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";

const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
};

/** Paths the server answers itself: never the app's index.html. */
const SERVER_PATHS = ["/api", "/auth", "/mcp", "/healthz", "/llms.txt"];

interface WebFile {
    body: Uint8Array;
    type: string;
    etag: string;
    immutable: boolean;
}

/** Where the built app is: WEB_DIST_DIR (from the config), or apps/web/dist in this repository. */
export function webDistDir(configured: string | null): string {
    return configured || path.resolve(import.meta.dirname, "../../../web/dist");
}

function listFiles(root: string): Map<string, WebFile> {
    const files = new Map<string, WebFile>();
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            // Skip dotfiles and folders, such as Vite's .vite/manifest.json.
            if (entry.name.startsWith(".")) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                const type = TYPES[path.extname(entry.name).toLowerCase()];
                if (!type) continue;
                const rel = `/${path.relative(root, full).split(path.sep).join("/")}`;
                const body = readFileSync(full);
                files.set(rel, {
                    body,
                    type,
                    etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`,
                    immutable: rel.startsWith("/assets/"),
                });
            }
        }
    };
    walk(root);
    return files;
}

const loaded = new Map<string, Map<string, WebFile> | null>();

/** The build's files, read once per directory (null, with one warning, if there's no build). */
function load(dir: string): Map<string, WebFile> | null {
    if (!loaded.has(dir)) {
        const ok = existsSync(path.join(dir, "index.html")) && statSync(dir).isDirectory();
        if (!ok) console.warn(`No web app build at ${dir}: serving the API only. Run \`pnpm build:web\` to build it.`);
        loaded.set(dir, ok ? listFiles(dir) : null);
    }
    return loaded.get(dir) ?? null;
}

const isServerPath = (p: string) => SERVER_PATHS.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));

function send(c: Context, file: WebFile): Response {
    c.header("Cache-Control", file.immutable ? "public, max-age=31536000, immutable" : "no-cache");
    c.header("ETag", file.etag);
    c.header("Content-Type", file.type);
    if (c.req.header("if-none-match") === file.etag) return c.body(null, 304);
    return c.body(file.body as Uint8Array<ArrayBuffer>, 200);
}

/**
 * Add the web app to `app` (after the API routes, so they take precedence). Returns false, and serves
 * nothing, when there's no build: the API works without it.
 */
export function serveWeb(app: Hono, dir = webDistDir(null)): boolean {
    const files = load(dir);
    const index = files?.get("/index.html");
    if (!files || !index) return false;
    app.on(["GET", "HEAD"], "*", async (c, next) => {
        const p = c.req.path;
        if (isServerPath(p)) return next();
        const file = files.get(p);
        if (file) return send(c, file);
        // A missing asset is a 404, not the app: a stale page asking for an old chunk should fail clearly.
        if (p.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(p)) return next();
        return send(c, index);
    });
    return true;
}
