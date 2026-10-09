// The guided setup's window: the steps down the side (each required, recommended or optional, ticked
// once it's done), the current one's settings (the same forms as in Settings), and Back / Skip / Next.
// Closing it loses nothing: each step saves as it goes, and Finish setup in the top bar brings it back
// while anything required is left.

import { Check, Circle } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type Need = "required" | "recommended" | "optional";

export interface SetupStep {
    id: string;
    title: string;
    need: Need;
    /** Whether it's done; null for a step with nothing to check (a choice, a summary). */
    done: boolean | null;
    body: ReactNode;
}

export interface SetupFlow {
    title: string;
    description: ReactNode;
    steps: SetupStep[];
    /** Still loading what's done: the dialog waits rather than start on the wrong step. */
    loading: boolean;
    /** The last step's button. */
    finishLabel?: string;
    onFinish?(): void | Promise<void>;
}

const NEED_LABEL: Record<Need, string> = { required: "Required", recommended: "Recommended", optional: "Optional" };

function StepMark({ step, current }: { step: SetupStep; current: boolean }) {
    if (step.done)
        return (
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-st-resolved text-white">
                <Check className="size-3.5" aria-hidden="true" />
            </span>
        );
    return <Circle className={cn("size-5 shrink-0", current ? "text-foreground" : "text-muted-foreground")} aria-hidden="true" />;
}

export function SetupDialog({ flow, startAt, onClose }: { flow: SetupFlow; startAt?: string; onClose(): void }) {
    const [index, setIndex] = useState<number | null>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    // Start where asked, or at the first step still to do, once it's known what's done.
    useEffect(() => {
        if (index !== null || flow.loading) return;
        const asked = startAt ? flow.steps.findIndex((s) => s.id === startAt) : -1;
        const todo = flow.steps.findIndex((s) => s.done === false);
        setIndex(asked >= 0 ? asked : todo >= 0 ? todo : 0);
    }, [index, flow.loading, flow.steps, startAt]);
    // A step whose condition disappears (the webhook, once the app is used) mustn't leave the index past the end.
    const at = Math.min(index ?? 0, flow.steps.length - 1);
    const step = flow.steps[at];
    const last = at === flow.steps.length - 1;
    const required = flow.steps.filter((s) => s.need === "required");
    const left = required.filter((s) => s.done === false);

    const go = (to: number) => {
        setIndex(to);
        // Move focus to the new step's heading, so it's read out and Tab starts there.
        requestAnimationFrame(() => heading.current?.focus());
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                className="grid max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-4xl"
                data-testid="setup-dialog"
                // Focus the step's heading, not the first control (often a provider list or a link).
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                    heading.current?.focus();
                }}
            >
                <DialogHeader className="border-b p-4 pe-12 sm:p-5 sm:pe-12">
                    <DialogTitle>{flow.title}</DialogTitle>
                    <DialogDescription>{flow.description}</DialogDescription>
                    {required.length > 0 && (
                        <p className="text-xs text-muted-foreground" data-testid="setup-progress">
                            {left.length
                                ? `${required.length - left.length} of ${required.length} required steps done.`
                                : "Everything required is done."}
                        </p>
                    )}
                </DialogHeader>

                <div className="grid min-h-0 md:grid-cols-[15rem_minmax(0,1fr)]">
                    <nav aria-label="Setup steps" className="border-b bg-muted/30 p-2 md:border-e md:border-b-0 md:p-3">
                        <ol className="flex gap-1 overflow-x-auto md:grid md:overflow-visible">
                            {flow.steps.map((s, i) => (
                                <li key={s.id} className="shrink-0">
                                    <button
                                        type="button"
                                        onClick={() => go(i)}
                                        aria-current={i === at ? "step" : undefined}
                                        className={cn(
                                            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                                            i === at && "bg-accent font-medium",
                                        )}
                                    >
                                        <StepMark step={s} current={i === at} />
                                        <span className="grid">
                                            <span>{s.title}</span>
                                            <span className="text-xs font-normal text-muted-foreground">
                                                {s.done ? "Done" : NEED_LABEL[s.need]}
                                            </span>
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ol>
                    </nav>

                    <section
                        aria-labelledby="setup-step-heading"
                        className="grid min-h-0 content-start gap-form overflow-y-auto p-4 sm:p-5"
                    >
                        {flow.loading || index === null || !step ? (
                            <p className="text-sm text-muted-foreground">Checking what's set up already…</p>
                        ) : (
                            <>
                                <div className="flex flex-wrap items-center gap-2">
                                    <h3
                                        id="setup-step-heading"
                                        ref={heading}
                                        tabIndex={-1}
                                        className="text-base font-semibold outline-none"
                                    >
                                        {step.title}
                                    </h3>
                                    <Badge variant={step.need === "required" && !step.done ? "default" : "secondary"}>
                                        {step.done ? "Done" : NEED_LABEL[step.need]}
                                    </Badge>
                                </div>
                                {step.body}
                            </>
                        )}
                    </section>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t p-3 sm:px-5">
                    {at > 0 && (
                        <Button type="button" variant="ghost" onClick={() => go(at - 1)}>
                            Back
                        </Button>
                    )}
                    <span className="ms-auto text-xs text-muted-foreground">
                        Step {at + 1} of {flow.steps.length}
                    </span>
                    <Button type="button" variant="outline" onClick={onClose}>
                        Finish later
                    </Button>
                    {last ? (
                        <Button
                            type="button"
                            onClick={async () => {
                                await flow.onFinish?.();
                                onClose();
                            }}
                        >
                            {flow.finishLabel ?? "Done"}
                        </Button>
                    ) : (
                        <Button type="button" onClick={() => go(at + 1)}>
                            {step?.done === false ? (step.need === "required" ? "Do this later" : "Skip") : "Next"}
                        </Button>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
