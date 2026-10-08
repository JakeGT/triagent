// Small pieces shared by the Runs and Pull requests pages: a run's status, its progress in words, how
// long it took, and cancelling it.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Square } from "lucide-react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, paths } from "@/lib/api";
import { plural } from "@/lib/format";
import { keys } from "@/lib/queries";
import type { Run, RunStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export const STATUS_TEXT: Record<RunStatus, string> = {
    queued: "Queued",
    running: "Running",
    done: "Done",
    partial: "Partly done",
    failed: "Failed",
    cancelled: "Cancelled",
};

const STATUS_CLASS: Record<RunStatus, string> = {
    queued: "border-border text-muted-foreground",
    running: "border-transparent bg-primary text-primary-foreground",
    done: "border-st-resolved/40 text-st-resolved",
    partial: "border-sev-medium/40 text-sev-medium",
    failed: "border-sev-critical/40 text-sev-critical",
    cancelled: "border-border text-muted-foreground",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
    return (
        <Badge variant="outline" className={cn(STATUS_CLASS[status])}>
            {STATUS_TEXT[status]}
        </Badge>
    );
}

/** "12m 3s", "45s". */
export function duration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

const PHASES: Record<string, string> = {
    starting: "Starting",
    fetching: "Fetching the code",
    planning: "Planning",
    reviewing: "Reviewing",
    summarising: "Summarising",
    uploading: "Saving the findings",
    finished: "Finished",
};

/** What a running review is doing, in words. */
export function progressText(run: Pick<Run, "progress" | "cancelRequested">): string {
    const p = run.progress;
    const parts = [PHASES[p.phase ?? "starting"] ?? p.phase ?? "Starting"];
    if (p.files) parts.push(plural(p.files, "file"));
    if (p.groups) parts.push(`${plural(p.groups, "group")} seen${p.current ? ` (now ${p.current})` : ""}`);
    if (p.round) parts.push(`round ${p.round}`);
    if (p.toolCalls) parts.push(`${plural(p.toolCalls, "tool call")}${p.toolFailures ? `, ${p.toolFailures} failed` : ""}`);
    if (run.cancelRequested) parts.push(`stopping (cancelled by ${run.cancelRequested.by})`);
    return parts.join(" · ");
}

/** "PR #12", "Changes on x since main", "Full scan of main". */
export function kindText(run: Pick<Run, "kind" | "pr" | "gitRef" | "baseRef">): string {
    if (run.kind === "pr") return `Pull request #${run.pr?.number}`;
    if (run.kind === "changes") return `Changes on ${run.gitRef} since ${run.baseRef}`;
    return `Full scan of ${run.gitRef}`;
}

export function findingsText(run: Pick<Run, "result">): string {
    const r = run.result;
    if (!r || r.total === null || r.total === undefined) return "";
    const critical = r.bySeverity?.critical ?? 0;
    return `${plural(r.total, "finding")}${critical ? ` (${critical} critical)` : ""}`;
}

export function CancelRun({ ws, run, compact }: { ws: string; run: Run; compact?: boolean }) {
    const queryClient = useQueryClient();
    const cancel = useMutation({
        mutationFn: () => api.post<Run>(`${paths.workspace(ws)}/runs/${encodeURIComponent(run.id)}/cancel`),
        onSuccess: (r) => {
            toast.success(r.status === "cancelled" ? "Review cancelled." : "Stopping the review…");
            void queryClient.invalidateQueries({ queryKey: keys.runs(ws) });
        },
    });
    if (run.cancelRequested) return null;
    return (
        <ConfirmAction
            trigger={
                <Button variant={compact ? "ghost" : "outline"} size="sm">
                    <Square /> Cancel<span className="sr-only"> {run.title}</span>
                </Button>
            }
            title="Cancel this review?"
            description={
                run.status === "running"
                    ? `Open Code Review is stopped where it is, and ${run.title} is recorded as cancelled. Nothing it found so far is kept.`
                    : `${run.title} is taken out of the queue.`
            }
            confirmLabel="Cancel review"
            onConfirm={() => cancel.mutateAsync()}
        />
    );
}
