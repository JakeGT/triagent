/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Paths the Node server answers; in development the Vite server passes them on. */
const SERVER_PATHS = ["/api", "/auth", "/mcp", "/llms.txt", "/healthz"];
const server = process.env.TRIAGENT_SERVER ?? "http://localhost:8080";

/**
 * Sonner adds its stylesheet at runtime with a <style> element, which the Content Security Policy
 * (style-src 'self') refuses. Turn that off; src/main.tsx imports sonner/dist/styles.css instead.
 */
function sonnerWithoutInjectedStyles(): Plugin {
    return {
        name: "triagent:sonner-without-injected-styles",
        enforce: "pre",
        transform(code, id) {
            if (!/[\\/]sonner[\\/]dist[\\/]index\.m?js/.test(id)) return null;
            const out = code.replace(/function __insertCSS\(code\) \{/, "function __insertCSS(code) { return;");
            if (out === code) this.error("sonner no longer injects its CSS the expected way: check the CSP end-to-end test.");
            return { code: out, map: null };
        },
    };
}

export default defineConfig({
    plugins: [react(), tailwindcss(), sonnerWithoutInjectedStyles()],
    resolve: {
        alias: [
            { find: "@", replacement: path.resolve(import.meta.dirname, "src") },
            // Radix's scroll lock adds <style> elements; this version uses constructed stylesheets, which the CSP allows.
            { find: /^react-style-singleton$/, replacement: path.resolve(import.meta.dirname, "src/lib/style-singleton.ts") },
        ],
    },
    server: {
        port: 5173,
        proxy: Object.fromEntries(SERVER_PATHS.map((p) => [p, { target: server }])),
    },
    build: {
        // The server serves only files listed in the build.
        manifest: true,
        sourcemap: false,
        // Fonts must stay files: the CSP allows no data: fonts.
        assetsInlineLimit: 0,
    },
    test: {
        environment: "jsdom",
        include: ["src/**/*.test.{ts,tsx}"],
        setupFiles: ["src/test/setup.ts"],
        restoreMocks: true,
    },
});
