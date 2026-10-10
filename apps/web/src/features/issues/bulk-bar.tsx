// One change to every selected issue: status, assignee, a rating correction or the discussion flag.

import { SEVERITIES, STATUSES } from "@triagent/shared";
import { ChevronDown, Eye, X } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { FieldError } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage } from "@/lib/api";
import { plural, SEVERITY_LABEL, STATUS_LABEL } from "@/lib/format";
import { useMe } from "@/lib/session";
import type { IssueSummary } from "@/lib/types";
import { type BulkChange, useBulkUpdate } from "./use-issue-actions";

export function BulkBar({
    ids,
    known,
    notShown,
    showingSelected,
    onShowSelected,
    onClear,
    refs,
}: {
    ids: string[];
    /** The issues in the list now: what they are before a change, so it can be undone. */
    known: readonly IssueSummary[];
    /** How many of them aren't in the list as it's filtered and paged now. */
    notShown: number;
    /** The list is narrowed to the selection. */
    showingSelected: boolean;
    onShowSelected(show: boolean): void;
    onClear(): void;
    refs: { ws: string; project: string; branch: string };
}) {
    const me = useMe();
    const bulk = useBulkUpdate(refs);
    const [assignee, setAssignee] = useState("");
    const [assignOpen, setAssignOpen] = useState(false);
    const assigneeId = useId();

    /** `done` says what happened to how many: "Marked 3 issues as resolved". */
    const apply = (change: BulkChange, done: (issues: string) => string) =>
        bulk.mutate(
            { ids, change, known },
            {
                onSuccess: (r) => {
                    setAssignOpen(false);
                    setAssignee("");
                    if (!r.changed) {
                        toast.info(
                            `Nothing to change: ${ids.length === 1 ? "the issue was" : `all ${ids.length} issues were`} already like that.`,
                        );
                        return;
                    }
                    const undo = r.undo;
                    // Long enough to read and reach; a later toast stacks above it rather than replacing it.
                    toast.success(`${done(plural(r.changed, "issue"))}.`, {
                        duration: undo ? 10_000 : undefined,
                        action: undo
                            ? {
                                  label: "Undo",
                                  onClick: () =>
                                      void undo().then(
                                          () =>
                                              toast.success(
                                                  `Undone: ${plural(r.changed, "issue")} put back as ${r.changed === 1 ? "it was" : "they were"}.`,
                                              ),
                                          (err) => toast.error(`Couldn't undo that. ${errorMessage(err)}`),
                                      ),
                              }
                            : undefined,
                    });
                },
            },
        );

    return (
        <section
            aria-label="Change selected issues"
            className="flex flex-wrap items-center gap-2 rounded-md border bg-accent/60 px-3 py-1.5 text-sm"
        >
            <span className="font-medium">
                {plural(ids.length, "issue")} selected{notShown > 0 && `, ${notShown} not shown`}
            </span>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" disabled={bulk.isPending}>
                        Status <ChevronDown />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                    {STATUSES.map((s) => (
                        <DropdownMenuItem
                            key={s}
                            onSelect={() => apply({ status: s }, (n) => `Marked ${n} as ${STATUS_LABEL[s].toLowerCase()}`)}
                        >
                            <span className={`status status-${s}`}>{STATUS_LABEL[s]}</span>
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
            <Popover open={assignOpen} onOpenChange={setAssignOpen}>
                <PopoverTrigger asChild>
                    <Button size="sm" variant="outline" disabled={bulk.isPending}>
                        Assign <ChevronDown />
                    </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72">
                    <form
                        className="grid gap-2"
                        onSubmit={(e) => {
                            e.preventDefault();
                            const name = assignee.trim();
                            if (name) apply({ assignee: name }, (n) => `Assigned ${n} to ${name}`);
                        }}
                    >
                        <Label htmlFor={assigneeId}>Assign to</Label>
                        <Input id={assigneeId} value={assignee} onChange={(e) => setAssignee(e.target.value)} maxLength={64} />
                        <div className="flex flex-wrap gap-2">
                            <Button type="submit" size="sm" disabled={!assignee.trim() || bulk.isPending}>
                                Assign
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={bulk.isPending}
                                onClick={() => apply({ assignee: me.user.displayName }, (n) => `Assigned ${n} to you`)}
                            >
                                Assign to me
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={bulk.isPending}
                                onClick={() => apply({ assignee: null }, (n) => `Unassigned ${n}`)}
                            >
                                Unassign
                            </Button>
                        </div>
                    </form>
                </PopoverContent>
            </Popover>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" disabled={bulk.isPending}>
                        Rating <ChevronDown />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">Correct the severity</DropdownMenuLabel>
                    {SEVERITIES.map((s) => (
                        <DropdownMenuItem key={s} onSelect={() => apply({ severity: s }, (n) => `Rated ${n} ${s}`)}>
                            <span className={`sev sev-${s}`}>{SEVERITY_LABEL[s]}</span>
                        </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => apply({ severity: "reviewer" }, (n) => `Restored the reviewer's rating on ${n}`)}>
                        Restore the reviewer's rating
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" disabled={bulk.isPending}>
                        Discussion <ChevronDown />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => apply({ needsDiscussion: true }, (n) => `Flagged ${n} for discussion`)}>
                        Needs discussion
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => apply({ needsDiscussion: false }, (n) => `Cleared the discussion flag on ${n}`)}>
                        Doesn't need discussion
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <span className="ms-auto flex flex-wrap items-center gap-2">
                {/* The way back is beside the list's note, which stays when nothing is selected any more. */}
                {notShown > 0 && !showingSelected && (
                    <Button size="sm" variant="outline" onClick={() => onShowSelected(true)}>
                        <Eye /> Show selected
                    </Button>
                )}
                <Button size="sm" variant="outline" onClick={onClear}>
                    <X /> Clear selection
                </Button>
            </span>
            <FieldError message={bulk.error ? errorMessage(bulk.error) : null} className="w-full" />
        </section>
    );
}
