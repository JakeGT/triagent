// The hero's moving picture: one pull request, reviewed by three models, merged into one list and
// triaged by an agent and a person. A fixed storyboard on a timer, drawn as a panel of the app in the
// reader's theme. It is laid out by its own width (a container query), since it sits beside the headline on
// a wide screen and under it on a narrow one. It can be paused, and starts paused on its last frame for
// people who've asked their system for less motion.

import { Bot, Check, Pause, Play, RotateCcw, User } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SeverityMark, StatusMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FINDINGS, MODELS, PULL_REQUEST, type SampleFinding, type SampleModel } from "./sample";

const SHOWN = FINDINGS.slice(0, 4);
const LAST = 8;
const STEP_MS = 1700;

const STEPS = ["Opened", "Review", "One list", "Triage"] as const;
/** Every model's findings before merging: one for each model that found each finding. */
const RAW = SHOWN.reduce((n, f) => n + f.foundBy.length, 0);
/** Which of the four steps a frame belongs to. */
const stepOf = (frame: number) => (frame === 0 ? 0 : frame <= 3 ? 1 : frame === 4 ? 2 : 3);

const file = (f: SampleFinding) => `${f.path.slice(f.path.lastIndexOf("/") + 1)}:${f.line}`;

function FoundBy({ finding, className }: { finding: SampleFinding; className?: string }) {
    return (
        <span className={cn("flex shrink-0 items-center gap-1", className)} title={finding.foundBy.join(", ")}>
            {MODELS.map((m) => (
                <span
                    key={m}
                    className={cn("size-2 rounded-full", finding.foundBy.includes(m) ? "bg-primary" : "border border-foreground/25")}
                />
            ))}
            <span className="sr-only">
                Found by {finding.foundBy.length} of {MODELS.length} models
            </span>
        </span>
    );
}

/** One model's review: its name, then what it found, side by side where there's room and wrapping where not. */
function Lane({ model, rows }: { model: SampleModel; rows: number }) {
    const mine = SHOWN.filter((f) => f.foundBy.includes(model));
    return (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-1.5 rounded-md border bg-background p-2.5">
            <p className="truncate font-mono text-xs text-muted-foreground">{model}</p>
            <div className="flex min-h-4 flex-wrap items-center gap-x-5 gap-y-1.5">
                {mine.slice(0, rows).map((f) => (
                    <p
                        key={f.id}
                        className="flex min-w-0 animate-in items-center gap-2 text-xs duration-500 fade-in slide-in-from-bottom-1"
                    >
                        <SeverityMark severity={f.severity} className="shrink-0 text-xs" />
                        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{file(f)}</span>
                    </p>
                ))}
                {rows > 0 && rows < 3 && <p className="h-4 w-16 animate-pulse rounded bg-muted" aria-hidden="true" />}
            </div>
        </div>
    );
}

/** What has happened to each merged finding by `frame`. */
function triageAt(frame: number, index: number): { status: SampleFinding["status"]; note: ReactNode } {
    if (index === 0 && frame === 5)
        return {
            status: "in_progress",
            note: (
                <>
                    <Bot className="me-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
                    Claimed by an agent
                </>
            ),
        };
    if (index === 0 && frame >= 6)
        return {
            status: "resolved",
            note: (
                <>
                    <Check className="me-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
                    Fixed in <span className="font-mono">4f2c1ab</span>
                </>
            ),
        };
    if (index === 2 && frame >= 7)
        return {
            status: "wont_fix",
            note: (
                <>
                    <User className="me-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
                    Priya: capped by the job queue already
                </>
            ),
        };
    return { status: "open", note: null };
}

export function ReviewStage() {
    const [frame, setFrame] = useState(0);
    const [playing, setPlaying] = useState(true);

    // Less motion asked for: show where the story ends, and leave playing it to the person.
    useEffect(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            setPlaying(false);
            setFrame(LAST);
        }
    }, []);
    useEffect(() => {
        if (!playing) return;
        const timer = setInterval(() => setFrame((f) => (f >= LAST ? 0 : f + 1)), STEP_MS);
        return () => clearInterval(timer);
    }, [playing]);

    const step = stepOf(frame);
    const lanes = frame >= 1 && frame <= 3;
    return (
        <section
            aria-label="A review, from pull request to triage (a demonstration with made-up data)"
            className="@container min-w-0 overflow-hidden rounded-lg border bg-card text-start"
            data-testid="review-stage"
        >
            <div className="flex items-center gap-3 border-b px-4 py-2">
                <p className="min-w-0 flex-1 truncate text-sm font-medium">
                    <span className="font-mono text-muted-foreground">#{PULL_REQUEST.number}</span> {PULL_REQUEST.title}
                </p>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7"
                    onClick={() => {
                        if (!playing && frame >= LAST) setFrame(0);
                        setPlaying(!playing);
                    }}
                >
                    {playing ? <Pause /> : frame >= LAST ? <RotateCcw /> : <Play />}
                    {playing ? "Pause" : frame >= LAST ? "Play again" : "Play"}
                </Button>
            </div>

            <ol className="flex justify-between gap-1 border-b px-2 py-2 text-xs @md:grid @md:grid-cols-4 @md:px-2.5">
                {STEPS.map((label, i) => (
                    <li
                        key={label}
                        aria-current={i === step ? "step" : undefined}
                        className={cn(
                            "flex min-w-0 items-center gap-1.5 rounded px-1 py-1 transition-colors duration-300 @md:px-1.5",
                            i === step ? "bg-primary/15 font-medium text-foreground" : "text-muted-foreground",
                        )}
                    >
                        <span
                            className={cn(
                                "grid size-4 shrink-0 place-items-center rounded-full font-mono text-xs font-semibold @md:size-5",
                                i < step
                                    ? "bg-st-resolved text-background"
                                    : i === step
                                      ? "bg-primary text-primary-foreground"
                                      : "bg-muted",
                            )}
                            aria-hidden="true"
                        >
                            {i < step ? <Check className="size-3" /> : i + 1}
                        </span>
                        <span className="min-w-0 truncate">{label}</span>
                    </li>
                ))}
            </ol>

            <div className="grid min-h-[24rem] grid-cols-[minmax(0,1fr)] content-start gap-3 p-4 @md:min-h-[18.5rem]">
                {frame === 0 && (
                    <div className="grid animate-in content-start gap-1.5 duration-500 fade-in">
                        <p className="text-base font-medium">A pull request is ready for review.</p>
                        <p className="text-sm text-muted-foreground">
                            Reviewing with <span className="font-mono break-words">{MODELS.join(", ")}</span>…
                        </p>
                    </div>
                )}
                {lanes && (
                    <div className="grid gap-1.5">
                        {MODELS.map((m) => (
                            <Lane key={m} model={m} rows={frame} />
                        ))}
                    </div>
                )}
                {frame >= 4 && (
                    <ul className="-my-2.5 grid animate-in grid-cols-[minmax(0,1fr)] divide-y duration-500 fade-in">
                        {SHOWN.map((f, i) => {
                            const t = triageAt(frame, i);
                            return (
                                // Two lines, each: what shrinks on the left, what's fixed on the right. The sentence is cut
                                // short with an ellipsis where there's width for most of it, and runs to a second line
                                // where there isn't.
                                <li key={f.id} className="grid min-w-0 gap-1.5 py-2.5">
                                    <p className="flex min-w-0 items-start gap-2.5 text-sm @md:items-center">
                                        <SeverityMark severity={f.severity} className="shrink-0 text-xs @max-md:mt-0.5" />
                                        {/* Dealt with: struck through, not dimmed (dimming would cost the marks their contrast). */}
                                        <span
                                            className={cn(
                                                "min-w-0 flex-1 @max-md:line-clamp-2 @md:truncate",
                                                (t.status === "resolved" || t.status === "wont_fix") &&
                                                    "text-muted-foreground line-through decoration-foreground/40",
                                            )}
                                        >
                                            {f.title}
                                        </span>
                                        <FoundBy finding={f} className="@max-md:mt-1.5" />
                                    </p>
                                    <p className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground @md:flex-nowrap">
                                        <StatusMark status={t.status} className="shrink-0 text-xs" />
                                        {/* Who dealt with it: beside the status, or on a line of its own where that would cut it short. */}
                                        {t.note && (
                                            <span className="min-w-0 animate-in truncate duration-300 fade-in @max-md:order-last @max-md:basis-full">
                                                {t.note}
                                            </span>
                                        )}
                                        <span className="ms-auto shrink-0 font-mono">{file(f)}</span>
                                    </p>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <p className="border-t px-4 py-2.5 text-sm text-muted-foreground">
                {frame < 4
                    ? "Each model reviews the same change, with its own key."
                    : frame === 4
                      ? `${RAW} findings from three models are ${SHOWN.length} to triage: the dots say who found each.`
                      : "People and agents work one list. Triage carries over to the next review."}
            </p>
        </section>
    );
}
