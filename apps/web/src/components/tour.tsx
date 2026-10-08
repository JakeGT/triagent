// One step of a guided tour: a card beside the part of the page it's about (marked data-tour="…"), with
// that part lit up, or a card in the middle of the screen when the part isn't showing (a phone's folded
// rail, a collapsed section). Built on Radix Popover and Dialog, so it adds no styles the Content Security
// Policy would refuse: its position and the spotlight are set through the CSSOM. Focus moves into each
// step, which screen readers announce by its name ("Step 3 of 15: Overview"); Escape skips the tour.

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** How long to wait for a step's part of the page to appear (after navigating) before showing it centred. */
const WAIT_MS = 2500;

export interface TourCardProps {
    /** The step's id, for tests and for remounting between steps. */
    id: string;
    /** The data-tour value of the part of the page the step is about; none for a step about everything. */
    anchor?: string;
    title: string;
    children: ReactNode;
    index: number;
    total: number;
    onBack?: () => void;
    onNext: () => void;
    onSkip: () => void;
    nextLabel?: string;
    nextDisabled?: boolean;
    /** Extra buttons before Next (e.g. "Skip this step"). */
    actions?: ReactNode;
}

function visible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return typeof el.checkVisibility === "function" ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : true;
}

/** The step's element once it's on the page and showing; null if it doesn't appear in time. */
function useTarget(anchor: string | undefined): { element: Element | null; settled: boolean } {
    const [state, setState] = useState<{ element: Element | null; settled: boolean }>({ element: null, settled: !anchor });
    useEffect(() => {
        if (!anchor) {
            setState({ element: null, settled: true });
            return;
        }
        setState({ element: null, settled: false });
        const find = () => {
            const el = document.querySelector(`[data-tour="${CSS.escape(anchor)}"]`);
            return el && visible(el) ? el : null;
        };
        const started = Date.now();
        let frame = 0;
        const look = () => {
            const el = find();
            if (el) setState({ element: el, settled: true });
            else if (Date.now() - started > WAIT_MS) setState({ element: null, settled: true });
            else frame = window.setTimeout(look, 100);
        };
        look();
        return () => window.clearTimeout(frame);
    }, [anchor]);
    return state;
}

/**
 * What the card sits beside: the element, or for one taller than about half the screen (a long list), a
 * band at the top of the part showing, so the card stays on screen.
 */
function anchorFor(element: Element) {
    return {
        contextElement: element,
        getBoundingClientRect() {
            const r = element.getBoundingClientRect();
            const top = Math.max(r.top, 0);
            const bottom = Math.min(r.bottom, window.innerHeight);
            if (bottom - top <= window.innerHeight * 0.45) return r;
            return DOMRect.fromRect({ x: r.x, y: top, width: r.width, height: 56 });
        },
    };
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** A ring around the element and a dimmed page around it. It never takes clicks: the page stays usable. */
function Spotlight({ element }: { element: Element }) {
    const box = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        let frame = 0;
        const place = () => {
            const r = element.getBoundingClientRect();
            const el = box.current;
            if (el) {
                el.style.top = `${r.top - 4}px`;
                el.style.left = `${r.left - 4}px`;
                el.style.width = `${r.width + 8}px`;
                el.style.height = `${r.height + 8}px`;
            }
            frame = requestAnimationFrame(place);
        };
        place();
        return () => cancelAnimationFrame(frame);
    }, [element]);
    return (
        <div
            ref={box}
            aria-hidden="true"
            data-tour-spotlight=""
            className="pointer-events-none fixed z-40 rounded-lg shadow-[0_0_0_9999px_rgb(0_0_0/0.35)] ring-2 ring-primary ring-offset-2 ring-offset-background"
        />
    );
}

function Card({ props, mode, titleId, bodyId }: { props: TourCardProps; mode: "anchored" | "centred"; titleId: string; bodyId: string }) {
    const { index, total, onBack, onNext, onSkip, nextLabel, nextDisabled, actions, title, children } = props;
    const Title = mode === "centred" ? DialogTitle : "h2";
    const Body = mode === "centred" ? DialogDescription : "div";
    return (
        <div className="grid gap-3" data-tour-card="" data-tour-mode={mode} data-tour-step={props.id} data-tour-anchor={props.anchor}>
            <div className="grid gap-1">
                <p className="text-xs font-medium text-muted-foreground" id={`${titleId}-count`}>
                    Step {index + 1} of {total}
                </p>
                <Title id={titleId} className="text-base leading-tight font-semibold">
                    {title}
                </Title>
            </div>
            <Body
                id={bodyId}
                className="grid gap-2 text-sm text-muted-foreground [&_kbd]:rounded [&_kbd]:border [&_kbd]:px-1 [&_strong]:text-foreground"
            >
                {children}
            </Body>
            <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button type="button" variant="ghost" size="sm" onClick={onSkip}>
                    Skip tour
                </Button>
                <div className="ms-auto flex flex-wrap justify-end gap-2">
                    {onBack && (
                        <Button type="button" variant="outline" size="sm" onClick={onBack}>
                            Back
                        </Button>
                    )}
                    {actions}
                    <Button type="button" size="sm" onClick={onNext} disabled={nextDisabled} data-tour-next="">
                        {nextLabel ?? "Next"}
                    </Button>
                </div>
            </div>
        </div>
    );
}

export function TourCard(props: TourCardProps) {
    const { element, settled } = useTarget(props.anchor);
    const titleId = useId();
    const bodyId = useId();
    const content = useRef<HTMLDivElement>(null);

    // Bring the part of the page into view, then put focus in the card so its name is read out.
    useEffect(() => {
        if (!settled) return;
        const tall = element && element.getBoundingClientRect().height > window.innerHeight * 0.6;
        element?.scrollIntoView({ block: tall ? "start" : "center", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
        const t = window.setTimeout(() => content.current?.focus({ preventScroll: true }), 50);
        return () => window.clearTimeout(t);
    }, [settled, element]);

    const anchorRef = useMemo(() => ({ current: element ? anchorFor(element) : null }), [element]);
    if (!settled) return null;
    const labelledBy = `${titleId}-count ${titleId}`;
    if (!element)
        return (
            <Dialog open onOpenChange={(open) => !open && props.onSkip()}>
                <DialogContent
                    ref={content}
                    tabIndex={-1}
                    showCloseButton={false}
                    aria-labelledby={labelledBy}
                    aria-describedby={bodyId}
                    className="max-w-md outline-none"
                    data-tour-dialog=""
                    onInteractOutside={(e) => e.preventDefault()}
                    onOpenAutoFocus={(e) => e.preventDefault()}
                >
                    <Card props={props} mode="centred" titleId={titleId} bodyId={bodyId} />
                </DialogContent>
            </Dialog>
        );
    return (
        <>
            <Spotlight element={element} />
            <PopoverPrimitive.Root open modal={false}>
                <PopoverPrimitive.Anchor virtualRef={anchorRef as React.RefObject<ReturnType<typeof anchorFor>>} />
                <PopoverPrimitive.Portal>
                    <PopoverPrimitive.Content
                        ref={content}
                        tabIndex={-1}
                        role="dialog"
                        aria-modal="false"
                        aria-labelledby={labelledBy}
                        aria-describedby={bodyId}
                        side="bottom"
                        align="start"
                        sideOffset={12}
                        collisionPadding={12}
                        avoidCollisions
                        data-tour-dialog=""
                        className={cn(
                            "z-50 w-[min(24rem,calc(100vw-1.5rem))] rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg outline-none",
                            "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        )}
                        onOpenAutoFocus={(e) => e.preventDefault()}
                        onInteractOutside={(e) => e.preventDefault()}
                        onFocusOutside={(e) => e.preventDefault()}
                        onEscapeKeyDown={(e) => {
                            e.preventDefault();
                            props.onSkip();
                        }}
                    >
                        <Card props={props} mode="anchored" titleId={titleId} bodyId={bodyId} />
                    </PopoverPrimitive.Content>
                </PopoverPrimitive.Portal>
            </PopoverPrimitive.Root>
        </>
    );
}
