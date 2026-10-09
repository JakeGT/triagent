// The made-up review the landing page plays with: a pull request on a small shop, reviewed by three
// models. Nothing here comes from a server, and nothing a visitor does is sent anywhere.

import type { Category, Severity, Status } from "@triagent/shared";

export const MODELS = ["claude-sonnet-4.5", "gpt-5", "mistral-large"] as const;
export type SampleModel = (typeof MODELS)[number];

export const PULL_REQUEST = { number: 128, title: "Retry failed card payments", branch: "payments/retry" };

export interface SampleFinding {
    id: string;
    severity: Severity;
    category: Category;
    path: string;
    line: number;
    title: string;
    body: string;
    /** The models that found it; the first one's wording is the finding's. */
    foundBy: SampleModel[];
    /** How another model put the same thing. */
    also?: { model: SampleModel; text: string };
    suggestion?: { before: string; after: string };
    status: Status;
}

export const FINDINGS: SampleFinding[] = [
    {
        id: "ocr-3fa9c1d2",
        severity: "critical",
        category: "security",
        path: "src/api/payments.ts",
        line: 84,
        title: "The retry endpoint charges a card without checking who owns the order",
        body: "`POST /orders/:id/retry` loads the order by id alone. Anyone signed in can retry, and so charge, another customer's saved card by guessing an order number.",
        foundBy: ["claude-sonnet-4.5", "gpt-5", "mistral-large"],
        also: {
            model: "gpt-5",
            text: "Missing ownership check: `order.customerId` is never compared with the session's customer before `charge()` is called.",
        },
        suggestion: {
            before: "const order = await orders.get(id);",
            after: "const order = await orders.get(id);\nif (order.customerId !== session.customerId) throw notFound();",
        },
        status: "open",
    },
    {
        id: "ocr-71b0e4aa",
        severity: "high",
        category: "bug",
        path: "src/payments/retry.ts",
        line: 41,
        title: "A retry that times out is sent again, so a customer can be charged twice",
        body: "The request to the card processor has no idempotency key. When it times out after the processor accepted it, the next attempt is a second charge.",
        foundBy: ["claude-sonnet-4.5", "gpt-5"],
        also: {
            model: "gpt-5",
            text: "Retries are not idempotent: pass the attempt id as `Idempotency-Key` so a repeated request is the same charge.",
        },
        suggestion: {
            before: "await processor.charge({ amount, card });",
            after: "await processor.charge({ amount, card }, { idempotencyKey: attempt.id });",
        },
        status: "open",
    },
    {
        id: "ocr-0c55d9e7",
        severity: "high",
        category: "bug",
        path: "src/payments/retry.ts",
        line: 67,
        title: "The backoff doubles without a ceiling",
        body: "`delay *= 2` on every failure: by the tenth attempt the next try is over eight hours away, and the order page says “retrying” the whole time.",
        foundBy: ["mistral-large"],
        status: "open",
    },
    {
        id: "ocr-b2e8a016",
        severity: "medium",
        category: "performance",
        path: "src/jobs/retry-worker.ts",
        line: 23,
        title: "The worker loads every failed payment into memory each minute",
        body: "`payments.where({ status: 'failed' })` has no limit. It's fine today; after a processor outage it's every order from that hour at once.",
        foundBy: ["claude-sonnet-4.5", "mistral-large"],
        also: {
            model: "mistral-large",
            text: "Unbounded query in a polling loop. Page through it, or claim a batch with `LIMIT … FOR UPDATE SKIP LOCKED`.",
        },
        status: "open",
    },
    {
        id: "ocr-9d41f3b8",
        severity: "medium",
        category: "test",
        path: "test/payments/retry.test.ts",
        line: 12,
        title: "Nothing tests a retry that succeeds on the second attempt",
        body: "Every test fails all attempts or succeeds first time. The path this pull request exists for has no test.",
        foundBy: ["gpt-5"],
        status: "open",
    },
    {
        id: "ocr-5e07c2f4",
        severity: "medium",
        category: "maintainability",
        path: "src/payments/retry.ts",
        line: 15,
        title: "The retry limit is written in three places",
        body: "`5` appears here, in the worker and in the email template (“we'll try five times”). Changing one leaves the others telling customers something untrue.",
        foundBy: ["claude-sonnet-4.5", "gpt-5", "mistral-large"],
        status: "open",
    },
    {
        id: "ocr-a8163b7c",
        severity: "low",
        category: "documentation",
        path: "docs/payments.md",
        line: 58,
        title: "The docs still say failed payments are never retried",
        body: "The “Failed payments” section describes the old behaviour, and support reads this page.",
        foundBy: ["gpt-5"],
        status: "open",
    },
    {
        id: "ocr-e4d2905b",
        severity: "low",
        category: "style",
        path: "src/api/payments.ts",
        line: 102,
        title: "A debugging log line prints the card's last four digits",
        body: "`console.log('retrying', card.last4)` looks left over. It isn't a secret, but it doesn't belong in the server log.",
        foundBy: ["mistral-large"],
        status: "open",
    },
];

/** How many findings were found by exactly n models, for n = models down to 1. */
export function agreement(findings: readonly SampleFinding[]): { models: number; count: number }[] {
    return MODELS.map((_, i) => MODELS.length - i).map((n) => ({
        models: n,
        count: findings.filter((f) => f.foundBy.length === n).length,
    }));
}

/** The most urgent open finding nobody has taken: what `claim_next_issue` hands an agent. */
export function nextToClaim(findings: readonly SampleFinding[]): SampleFinding | null {
    const order: Severity[] = ["critical", "high", "medium", "low"];
    return (
        [...findings]
            .filter((f) => f.status === "open")
            .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || b.foundBy.length - a.foundBy.length)[0] ?? null
    );
}
