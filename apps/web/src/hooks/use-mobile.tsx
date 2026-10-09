import * as React from "react";

const MOBILE_BREAKPOINT = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

// At module level, so useSyncExternalStore keeps one subscription instead of resubscribing every render.
function subscribe(callback: () => void): () => void {
    const mql = window.matchMedia(MOBILE_QUERY);
    mql.addEventListener("change", callback);
    return () => mql.removeEventListener("change", callback);
}

const isMobileNow = () => window.matchMedia(MOBILE_QUERY).matches;

export function useIsMobile() {
    return React.useSyncExternalStore(subscribe, isMobileNow, () => false);
}
