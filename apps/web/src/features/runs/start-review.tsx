// Starting a review: a pull request, a branch's changes since its base, or a full scan of a branch. Used
// on Runs, Pull requests and Branches & reports, sometimes with the choice made already.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { type Choice, ChoiceField, Field, FieldError } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, errorMessage, paths } from "@/lib/api";
import { keys } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import type { Run, RunKind } from "@/lib/types";

export interface StartReviewDefaults {
    kind?: RunKind;
    number?: number;
    branch?: string;
    base?: string;
}

const KINDS: readonly Choice<RunKind>[] = [
    { value: "pr", label: "A pull request", hint: "Only what the pull request changes." },
    { value: "changes", label: "A branch's changes", hint: "What the branch changed since it left its base." },
    { value: "full", label: "A whole branch", hint: "Every file: slower, and uses more of the model." },
];

export function StartReview({
    defaults = {},
    trigger,
    label = "Start review",
}: {
    defaults?: StartReviewDefaults;
    trigger?: ReactNode;
    label?: string;
}) {
    const { ws, slug, project } = useProject();
    const can = useCan();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const id = useId();
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState<RunKind>(defaults.kind ?? "pr");
    const [number, setNumber] = useState(defaults.number ? String(defaults.number) : "");
    const [branch, setBranch] = useState(defaults.branch ?? "");
    const [base, setBase] = useState(defaults.base ?? "");
    const start = useMutation({
        mutationFn: () =>
            api.post<Run>(`${paths.project(ws, slug)}/reviews`, {
                kind,
                ...(kind === "pr" ? { number: Number(number) } : {}),
                ...(kind !== "pr" && branch.trim() ? { branch: branch.trim() } : {}),
                ...(kind === "changes" && base.trim() ? { base: base.trim() } : {}),
            }),
        onSuccess: (run) => {
            toast.success(run.status === "queued" ? `Queued: ${run.title}.` : `Already ${run.status}: ${run.title}.`);
            void queryClient.invalidateQueries({ queryKey: keys.runs(ws) });
            void queryClient.invalidateQueries({ queryKey: keys.pullRequests(ws, slug) });
            setOpen(false);
            void navigate({ to: "/w/$ws/p/$project/runs/$runId", params: { ws, project: slug, runId: run.id } });
        },
    });
    if (!can("operate")) return null;
    const reset = (next: boolean) => {
        setOpen(next);
        if (next) {
            setKind(defaults.kind ?? "pr");
            setNumber(defaults.number ? String(defaults.number) : "");
            setBranch(defaults.branch ?? "");
            setBase(defaults.base ?? "");
            start.reset();
        }
    };
    const ready = kind === "pr" ? /^\d+$/.test(number.trim()) : kind === "changes" ? Boolean(branch.trim()) : true;
    return (
        <Dialog open={open} onOpenChange={reset}>
            <DialogTrigger asChild>
                {trigger ?? (
                    <Button>
                        <Play /> {label}
                    </Button>
                )}
            </DialogTrigger>
            <DialogContent>
                <form
                    className="grid gap-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (ready) start.mutate();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Start a review</DialogTitle>
                        <DialogDescription>
                            Open Code Review runs on {project.name}'s code from GitHub. The findings go to the branch's report here.
                        </DialogDescription>
                    </DialogHeader>
                    <ChoiceField legend="What to review" name={`${id}-kind`} value={kind} onChange={setKind} choices={KINDS} />
                    {kind === "pr" ? (
                        <Field label="Pull request number" width="sm">
                            {(p) => (
                                <Input {...p} inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} required />
                            )}
                        </Field>
                    ) : (
                        <Field label="Branch" hint={kind === "full" ? `Leave empty for ${project.defaultBranch}.` : undefined}>
                            {(p) => (
                                <Input
                                    {...p}
                                    value={branch}
                                    onChange={(e) => setBranch(e.target.value)}
                                    placeholder={kind === "full" ? project.defaultBranch : ""}
                                    className="font-mono"
                                    spellCheck={false}
                                    required={kind === "changes"}
                                />
                            )}
                        </Field>
                    )}
                    {kind === "changes" && (
                        <Field label="Compared with" hint={`Leave empty for ${project.defaultBranch}.`}>
                            {(p) => (
                                <Input
                                    {...p}
                                    value={base}
                                    onChange={(e) => setBase(e.target.value)}
                                    placeholder={project.defaultBranch}
                                    className="font-mono"
                                    spellCheck={false}
                                />
                            )}
                        </Field>
                    )}
                    <FieldError message={start.error ? errorMessage(start.error) : null} />
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => reset(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!ready || start.isPending}>
                            {start.isPending ? "Starting…" : "Start review"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
