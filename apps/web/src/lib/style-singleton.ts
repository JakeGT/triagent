// A drop-in for react-style-singleton (used by Radix's scroll lock through react-remove-scroll). The
// original adds a <style> element, which the Content Security Policy (style-src 'self') refuses. This
// one adopts a constructed stylesheet instead: script-made CSSOM, which the policy allows.
// vite.config.ts points the package name here.

import { useEffect } from "react";

function adopt(css: string): CSSStyleSheet | null {
    if (typeof document === "undefined" || typeof CSSStyleSheet === "undefined" || !("adoptedStyleSheets" in document)) return null;
    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        return sheet;
    } catch {
        return null;
    }
}

function drop(sheet: CSSStyleSheet): void {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
}

/** Styles that stay while at least one user is mounted. */
export function stylesheetSingleton() {
    let counter = 0;
    let sheet: CSSStyleSheet | null = null;
    return {
        add(style: string) {
            if (counter === 0) sheet = adopt(style);
            counter++;
        },
        remove() {
            counter--;
            if (!counter && sheet) {
                drop(sheet);
                sheet = null;
            }
        },
    };
}

export function styleHookSingleton() {
    const sheet = stylesheetSingleton();
    return (styles: string, isDynamic?: boolean) => {
        // biome-ignore lint/correctness/useExhaustiveDependencies: same contract as the original package
        useEffect(() => {
            sheet.add(styles);
            return () => sheet.remove();
        }, [styles && isDynamic]);
    };
}

export function styleSingleton() {
    const useStyle = styleHookSingleton();
    return function Sheet({ styles, dynamic }: { styles: string; dynamic?: boolean }) {
        useStyle(styles, dynamic);
        return null;
    };
}
