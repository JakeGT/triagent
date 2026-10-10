// The hero's plaything: three reviewers, each with a switch, and the one list their findings become.
// Switching a reviewer on sends each of its findings across to its row in the list, where it fills that
// reviewer's dot; switching it off takes them back, and the list says what you'd have missed. It plays
// itself once when the page opens (one reviewer after another), then it's the reader's. With less motion
// asked for, all three are on from the start and nothing flies.

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { SeverityMark } from "@/components/marks";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { FINDINGS, MODELS, PULL_REQUEST, type SampleFinding, type SampleModel } from "./sample";

/** One model's finding, on its way to or already in the list. */
const key = (model: SampleModel, finding: SampleFinding) => `${model}|${finding.id}`;
const file = (f: SampleFinding) => `${f.path.slice(f.path.lastIndexOf("/") + 1)}:${f.line}`;
const of = (model: SampleModel) => FINDINGS.filter((f) => f.foundBy.includes(model));

const FLIGHT_MS = 560;
const STAGGER_MS = 90;
/** When each reviewer is switched on as the page opens. */
const INTRO_MS = [450, 1750, 3050];

/** Where an element is laid out inside `root`, ignoring any transform it or its parents are mid-way through. */
function placeIn(el: HTMLElement, root: HTMLElement): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (let node: HTMLElement | null = el; node && node !== root; node = node.offsetParent as HTMLElement | null) {
        x += node.offsetLeft;
        y += node.offsetTop;
    }
    return { x, y };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function Bench() {
    const [on, setOn] = useState<ReadonlySet<SampleModel>>(new Set());
    const [landed, setLanded] = useState<ReadonlySet<string>>(new Set());
    const root = useRef<HTMLDivElement>(null);
    const chips = useRef(new Map<string, HTMLElement>());
    const dots = useRef(new Map<string, HTMLElement>());
    const rowEls = useRef(new Map<string, HTMLElement>());
    const tops = useRef(new Map<string, number>());
    /** Flights still in the air, by reviewer, so switching one off calls its findings back. */
    const flying = useRef(new Map<SampleModel, Set<() => void>>());
    const intro = useRef<ReturnType<typeof setTimeout>[]>([]);
    const still = useRef(false);

    const land = useCallback((keys: string[]) => setLanded((old) => new Set([...old, ...keys])), []);

    const fly = useCallback(
        (model: SampleModel) => {
            const stage = root.current;
            const mine = of(model);
            if (!stage || still.current || typeof stage.animate !== "function") return land(mine.map((f) => key(model, f)));
            const cancels = new Set<() => void>();
            flying.current.set(model, cancels);
            mine.forEach((f, i) => {
                const k = key(model, f);
                const chip = chips.current.get(k);
                const dot = dots.current.get(k);
                if (!chip || !dot) {
                    land([k]);
                    return;
                }
                const from = placeIn(chip, stage);
                const to = placeIn(dot, stage);
                const ghost = chip.cloneNode(true) as HTMLElement;
                ghost.removeAttribute("data-chip");
                ghost.setAttribute("aria-hidden", "true");
                ghost.classList.add("absolute", "z-10", "m-0", "pointer-events-none", "bg-card", "shadow-md");
                ghost.style.left = `${from.x}px`;
                ghost.style.top = `${from.y}px`;
                ghost.style.width = `${chip.offsetWidth}px`;
                stage.append(ghost);
                // It ends on its dot, shrunk to about the dot's size.
                const dx = to.x - from.x - chip.offsetWidth / 2 + dot.offsetWidth / 2;
                const dy = to.y - from.y - chip.offsetHeight / 2 + dot.offsetHeight / 2;
                const flight = ghost.animate(
                    [
                        { transform: "translate(0, 0) scale(1)", opacity: 1 },
                        { transform: `translate(${dx * 0.55}px, ${dy * 0.35}px) scale(1.04)`, opacity: 1, offset: 0.45 },
                        { transform: `translate(${dx}px, ${dy}px) scale(0.12)`, opacity: 0.5 },
                    ],
                    { duration: FLIGHT_MS, delay: i * STAGGER_MS, easing: "cubic-bezier(0.5, 0, 0.2, 1)", fill: "both" },
                );
                const cancel = () => {
                    flight.cancel();
                    ghost.remove();
                };
                cancels.add(cancel);
                flight.onfinish = () => {
                    ghost.remove();
                    cancels.delete(cancel);
                    land([k]);
                };
            });
        },
        [land],
    );

    const switchOn = useCallback(
        (model: SampleModel) => {
            // The rows it adds have to be in the page before anything can fly to them.
            flushSync(() => setOn((old) => new Set([...old, model])));
            fly(model);
        },
        [fly],
    );
    const switchOff = useCallback((model: SampleModel) => {
        for (const cancel of flying.current.get(model) ?? []) cancel();
        flying.current.delete(model);
        setOn((old) => new Set([...old].filter((m) => m !== model)));
        setLanded((old) => new Set([...old].filter((k) => !k.startsWith(`${model}|`))));
    }, []);
    const stopIntro = useCallback(() => {
        for (const t of intro.current) clearTimeout(t);
        intro.current = [];
    }, []);

    useEffect(() => {
        still.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (still.current) {
            setOn(new Set(MODELS));
            setLanded(new Set(MODELS.flatMap((m) => of(m).map((f) => key(m, f)))));
            return;
        }
        intro.current = MODELS.map((m, i) => setTimeout(() => switchOn(m), INTRO_MS[i]));
        const air = flying.current;
        return () => {
            stopIntro();
            for (const cancels of air.values()) for (const cancel of cancels) cancel();
        };
    }, [switchOn, stopIntro]);

    const rows = FINDINGS.filter((f) => f.foundBy.some((m) => on.has(m)));
    const raw = [...on].reduce((n, m) => n + of(m).length, 0);
    const missed = FINDINGS.length - rows.length;
    const off = MODELS.filter((m) => !on.has(m));

    // Rows that were already there slide to their new place when one arrives above them, or leaves.
    useLayoutEffect(() => {
        const next = new Map<string, number>();
        for (const [id, el] of rowEls.current) {
            next.set(id, el.offsetTop);
            const before = tops.current.get(id);
            if (before !== undefined && before !== el.offsetTop && !still.current && typeof el.animate === "function")
                el.animate([{ transform: `translateY(${before - el.offsetTop}px)` }, { transform: "none" }], {
                    duration: 260,
                    easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
                });
        }
        tops.current = next;
    });

    let summary: ReactNode;
    if (on.size === 0) summary = "Switch a reviewer on.";
    else
        summary = (
            <>
                <b className="font-mono text-base font-semibold text-foreground tabular-nums">{raw}</b> {raw === 1 ? "finding" : "findings"}{" "}
                from {plural(on.size, "reviewer")},{" "}
                <b className="font-mono text-base font-semibold text-foreground tabular-nums">{rows.length}</b> to triage
            </>
        );

    return (
        <section
            ref={root}
            aria-label="Three reviewers and the one list their findings become (a demonstration with made-up data)"
            className="relative grid grid-cols-[minmax(0,1fr)] gap-4 text-start lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] lg:gap-6"
            data-testid="bench"
        >
            <ul className="grid content-start gap-3 max-lg:sm:grid-cols-3" aria-label="Reviewers">
                {MODELS.map((model) => {
                    const mine = of(model);
                    const active = on.has(model);
                    const fresh = mine.filter((f) => !f.foundBy.some((m) => m !== model && on.has(m))).length;
                    const id = `bench-${model}`;
                    return (
                        <li
                            key={model}
                            className={cn(
                                "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2.5 rounded-lg border p-3 transition-colors duration-200",
                                active ? "bg-card" : "border-dashed bg-transparent",
                            )}
                        >
                            <div className="flex min-w-0 items-center gap-2.5">
                                <Switch
                                    id={id}
                                    checked={active}
                                    onCheckedChange={(next) => {
                                        stopIntro();
                                        if (next) switchOn(model);
                                        else switchOff(model);
                                    }}
                                />
                                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer truncate font-mono text-sm font-semibold">
                                    {model}
                                </label>
                            </div>
                            <p className="text-sm text-muted-foreground" data-testid={`bench-note-${model}`}>
                                {active
                                    ? `${plural(mine.length, "finding")}, ${fresh === 0 ? "none" : fresh} that only it found`
                                    : "Off. Its review isn't in the list."}
                            </p>
                            {/* Always there, so the page doesn't move when a reviewer is switched: only seen while it's on. */}
                            <ul className={cn("flex flex-wrap gap-1.5 transition-opacity duration-200", !active && "invisible opacity-0")}>
                                {mine.map((f) => (
                                    <li
                                        key={f.id}
                                        data-chip
                                        ref={(el) => {
                                            if (el) chips.current.set(key(model, f), el);
                                            else chips.current.delete(key(model, f));
                                        }}
                                        className="flex items-center gap-1.5 rounded border bg-background px-1.5 py-0.5"
                                    >
                                        <SeverityMark severity={f.severity} className="text-xs [&>span]:sr-only" />
                                        <span className="font-mono text-xs text-muted-foreground">{file(f)}</span>
                                    </li>
                                ))}
                            </ul>
                        </li>
                    );
                })}
            </ul>

            <div className="@container grid min-w-0 grid-cols-[minmax(0,1fr)] content-start overflow-hidden rounded-lg border bg-card">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-4 py-2.5">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">
                        <span className="font-mono text-muted-foreground">#{PULL_REQUEST.number}</span> {PULL_REQUEST.title}
                    </p>
                    <p className="text-sm text-muted-foreground" data-testid="bench-summary">
                        {summary}
                    </p>
                </div>
                {/* As tall as the whole list, whichever reviewers are on, so nothing below it moves. */}
                <ul className="grid min-h-[26.5rem] grid-cols-[minmax(0,1fr)] content-start @2xl:min-h-[21.5rem]" data-testid="bench-list">
                    {rows.map((f) => (
                        <li
                            key={f.id}
                            ref={(el) => {
                                if (el) rowEls.current.set(f.id, el);
                                else rowEls.current.delete(f.id);
                            }}
                            className="grid min-w-0 animate-in grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b px-4 py-2 duration-300 nth-8:border-b-0 fade-in @2xl:h-[2.6875rem] @2xl:grid-cols-[5.5rem_minmax(0,1fr)_auto_auto] @2xl:py-0"
                        >
                            <SeverityMark severity={f.severity} className="text-xs @max-2xl:col-span-2" />
                            <span className="min-w-0 truncate text-sm font-medium">{f.title}</span>
                            <span className="font-mono text-xs text-muted-foreground @max-2xl:hidden">{file(f)}</span>
                            <span className="flex shrink-0 items-center gap-1.5">
                                {MODELS.map((m) => {
                                    const found = f.foundBy.includes(m);
                                    const k = key(m, f);
                                    return (
                                        <span
                                            key={m}
                                            aria-hidden="true"
                                            ref={(el) => {
                                                if (!found) return;
                                                if (el) dots.current.set(k, el);
                                                else dots.current.delete(k);
                                            }}
                                            className={cn(
                                                "size-2.5 rounded-full border transition-[background-color,border-color,scale] duration-300",
                                                landed.has(k) ? "scale-100 border-primary bg-primary" : "border-foreground/30",
                                            )}
                                        />
                                    );
                                })}
                                <span className="sr-only">
                                    Found by {f.foundBy.filter((m) => on.has(m)).length} of {MODELS.length} reviewers
                                </span>
                            </span>
                        </li>
                    ))}
                </ul>
                <p className="border-t px-4 py-2.5 text-sm text-muted-foreground" role="status" data-testid="bench-missed">
                    {on.size === 0
                        ? "Each reviewer reads the same pull request, with its own key."
                        : missed === 0
                          ? "A dot for each reviewer that found it. Switch one off to see what it alone caught."
                          : `With ${off.join(" and ")} off, ${plural(missed, "finding is", "findings are")} missed.`}
                </p>
            </div>
        </section>
    );
}
