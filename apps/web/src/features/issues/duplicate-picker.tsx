import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId, useState } from "react";
import { LoadError } from "@/components/load-state";
import { InlineCode } from "@/components/markdown";
import { SeverityMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { issuesQuery } from "@/lib/queries";
import { useProject } from "@/lib/session";
import type { IssueDetail, IssueSummary } from "@/lib/types";

/** Find the issue this one duplicates: same file first, or search by words. */
export function DuplicatePicker({
    open,
    onOpenChange,
    issue,
    onPick,
}: {
    open: boolean;
    onOpenChange(open: boolean): void;
    issue: IssueDetail;
    onPick(target: IssueSummary): void;
}) {
    const { ws, slug, branch } = useProject();
    const id = useId();
    const [q, setQ] = useState("");
    const deferred = useDeferredValue(q.trim());
    const results = useQuery({
        ...issuesQuery(ws, slug, branch, deferred ? { q: deferred, limit: "30" } : { path: issue.path, limit: "30" }),
        enabled: open,
    });
    const candidates = (results.data?.items ?? []).filter((x) => x.id !== issue.id && !x.duplicateOf);
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>Mark as a duplicate</DialogTitle>
                    <DialogDescription>Choose the issue this one repeats. Issues in the same file are listed first.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-1.5">
                    <Label htmlFor={id}>Search issues</Label>
                    <Input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
                </div>
                {results.isError ? (
                    <LoadError error={results.error} onRetry={() => results.refetch()} />
                ) : (
                    <ul className="grid max-h-80 gap-1 overflow-y-auto" aria-busy={results.isFetching}>
                        {candidates.length === 0 && !results.isFetching && (
                            <li className="text-sm text-muted-foreground">No other issues match.</li>
                        )}
                        {candidates.map((x) => (
                            <li key={x.id} className="flex items-start gap-2 rounded-md border p-2 text-sm">
                                <div className="grid min-w-0 flex-1 gap-0.5">
                                    <span>
                                        <SeverityMark severity={x.severity} className="me-2 text-xs" />
                                        <InlineCode text={x.title} />
                                    </span>
                                    <span className="truncate font-mono text-xs text-muted-foreground">
                                        {x.path}
                                        {x.startLine ? `:${x.startLine}` : ""} · {x.id}
                                    </span>
                                </div>
                                <Button size="sm" variant="outline" onClick={() => onPick(x)}>
                                    Choose<span className="sr-only"> {x.id}</span>
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </DialogContent>
        </Dialog>
    );
}
