// One change to every selected issue: status, assignee, a rating correction or the discussion flag.

import { SEVERITIES, STATUSES } from "@triagent/shared";
import { ChevronDown, X } from "lucide-react";
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
import { type IssueChange, useBulkUpdate } from "./use-issue-actions";

export function BulkBar({ ids, onClear, refs }: { ids: string[]; onClear(): void; refs: { ws: string; project: string; branch: string } }) {
    const me = useMe();
    const bulk = useBulkUpdate(refs);
    const [assignee, setAssignee] = useState("");
    const [assignOpen, setAssignOpen] = useState(false);
    const assigneeId = useId();

    const apply = (change: IssueChange, what: string) =>
        bulk.mutate(
            { ids, change },
            {
                onSuccess: (r) => {
                    toast.success(`${what}: ${plural(r.changed, "issue")} changed.`);
                    setAssignOpen(false);
                    setAssignee("");
                },
            },
        );

    return (
        <section
            aria-label="Change selected issues"
            className="flex flex-wrap items-center gap-2 rounded-md border bg-accent/60 px-3 py-1.5 text-sm"
        >
            <span className="font-medium">{plural(ids.length, "issue")} selected</span>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" disabled={bulk.isPending}>
                        Status <ChevronDown />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                    {STATUSES.map((s) => (
                        <DropdownMenuItem key={s} onSelect={() => apply({ status: s }, `Marked ${STATUS_LABEL[s].toLowerCase()}`)}>
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
                            if (assignee.trim()) apply({ assignee: assignee.trim() }, `Assigned to ${assignee.trim()}`);
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
                                onClick={() => apply({ assignee: me.user.displayName }, "Assigned to you")}
                            >
                                Assign to me
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={bulk.isPending}
                                onClick={() => apply({ assignee: null }, "Unassigned")}
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
                        <DropdownMenuItem key={s} onSelect={() => apply({ severity: s }, `Rated ${s}`)}>
                            <span className={`sev sev-${s}`}>{SEVERITY_LABEL[s]}</span>
                        </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => apply({ severity: "reviewer" }, "Reviewer's rating restored")}>
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
                    <DropdownMenuItem onSelect={() => apply({ needsDiscussion: true }, "Flagged for discussion")}>
                        Needs discussion
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => apply({ needsDiscussion: false }, "Discussion flag cleared")}>
                        Doesn't need discussion
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="ghost" className="ms-auto" onClick={onClear}>
                <X /> Clear selection
            </Button>
            <FieldError message={bulk.error ? errorMessage(bulk.error) : null} className="w-full" />
        </section>
    );
}
