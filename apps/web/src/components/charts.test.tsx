import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { parseAnalyticsSearch } from "@/features/analytics/search";
import { parseTokens } from "@/features/settings/instance-workspaces-settings";
import { compactCount, hours, percent, seconds, usd } from "@/lib/insights-format";
import { BarList, ChartFrame, ColumnChart, LineChart, niceMax, type Point, type Series, UsageBar } from "./charts";
import { searchModels } from "./model-picker";

const SERIES: Series[] = [
    { key: "done", label: "Done", colour: "chart-1" },
    { key: "failed", label: "Failed", colour: "chart-3" },
];
const POINTS: Point[] = [
    { label: "6 Oct", long: "6 October 2026", values: { done: 2, failed: 1 } },
    { label: "7 Oct", long: "7 October 2026", values: { done: 0, failed: 0 } },
    { label: "8 Oct", long: "8 October 2026", values: { done: 5, failed: 0 } },
];

describe("charts", () => {
    it("rounds the axis up to a clean number", () => {
        expect(niceMax(0)).toBe(1);
        expect(niceMax(7)).toBe(10);
        expect(niceMax(3)).toBe(5);
        expect(niceMax(2_340)).toBe(2_500);
        expect(niceMax(1_000)).toBe(1_000);
    });

    it("names the chart, describes it in words, has a legend, and switches to a table of the same figures", async () => {
        const user = userEvent.setup();
        render(
            <ChartFrame
                title="Reviews a day"
                summary="7 done and 1 failed."
                series={SERIES}
                table={
                    <table>
                        <tbody>
                            <tr>
                                <td>6 October 2026</td>
                                <td>2</td>
                            </tr>
                        </tbody>
                    </table>
                }
            >
                <ColumnChart points={POINTS} series={SERIES} />
            </ChartFrame>,
        );
        expect(screen.getByRole("figure", { name: "Reviews a day" })).toBeTruthy();
        expect(screen.getByRole("img", { name: "7 done and 1 failed." })).toBeTruthy();
        expect(screen.getByRole("list", { name: "Legend" }).textContent).toBe("DoneFailed");
        expect(screen.getByRole("button", { name: "Chart" }).getAttribute("aria-pressed")).toBe("true");
        await user.click(screen.getByRole("button", { name: "Table" }));
        expect(screen.getByRole("button", { name: "Table" }).getAttribute("aria-pressed")).toBe("true");
        expect(screen.queryByRole("img")).toBeNull();
        expect(screen.getByRole("cell", { name: "6 October 2026" })).toBeTruthy();
    });

    it("draws one column per period, its segments sized by value, and labels the first, middle and last", () => {
        const { container } = render(<ColumnChart points={POINTS} series={SERIES} />);
        // The axis tops out at 5, the tallest column.
        const stacks = container.querySelectorAll<HTMLElement>(".flex-col-reverse");
        expect(stacks).toHaveLength(3);
        expect(stacks[0]?.style.height).toBe("60%");
        expect(stacks[2]?.style.height).toBe("100%");
        // Empty periods draw nothing; a zero value has no segment.
        expect(stacks[1]?.children).toHaveLength(0);
        expect(stacks[2]?.children).toHaveLength(1);
        expect(container.textContent).toContain("6 Oct");
        expect(container.textContent).toContain("8 Oct");
    });

    it("shows a period's values when the pointer is over it", () => {
        const { container } = render(<LineChart points={POINTS} series={SERIES} />);
        const layer = container.querySelector<HTMLElement>(".absolute.inset-0:not(svg)") as HTMLElement;
        layer.getBoundingClientRect = () => ({
            left: 0,
            width: 300,
            top: 0,
            height: 100,
            right: 300,
            bottom: 100,
            x: 0,
            y: 0,
            toJSON() {},
        });
        fireEvent.pointerMove(layer, { clientX: 250 });
        const tip = screen.getByTestId("chart-tooltip");
        expect(tip.textContent).toContain("8 October 2026");
        expect(tip.textContent).toContain("Done5");
        fireEvent.pointerLeave(layer);
        expect(screen.queryByTestId("chart-tooltip")).toBeNull();
    });

    it("bar lists label every row, and usage bars say how much is used", () => {
        render(
            <BarList
                label="By severity"
                rows={[
                    { key: "high", label: "High", value: 3 },
                    { key: "low", label: "Low", value: 1, display: "one" },
                ]}
            />,
        );
        expect(screen.getByRole("list", { name: "By severity" }).textContent).toBe("High3Lowone");
        render(<UsageBar used={2_500_000} total={2_000_000} label="Allowance used" />);
        const bar = screen.getByRole("progressbar", { name: "Allowance used" });
        expect(bar.getAttribute("aria-valuenow")).toBe("2000000");
        expect(bar.getAttribute("aria-valuetext")).toBe("2,500,000 of 2,000,000 tokens used");
    });
});

describe("analytics helpers", () => {
    it("reads the page's scope from the URL, ignoring what isn't valid", () => {
        expect(parseAnalyticsSearch({ project: "app", branch: "main", days: "90" })).toEqual({ project: "app", branch: "main", days: 90 });
        expect(parseAnalyticsSearch({ days: "12", branch: "main" })).toEqual({});
        expect(parseAnalyticsSearch({ days: "0" })).toEqual({ days: 0 });
    });

    it("writes figures for people", () => {
        expect(compactCount(950)).toBe("950");
        expect(compactCount(12_345)).toBe("12.3K");
        expect(compactCount(2_000_000)).toBe("2M");
        expect(usd(null)).toBe("No price");
        expect(usd(7.181)).toBe("US$7.18");
        expect(usd(0.0421)).toBe("US$0.042");
        expect(seconds(190)).toBe("3 min 10 s");
        expect(seconds(null)).toBe("Not recorded");
        expect(hours(0.5)).toBe("30 min");
        expect(hours(72)).toBe("3 days");
        expect(percent(0.25)).toBe("25%");
    });

    it("reads token allowances written the way people write them", () => {
        expect(parseTokens("2,000,000")).toBe(2_000_000);
        expect(parseTokens("2m")).toBe(2_000_000);
        expect(parseTokens("500k")).toBe(500_000);
        expect(parseTokens("1.5M")).toBe(1_500_000);
        expect(parseTokens("lots")).toBeNull();
    });

    it("searches models by every word, in their id or name", () => {
        const models = [
            {
                id: "anthropic/claude-sonnet-4.5",
                name: "Anthropic: Claude Sonnet 4.5",
                price: { input: 3, output: 15, cacheRead: null },
                contextLength: null,
            },
            {
                id: "deepseek/deepseek-v3",
                name: "DeepSeek: DeepSeek V3",
                price: { input: 0.27, output: 1.1, cacheRead: null },
                contextLength: null,
            },
        ];
        expect(searchModels(models, "").length).toBe(2);
        expect(searchModels(models, "claude sonnet").map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4.5"]);
        expect(searchModels(models, "DEEPSEEK v3").map((m) => m.id)).toEqual(["deepseek/deepseek-v3"]);
        expect(searchModels(models, "gpt")).toEqual([]);
    });
});
