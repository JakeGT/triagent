// Live updates must never overwrite what someone is in the middle of typing. These hooks hold on to
// the version a person started editing and say when the server's copy has moved on, so the page can
// show a "changed elsewhere" banner and let them reload when they're ready.

import { useState } from "react";

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * A form's working copy of server data. While the form is untouched it follows the server; once
 * edited it stays put, and `changedElsewhere` says the server's copy changed meanwhile.
 */
export function useDraft<T>(server: T | undefined) {
    const [base, setBase] = useState<T | undefined>(server);
    const [draft, setDraft] = useState<T | undefined>(server);
    const dirty = draft !== undefined && base !== undefined && !same(draft, base);

    // Adjusting state while rendering (not in an effect) avoids showing a stale copy for one frame.
    if (server !== undefined && base === undefined) {
        setBase(server);
        setDraft(server);
    } else if (server !== undefined && !dirty && server !== base && !same(server, base)) {
        setBase(server);
        setDraft(server);
    }

    return {
        draft,
        setDraft,
        dirty,
        changedElsewhere: dirty && server !== undefined && !same(server, base),
        /** Throw away the edits and show the server's copy. */
        reload: () => {
            setBase(server);
            setDraft(server);
        },
        /** After saving: the saved value is the new starting point. */
        saved: (value: T) => {
            setBase(value);
            setDraft(value);
        },
    };
}

/**
 * Data shown next to something being edited (an issue while a note is typed). While `editing`, the
 * version on screen stays as it was; `changedElsewhere` says a newer one arrived.
 */
export function useHeldWhileEditing<T>(live: T | undefined, editing: boolean, version: (value: T) => unknown) {
    const [held, setHeld] = useState<T | undefined>(live);
    if (!editing && held !== live) setHeld(live);
    else if (editing && held === undefined && live !== undefined) setHeld(live);
    const shown = editing ? held : live;
    const changedElsewhere = editing && live !== undefined && shown !== undefined && version(live) !== version(shown);
    return {
        shown,
        changedElsewhere,
        /** Show the newest version (keeps whatever is being typed). */
        reload: () => setHeld(live),
        /** Show a version we got back from our own change. */
        accept: (value: T) => setHeld(value),
    };
}
