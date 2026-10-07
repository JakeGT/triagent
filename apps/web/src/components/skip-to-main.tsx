/** The first thing keyboard users reach: jumps past the sidebar (from shadcn-admin). */
export function SkipToMain() {
    return (
        <a
            className="fixed start-44 z-[999] -translate-y-52 bg-primary px-4 py-2 text-sm font-medium whitespace-nowrap text-primary-foreground shadow-sm transition focus:translate-y-3 focus-visible:ring-2 focus-visible:ring-ring"
            href="#content"
        >
            Skip to content
        </a>
    );
}
