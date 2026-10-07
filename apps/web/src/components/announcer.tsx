// One polite live region, present from page load, for status messages screen readers should hear
// ("Filters applied: 12 issues", "This issue changed elsewhere"). A region added at the moment it's
// needed is often missed, so components call announce() instead of rendering their own.

import { useEffect, useState } from "react";

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

export function announce(message: string): void {
    for (const l of listeners) l(message);
}

export function Announcer() {
    const [message, setMessage] = useState("");
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const listener: Listener = (m) => {
            // Clear first, so the same message twice is announced twice.
            setMessage("");
            clearTimeout(timer);
            timer = setTimeout(() => setMessage(m), 50);
        };
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            clearTimeout(timer);
        };
    }, []);
    return (
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="announcer">
            {message}
        </div>
    );
}
