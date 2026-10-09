// The hero's moving picture: one pull request, reviewed by three models, merged into one list and
// triaged by an agent and a person. A fixed storyboard on a timer, always dark like a console (the `dark`
// class gives its subtree the dark theme's colours). It can be paused, and starts paused on its last frame
// for people who've asked their system for less motion.

import { Bot, Check, Pause, Play, RotateCcw, User } from "lucide-react";
import { useEffect, useState } from "react";
import { SeverityMark, StatusMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FINDINGS, MODELS, PULL_REQUEST, type SampleFinding, type SampleModel } from "./sample";

const SHOWN = FINDINGS.slice(0, 4);
const LAST = 8;
const STEP_MS = 1700;

const STEPS = ["Pull request", "Three models review", "One list", "Triage"] as const;
/** Every model's findings before merging: one for each model that found each finding. */
const RAW = SHOWN.reduce((n, f) => n + f.foundBy.length, 0);
/** Which of the four steps a frame belongs to. */
const stepOf = (frame: number) => (frame === 0 ? 0 : frame <= 3 ? 1 : frame === 4 ? 2 : 3);

const file = (f: SampleFinding) => `${f.path.slice(f.path.lastIndexOf("/") + 1)}:${f.line}`;

function FoundBy({ finding }: { finding: SampleFinding }) {
    return (
        <span className="flex items-center gap-1" title={finding.foundBy.join(", ")}>
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

function Lane({ model, rows }: { model: SampleModel; rows: number }) {
    const mine = SHOWN.filter((f) => f.foundBy.includes(model));
    return (
        <div className="grid content-start gap-1.5 rounded-lg border border-border bg-background/60 p-2.5">
            <p className="truncate font-mono text-[0.7rem] text-muted-foreground">{model}</p>
            {mine.slice(0, rows).map((f) => (
                <p key={f.id} className="flex animate-in items-center gap-2 text-xs duration-500 fade-in slide-in-from-bottom-1">
                    <SeverityMark severity={f.severity} className="text-[0.7rem]" />
                    <span className="truncate font-mono text-[0.7rem] text-muted-foreground">{file(f)}</span>
                </p>
            ))}
            {rows > 0 && rows < 3 && <p className="h-4 w-16 animate-pulse rounded bg-muted" aria-hidden="true" />}
        </div>
    );
}

/** What has happened to each merged finding by `frame`. */
function triageAt(frame: number, index: number): { status: SampleFinding["status"]; note: React.ReactNode } {
    if (index === 0 && frame === 5)
        return {
            status: "in_progress",
            note: (
                <>
                    <Bot className="size-3.5" aria-hidden="true" /> Claimed by an agent
                </>
            ),
        };
    if (index === 0 && frame >= 6)
        return {
            status: "resolved",
            note: (
                <>
                    <Check className="size-3.5" aria-hidden="true" /> Fixed in <span className="font-mono">4f2c1ab</span>
                </>
            ),
        };
    if (index === 2 && frame >= 7)
        return {
            status: "wont_fix",
            note: (
                <>
                    <User className="size-3.5" aria-hidden="true" /> Priya: capped by the job queue already
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
            className="dark overflow-hidden rounded-xl border border-white/10 bg-[#11161a] text-foreground shadow-2xl shadow-black/30"
            data-testid="review-stage"
        >
            <div className="flex items-center gap-3 border-b border-border px-3 py-2">
                <span className="flex gap-1.5" aria-hidden="true">
                    <span className="size-2.5 rounded-full bg-sev-critical/80" />
                    <span className="size-2.5 rounded-full bg-sev-medium/80" />
                    <span className="size-2.5 rounded-full bg-st-resolved/80" />
                </span>
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    <span className="font-mono">#{PULL_REQUEST.number}</span> {PULL_REQUEST.title}
                </p>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                        if (!playing && frame >= LAST) setFrame(0);
                        setPlaying(!playing);
                    }}
                >
                    {playing ? <Pause /> : frame >= LAST ? <RotateCcw /> : <Play />}
                    {playing ? "Pause" : frame >= LAST ? "Play again" : "Play"}
                </Button>
            </div>

            <ol className="grid grid-cols-4 gap-1 border-b border-border px-3 py-2 text-[0.7rem]">
                {STEPS.map((label, i) => (
                    <li
                        key={label}
                        aria-current={i === step ? "step" : undefined}
                        className={cn(
                            "flex items-center gap-1.5 rounded px-1.5 py-1 transition-colors duration-300",
                            i === step ? "bg-primary/15 text-foreground" : i < step ? "text-muted-foreground" : "text-muted-foreground/60",
                        )}
                    >
                        <span
                            className={cn(
                                "grid size-4 shrink-0 place-items-center rounded-full text-[0.6rem] font-semibold",
                                i < step ? "bg-st-resolved text-[#11161a]" : i === step ? "bg-primary text-primary-foreground" : "bg-muted",
                            )}
                            aria-hidden="true"
                        >
                            {i < step ? <Check className="size-3" /> : i + 1}
                        </span>
                        <span className="truncate">{label}</span>
                    </li>
                ))}
            </ol>

            <div className="grid min-h-[17.5rem] content-start gap-3 p-3 sm:min-h-[16rem]">
                {frame === 0 && (
                    <div className="grid animate-in place-items-center gap-2 py-10 text-center duration-500 fade-in">
                        <p className="text-sm">A pull request is ready for review.</p>
                        <p className="font-mono text-xs text-muted-foreground">Reviewing with {MODELS.join(", ")}…</p>
                    </div>
                )}
                {lanes && (
                    <div className="grid gap-2 sm:grid-cols-3">
                        {MODELS.map((m) => (
                            <Lane key={m} model={m} rows={frame} />
                        ))}
                    </div>
                )}
                {frame >= 4 && (
                    <ul className="grid animate-in gap-1.5 duration-500 fade-in">
                        {SHOWN.map((f, i) => {
                            const t = triageAt(frame, i);
                            return (
                                <li
                                    key={f.id}
                                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-background/60 px-2.5 py-2"
                                >
                                    <p className="flex min-w-0 items-center gap-2 text-xs">
                                        <SeverityMark severity={f.severity} className="text-[0.7rem]" />
                                        {/* Dealt with: struck through, not dimmed (dimming would cost the marks their contrast). */}
                                        <span
                                            className={cn(
                                                "truncate",
                                                (t.status === "resolved" || t.status === "wont_fix") &&
                                                    "text-muted-foreground line-through decoration-foreground/40",
                                            )}
                                        >
                                            {f.title}
                                        </span>
                                    </p>
                                    <FoundBy finding={f} />
                                    <p className="flex items-center gap-2 text-[0.7rem] text-muted-foreground">
                                        <StatusMark status={t.status} className="text-[0.7rem]" />
                                        {t.note && (
                                            <span className="flex animate-in items-center gap-1 duration-300 fade-in">{t.note}</span>
                                        )}
                                    </p>
                                    <span className="font-mono text-[0.7rem] text-muted-foreground">{file(f)}</span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <p className="border-t border-border px-3 py-2 text-[0.7rem] text-muted-foreground">
                {frame < 4
                    ? "Each model reviews the same change, with its own key."
                    : frame === 4
                      ? `${RAW} findings from three models are ${SHOWN.length} to triage: the dots say who found each.`
                      : "People and agents work one list. Triage carries over to the next review."}
            </p>
        </section>
    );
}
