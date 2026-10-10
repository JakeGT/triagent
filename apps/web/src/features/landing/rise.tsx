import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Its children rise into place the first time they're scrolled to (styles/index.css: `.landing-rise`). */
export function Rise({ children, className }: { children: ReactNode; className?: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const [shown, setShown] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        // No observer (an old browser): just show it.
        if (typeof IntersectionObserver === "undefined") return setShown(true);
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setShown(true);
                    observer.disconnect();
                }
            },
            { rootMargin: "0px 0px -10% 0px" },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    return (
        <div ref={ref} className={cn("landing-rise", className)} data-shown={shown ? "" : undefined}>
            {children}
        </div>
    );
}
