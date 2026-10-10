// A stand-in for a model provider's HTTP API, for tests of asking a model which findings are the same
// problem (apps/runner/src/judge.ts). It listens on 127.0.0.1, answers in whichever of the three protocols
// the request's path is (chat completions, responses, messages), and keeps every request it was sent.
//
// Tests choose what it says: `same` decides each pair (by default every pair is the same problem), and
// `mode` makes it misbehave: answer 500, say something that isn't an answer, take too long, send far too
// much, or send the caller somewhere else.

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface AskedPair {
    id: string;
    a: Record<string, unknown>;
    b: Record<string, unknown>;
}

export interface ProviderRequest {
    path: string;
    headers: http.IncomingHttpHeaders;
    /** The request body, as it was sent. */
    raw: string;
    body: Record<string, unknown>;
    /** The pairs it was asked about. */
    pairs: AskedPair[];
}

export type ProviderMode = "answer" | "error" | "nonsense" | "slow" | "huge" | "redirect" | "strings" | "partial";

export class FakeProvider {
    readonly requests: ProviderRequest[] = [];
    mode: ProviderMode = "answer";
    same: (pair: AskedPair) => boolean = () => true;
    /** Said before and after the answer, as a model that chats would. */
    chatter: [string, string] = ["", ""];
    private server: http.Server | null = null;
    url = "";

    async start(): Promise<this> {
        this.server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => this.answer(req, res, Buffer.concat(chunks).toString("utf8")));
        });
        await new Promise<void>((resolve) => (this.server as http.Server).listen(0, "127.0.0.1", () => resolve()));
        this.url = `http://127.0.0.1:${((this.server as http.Server).address() as AddressInfo).port}`;
        return this;
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (!server) return;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    private answer(req: http.IncomingMessage, res: http.ServerResponse, raw: string): void {
        const path = req.url ?? "";
        let body: Record<string, unknown> = {};
        try {
            body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            // kept as nothing
        }
        const messages = (body.messages ?? []) as { role: string; content: string }[];
        const question = path.endsWith("/responses") ? body.input : messages.find((m) => m.role === "user")?.content;
        let pairs: AskedPair[] = [];
        try {
            pairs = (JSON.parse(String(question)) as { pairs: AskedPair[] }).pairs;
        } catch {
            // not a question this fake knows
        }
        this.requests.push({ path, headers: req.headers, raw, body, pairs });
        const json = (status: number, value: unknown) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(value));
        };
        if (this.mode === "error") json(500, { error: { message: "The provider is having a bad day." } });
        else if (this.mode === "redirect") res.writeHead(307, { location: `${this.url}/elsewhere${path}` }).end();
        else if (this.mode === "slow") setTimeout(() => json(200, {}), 5000).unref();
        else json(...this.reply(path, pairs));
    }

    /** What it says about these pairs, in the protocol the path is. */
    private reply(path: string, pairs: AskedPair[]): [number, unknown] {
        const answers =
            this.mode === "strings"
                ? Object.fromEntries(pairs.map((p) => [p.id, "true"]))
                : Object.fromEntries((this.mode === "partial" ? pairs.slice(1) : pairs).map((p) => [p.id, this.same(p)]));
        const said =
            this.mode === "nonsense"
                ? "Certainly! They all look quite similar to me."
                : this.mode === "huge"
                  ? "x".repeat(2 * 1024 * 1024)
                  : `${this.chatter[0]}${JSON.stringify(answers)}${this.chatter[1]}`;
        if (path.endsWith("/chat/completions"))
            return [
                200,
                {
                    choices: [{ message: { role: "assistant", content: said } }],
                    usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 },
                },
            ];
        if (path.endsWith("/responses"))
            return [
                200,
                {
                    output: [
                        { type: "reasoning", summary: [] },
                        { type: "message", content: [{ type: "output_text", text: said }] },
                    ],
                    usage: { input_tokens: 300, output_tokens: 20 },
                },
            ];
        if (path.endsWith("/v1/messages"))
            return [
                200,
                {
                    // A model that thinks first: what it thought isn't its answer.
                    content: [
                        { type: "thinking", thinking: '{"p1": false}' },
                        { type: "text", text: said },
                    ],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 290, cache_read_input_tokens: 10, output_tokens: 20 },
                },
            ];
        return [404, { error: "Not found" }];
    }
}
