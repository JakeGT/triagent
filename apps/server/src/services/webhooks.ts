// GitHub webhook deliveries. Each project has an opaque webhook address and its own secret; a delivery is
// only read once its signature (HMAC-SHA256 of the exact bytes GitHub sent) checks out.

import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";
import type { Settings } from "./settings.ts";

export interface DeliveryResult {
    ok: true;
    ignored?: boolean;
    note: string;
}

export class Webhooks {
    private readonly core: Core;
    private readonly settings: Settings;

    constructor(core: Core, settings: Settings) {
        this.core = core;
        this.settings = settings;
    }

    /** `readBody` is only called once the address is known to belong to a project with a secret. */
    async deliver(
        webhookId: string,
        readBody: () => Promise<Buffer>,
        signature: string | undefined,
        event: string | undefined,
    ): Promise<DeliveryResult> {
        const project = await this.core.store.projects.byWebhookId(webhookId);
        if (!project) throw notFound("No project has that webhook address. Check the payload URL on GitHub.");
        const secret = await this.settings.webhookSecret(project);
        if (!secret) throw notFound("Webhooks aren't set up for this project: create a secret in its GitHub settings.");
        const body = await readBody();
        const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
        const given = Buffer.from(String(signature ?? ""));
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ApiError(401, "Bad webhook signature.");

        let payload: { repository?: { full_name?: string } } | null = null;
        try {
            payload = JSON.parse(body.toString("utf8"));
        } catch {
            // not JSON: nothing to act on
        }
        const repo = payload?.repository?.full_name;
        const connected = project.repoUrl?.replace(/^https:\/\/[^/]+\//, "");
        if (repo && connected && repo.toLowerCase() !== connected.toLowerCase()) {
            return { ok: true, ignored: true, note: `It's for ${repo}, but this project is connected to ${connected}.` };
        }
        if (event === "ping") return { ok: true, note: "Webhook works." };
        // Reviewing pull requests from webhook events arrives with the GitHub App.
        return {
            ok: true,
            ignored: true,
            note: `Received ${event ?? "an event"}; automatic reviews aren't available in this version yet.`,
        };
    }
}
