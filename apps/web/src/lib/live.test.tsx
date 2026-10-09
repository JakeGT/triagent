import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveUpdates } from "./live";

class FakeEventSource {
    static CLOSED = 2;
    static made: FakeEventSource[] = [];
    readyState = 0;
    listeners = new Map<string, (e: unknown) => void>();
    readonly url: string;
    constructor(url: string) {
        this.url = url;
        FakeEventSource.made.push(this);
    }
    addEventListener(type: string, fn: (e: unknown) => void) {
        this.listeners.set(type, fn);
    }
    close() {
        this.readyState = FakeEventSource.CLOSED;
    }
    fire(type: string, e: unknown = {}) {
        this.listeners.get(type)?.(e);
    }
}

describe("useLiveUpdates", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeEventSource.made = [];
        vi.stubGlobal("EventSource", FakeEventSource);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("asks again later after the server refuses the stream (too many tabs)", () => {
        const queryClient = new QueryClient();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );
        const noop = () => {};
        const { result, unmount } = renderHook(() => useLiveUpdates("acme", noop, noop), { wrapper });
        expect(FakeEventSource.made).toHaveLength(1);
        act(() => FakeEventSource.made[0]?.fire("error", { data: "too many streams" }));
        expect(result.current).toBe("paused");
        act(() => vi.advanceTimersByTime(60_000));
        expect(FakeEventSource.made).toHaveLength(2);
        act(() => FakeEventSource.made[1]?.fire("hello"));
        expect(result.current).toBe("live");
        unmount();
    });
});
