// Something a model was asked to write, wherever it's shown: what it wrote (as text: never HTML, and
// with no links), who wrote it and when, a warning when it had little to go on, and the way to ask for
// it: a button when there's a model to ask, the reason when there isn't.

import { Link } from "@tanstack/react-router";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import type { Analysis, AnalysisModel } from "@/lib/analysis";
import { timeAgo } from "@/lib/format";
import { compactCount } from "@/lib/insights-format";
import { useWorkspace } from "@/lib/session";

/** A caution about what follows: there was little for the model to go on. */
export function Caution({ children }: { children: ReactNode }) {
    return (
        <p className="flex gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="analysis-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{children}</span>
        </p>
    );
}

/** "Written by … 5 minutes ago · 3.2k tokens". */
export function WrittenBy({ analysis, children }: { analysis: Analysis; children?: ReactNode }) {
    return (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
                Written by {analysis.model?.label ?? "a model"} {timeAgo(analysis.finishedAt ?? analysis.createdAt)}
                {analysis.tokens ? ` · ${compactCount(analysis.tokens.total)} tokens` : ""}. It hasn't seen the code.
            </span>
            {children}
        </p>
    );
}

/** Why nothing can be asked, with the way to put that right for someone who can. */
export function NoModel({ model }: { model: Extract<AnalysisModel, { ready: false }> }) {
    const { ws, can } = useWorkspace();
    return (
        <p className="text-sm text-muted-foreground" data-testid="analysis-no-model">
            {model.reason}{" "}
            {can("configure") && (
                <Link to="/w/$ws/settings/analysis" params={{ ws }} className="link">
                    Open Settings → Analysis
                </Link>
            )}
        </p>
    );
}

export function Writing({ analysis }: { analysis: Analysis }) {
    return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {analysis.model?.label ?? "The model"} is writing…
        </p>
    );
}

/**
 * One piece of writing and the way to ask for it. `ask` is the button's words ("Write a summary");
 * `unavailable` says why it can't be written here at all, and then nothing is offered.
 */
export function Written({
    analysis,
    model,
    unavailable,
    ask,
    onAsk,
    asking,
    error,
    empty,
}: {
    analysis: Analysis | null;
    model: AnalysisModel;
    unavailable?: string | null;
    ask: string;
    onAsk(): void;
    asking: boolean;
    error?: string | null;
    /** Said above the button when nothing has been written yet. */
    empty?: ReactNode;
}) {
    const { can } = useWorkspace();
    const mayAsk = can("triage") && !unavailable;
    const button = (label: string, variant: "default" | "outline" = "outline") =>
        mayAsk && model.ready ? (
            <Button variant={variant} size="sm" onClick={onAsk} disabled={asking}>
                {asking ? "Asking…" : label}
            </Button>
        ) : null;
    const problem = error ? (
        <p className="text-sm text-destructive" role="alert">
            {error}
        </p>
    ) : null;

    if (analysis?.status === "running") return <Writing analysis={analysis} />;
    if (analysis?.status === "done" && analysis.result?.markdown)
        return (
            <div className="grid gap-3">
                {analysis.result.warning && <Caution>{analysis.result.warning}</Caution>}
                <Markdown className="max-w-measure text-[0.9375rem] leading-relaxed">{analysis.result.markdown}</Markdown>
                <WrittenBy analysis={analysis}>{button("Write it again")}</WrittenBy>
                {problem}
            </div>
        );
    return (
        <div className="grid justify-items-start gap-2">
            {analysis?.status === "failed" ? (
                <p className="text-sm text-muted-foreground" data-testid="analysis-failed">
                    {analysis.error}
                </p>
            ) : unavailable ? (
                <p className="text-sm text-muted-foreground">{unavailable}</p>
            ) : (
                empty && <p className="text-sm text-muted-foreground">{empty}</p>
            )}
            {mayAsk && !model.ready ? <NoModel model={model} /> : button(analysis?.status === "failed" ? "Try again" : ask)}
            {problem}
        </div>
    );
}
