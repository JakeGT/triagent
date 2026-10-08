// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the findings quote code with template literals in it

// The tutorial's example project: made-up Open Code Review reports for a small web shop, "Acme Shop",
// and the triage, reviews and runs that make every page worth showing. Nothing here came from a real
// review, a real repository or a real model.

import type { RawReport } from "../domain/report.ts";

export const EXAMPLE_NAME = "Example: Acme Shop";
export const EXAMPLE_SLUG = "example-acme-shop";
export const EXAMPLE_BRANCH = "feature/checkout-redesign";
/** The finding the tutorial opens: it has code, a suggested fix, a corrected rating and a note. */
export const EXAMPLE_ISSUE_PATH = "src/lib/email.ts";
/** Who did the example's triage and asked for its reviews: made-up people, marked as examples. */
export const EXAMPLE_PEOPLE = { sam: "Sam Lee (example)", priya: "Priya Shah (example)", ci: "CI uploads (example)" };
export const EXAMPLE_MODEL = "anthropic/claude-sonnet-4.5";

const RUN = {
    llm: { model: EXAMPLE_MODEL, provider: "openrouter" },
    manifest: { execution: { ocr_version: "v1.4.2" } },
};

const runOf = (tokens: number, files: number, elapsed: string, tools: number) => ({
    ...RUN,
    summary: {
        total_tokens: tokens,
        input_tokens: Math.round(tokens * 0.86),
        output_tokens: Math.round(tokens * 0.14),
        cache_read_tokens: Math.round(tokens * 0.35),
        files_reviewed: files,
        elapsed,
    },
    tool_calls: { total: tools, failure: 1, by_tool: { file_read: Math.round(tools * 0.6), code_search: Math.round(tools * 0.4) } },
    retry_report: { total_requests: 31, retried_requests: 1, failed_requests: 0 },
});

/** The default branch: a full review of the shop. */
export const MAIN_REPORT: RawReport = {
    status: "completed",
    session_id: "example-main",
    ...runOf(1_240_000, 38, "6m42s", 96),
    comments: [
        {
            path: "src/api/search.ts",
            start_line: 18,
            end_line: 22,
            severity: "critical",
            category: "security",
            content:
                "The search term is pasted into the SQL. `q` comes straight from the query string, so a crafted search can read or change any table, customers' details included. Pass it as a parameter instead.",
            existing_code:
                "export async function searchProducts(q: string) {\n    const sql = `SELECT * FROM products WHERE name ILIKE '%${q}%'`;\n    return db.query(sql);\n}",
            suggestion_code:
                "export async function searchProducts(q: string) {\n    const sql = \"SELECT * FROM products WHERE name ILIKE '%' || $1 || '%'\";\n    return db.query(sql, [q]);\n}",
        },
        {
            path: "src/checkout/payment.ts",
            start_line: 54,
            end_line: 56,
            severity: "critical",
            category: "security",
            content:
                "The full card number is written to the log when a payment fails. Logs are kept for 30 days and read by support staff; card numbers must never be stored. Log the payment provider's reference instead.",
            existing_code: 'logger.error("Payment failed", { card: input.cardNumber, amount, error });',
            suggestion_code: 'logger.error("Payment failed", { paymentRef: result.reference, amount, error: error.code });',
        },
        {
            path: "src/lib/money.ts",
            start_line: 4,
            end_line: 7,
            severity: "high",
            category: "bug",
            content:
                "Prices are added as floating-point numbers, so a basket of £0.10 and £0.20 totals £0.30000000000000004 and rounding drifts on large orders. Keep money in whole pence.",
            existing_code: "export function add(a: number, b: number): number {\n    return a + b;\n}",
            suggestion_code:
                "/** Amounts are whole pence. */\nexport function add(a: Pence, b: Pence): Pence {\n    return (a + b) as Pence;\n}",
        },
        {
            path: "src/auth/session.ts",
            start_line: 31,
            end_line: 31,
            severity: "high",
            category: "security",
            content:
                "The session cookie is set without `HttpOnly` or `Secure`, so any script on the page can read it and it's sent over plain HTTP. Set both, and `SameSite=Lax`.",
            existing_code: 'res.setHeader("Set-Cookie", `sid=${id}; Path=/`);',
            suggestion_code: 'res.setHeader("Set-Cookie", `sid=${id}; Path=/; HttpOnly; Secure; SameSite=Lax`);',
        },
        {
            path: "src/cart/cart.ts",
            start_line: 40,
            end_line: 44,
            severity: "high",
            category: "bug",
            content:
                "Removing an item doesn't stop at zero, so pressing minus twice gives a quantity of -1 and a negative line total, which the checkout then refunds. Clamp the quantity, and drop the line at zero.",
            existing_code: "export function decrement(cart: Cart, sku: string) {\n    cart.lines[sku].quantity -= 1;\n}",
            suggestion_code:
                "export function decrement(cart: Cart, sku: string) {\n    const line = cart.lines[sku];\n    if (!line) return;\n    line.quantity -= 1;\n    if (line.quantity <= 0) delete cart.lines[sku];\n}",
        },
        {
            path: "src/db/products.ts",
            start_line: 12,
            end_line: 19,
            severity: "high",
            category: "performance",
            content:
                "Each product's images are loaded with a query of their own, so a category page of 48 products makes 49 queries. Load the images for every product on the page in one query.",
            existing_code:
                'for (const product of products) {\n    product.images = await db.query("SELECT * FROM images WHERE product_id = $1", [product.id]);\n}',
            suggestion_code:
                'const images = await db.query("SELECT * FROM images WHERE product_id = ANY($1)", [products.map((p) => p.id)]);\nfor (const product of products) product.images = images.filter((i) => i.product_id === product.id);',
        },
        {
            path: "src/api/orders.ts",
            start_line: 77,
            end_line: 79,
            severity: "medium",
            category: "bug",
            content:
                "The stock update isn't awaited, so an error there is lost and the order is confirmed even when the stock couldn't be reserved.",
            existing_code: "reserveStock(order.lines);\nreturn confirm(order);",
            suggestion_code: "await reserveStock(order.lines);\nreturn confirm(order);",
        },
        {
            path: "src/ui/ProductList.tsx",
            start_line: 22,
            end_line: 24,
            severity: "medium",
            category: "performance",
            content:
                "The whole list is sorted again on every render, including each keystroke in the filter box. Sort it once with `useMemo`.",
            existing_code: "const sorted = [...products].sort(byPrice);",
            suggestion_code: "const sorted = useMemo(() => [...products].sort(byPrice), [products]);",
        },
        {
            path: "src/checkout/CheckoutForm.tsx",
            start_line: 1,
            end_line: 612,
            severity: "medium",
            category: "maintainability",
            content:
                "This component is over 600 lines: the address, delivery, payment and summary steps all live in one file with shared state. Split it into one component per step.",
        },
        {
            path: "src/lib/email.ts",
            start_line: 15,
            end_line: 17,
            severity: "low",
            category: "security",
            content:
                "The order confirmation email puts the customer's name into the HTML without escaping it, so a name like `<img src=x onerror=…>` ends up in the email as markup. Escape it.",
            existing_code: "const html = `<p>Thanks for your order, ${order.customerName}!</p>`;",
            suggestion_code: "const html = `<p>Thanks for your order, ${escapeHtml(order.customerName)}!</p>`;",
        },
        {
            path: "src/checkout/totals.ts",
            start_line: 9,
            end_line: 11,
            severity: "medium",
            category: "bug",
            content: "The order total adds the line prices as floating-point numbers, so totals can be a fraction of a penny out.",
            existing_code: "const total = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);",
            suggestion_code: "const total = lines.reduce((sum, l) => add(sum, times(l.price, l.quantity)), 0 as Pence);",
        },
        {
            path: "tests/cart.test.ts",
            start_line: 3,
            severity: "low",
            category: "test",
            content: "Nothing tests an empty cart, or removing the last item, which is where the negative quantity above comes from.",
        },
        {
            path: "README.md",
            start_line: 21,
            severity: "low",
            category: "documentation",
            content: "The setup steps still mention `STRIPE_TEST_KEY`, which the code no longer reads: it was renamed `PAYMENTS_KEY`.",
        },
        {
            path: "src/ui/ProductCard.tsx",
            start_line: 30,
            end_line: 34,
            severity: "low",
            category: "style",
            content:
                "Image sizes are written as bare numbers in three places. Use the theme's sizes, so cards line up with the rest of the page.",
        },
        {
            path: "src/config.ts",
            start_line: 8,
            severity: "low",
            category: "maintainability",
            content: "`ENABLE_GIFT_WRAP` isn't read anywhere in the web shop. Remove it if nothing else needs it.",
        },
    ],
    project_summary: `Acme Shop is a small online shop: a product catalogue, a cart, a checkout with card payments, and order emails.

## Top issues

1. **Search builds SQL from the query**: \`src/api/search.ts\` pastes the search term into its query.
2. **Card numbers in the logs**: \`src/checkout/payment.ts\` logs the full card number when a payment fails.
3. **Money as floating point**: \`src/lib/money.ts\` and \`src/checkout/totals.ts\` add prices as floats.

## Next steps

- **Lock down the session cookie**: \`src/auth/session.ts\` needs HttpOnly, Secure and SameSite.
- **Fix negative quantities**: \`src/cart/cart.ts\` lets quantities go below zero; add the missing tests in \`tests/cart.test.ts\`.
- **Speed up category pages**: \`src/db/products.ts\` makes a query per product.
- **Split the checkout form**: \`src/checkout/CheckoutForm.tsx\` does everything in one component.
`,
};

/** The pull request's branch: only its changes were reviewed. */
export const BRANCH_REPORT: RawReport = {
    status: "completed",
    session_id: "example-checkout-redesign",
    ...runOf(310_000, 9, "2m05s", 41),
    comments: [
        MAIN_REPORT.comments[8] as RawReport["comments"][number],
        MAIN_REPORT.comments[10] as RawReport["comments"][number],
        {
            path: "src/checkout/payment.ts",
            start_line: 88,
            end_line: 95,
            severity: "critical",
            category: "bug",
            content:
                "The new retry sends the payment again after a timeout without an idempotency key, so a slow response can charge the customer twice. Send the same key with every attempt.",
            existing_code: "for (let attempt = 0; attempt < 3; attempt++) {\n    result = await provider.charge(amount, card);\n}",
            suggestion_code:
                "const key = randomUUID();\nfor (let attempt = 0; attempt < 3; attempt++) {\n    result = await provider.charge(amount, card, { idempotencyKey: key });\n}",
        },
        {
            path: "src/checkout/AddressForm.tsx",
            start_line: 40,
            end_line: 52,
            severity: "medium",
            category: "bug",
            content:
                "The new postcode and phone inputs have placeholders but no labels, so screen readers announce them as blank edit fields.",
        },
        {
            path: "src/checkout/DeliveryOptions.tsx",
            start_line: 12,
            severity: "low",
            category: "style",
            content: "The delivery prices are formatted by hand here, unlike everywhere else, which uses `formatMoney`.",
        },
    ],
    project_summary: `The checkout redesign splits the form into steps and adds retries for card payments.

## Before merging

1. **Double charges on retry**: \`src/checkout/payment.ts\` retries without an idempotency key.
2. **Unlabelled inputs**: \`src/checkout/AddressForm.tsx\` has inputs without labels.
`,
};

/** The full scan that didn't finish: two file groups timed out. Only its review history is kept. */
export const PARTIAL_WARNINGS = [
    { type: "review_round_failed", file: "src/admin/reports.ts, src/admin/export.ts", message: "the model took too long to answer" },
    { type: "review_round_failed", file: "src/legacy/importer.ts", message: "the model took too long to answer" },
];
