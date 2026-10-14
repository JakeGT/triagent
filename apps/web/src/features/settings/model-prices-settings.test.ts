import { describe, expect, it } from "vitest";
import { priceName } from "./model-prices-settings";

const used = (model: string, provider: string | null) => ({ model, provider, reviews: 1, tokens: 1, price: null });

describe("priceName", () => {
    it("is the model's own id, unless another provider's model has the same id", () => {
        const meta = used("muse", "meta");
        expect(priceName(meta, [meta, used("other", "openrouter")])).toBe("muse");
        const rows = [meta, used("muse", "openrouter")];
        expect(priceName(meta, rows)).toBe("meta/muse");
        expect(priceName(rows[1] as ReturnType<typeof used>, rows)).toBe("openrouter/muse");
        // No provider recorded (old reviews): only the bare id can name it.
        const old = used("muse", null);
        expect(priceName(old, [old, meta])).toBe("muse");
    });
});
