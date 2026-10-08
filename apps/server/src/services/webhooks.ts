// GitHub webhook deliveries. Each project has an opaque webhook address and its own secret; a delivery is
// only read once its signature (HMAC-SHA256 of the exact bytes GitHub sent) checks out.

import { ApiError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";
import { type Automation, verifySignature } from "./github/automation.ts";
import type { Settings } from "./settings.ts";

export interface DeliveryResult {
    ok: true;
    ignored?: boolean;
    note: string;
}

export class Webhooks {
    private readonly core: Core;
    private readonly settings: Settings;
    /** Acts on verified deliveries (set once the services are wired up). */
    automation: Automation | null = null;

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
        deliveryId?: string,
    ): Promise<DeliveryResult> {
        const project = await this.core.store.projects.byWebhookId(webhookId);
        if (!project) throw notFound("No project has that webhook address. Check the payload URL on GitHub.");
        const secret = await this.settings.webhookSecret(project);
        if (!secret) throw notFound("Webhooks aren't set up for this project: create a secret in its GitHub settings.");
        const body = await readBody();
        if (!verifySignature(secret, body, signature)) {
            // Counted, not kept with the deliveries: anyone can send these.
            this.automation?.refuse(
                project,
                signature
                    ? "Bad signature: the secret on GitHub doesn't match this project's, or something changed the body on the way."
                    : "No signature: set the secret in the webhook's settings on GitHub.",
            );
            throw new ApiError(401, "Bad webhook signature.");
        }
        if (!this.automation) return { ok: true, ignored: true, note: "Automatic reviews aren't available on this server." };
        return this.automation.projectDelivery(project, body, event, deliveryId ?? null);
    }
}
