// Starting a review: a pull request, a branch's changes since its base, or a full scan of a branch. The
// form is the Start a review page's (start-review-page.tsx), and the dialog's that buttons beside a pull
// request or branch open with the choice made already.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { type Choice, ChoiceField, Field, FieldError, FieldHint, NativeSelect } from "@/components/field";
import { ModelChips, ModelChoice, modelLabels, modelOptions } from "@/components/model-choice";
import { optionsFor, ReviewOptions } from "@/components/review-options";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, errorMessage, paths } from "@/lib/api";
import { branchesQuery, keys, modelsQuery, pullRequestsQuery } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import type { Run, RunKind, RunOptionsInput } from "@/lib/types";

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

/** Where a kind of review's models come from, when the run doesn't choose its own. */
const RULE_TEXT: Record<RunKind, Record<"kind" | "project" | "default", string>> = {
    pr: {
        kind: "This project's models for pull requests.",
        project: "This project's models.",
        default: "The workspace's default model.",
    },
    changes: {
        kind: "This project's models for branch changes.",
        project: "This project's models.",
        default: "The workspace's default model.",
    },
    full: {
        kind: "This project's models for full scans.",
        project: "This project's models.",
        default: "The workspace's default model.",
    },
};

/** The select's value for "type a number instead": no pull request has number 0. */
const OTHER = "0";

/** What to review, and the button that starts it; once started, the new run opens. */
export function StartReviewForm({
    defaults = {},
    actions,
    onStarted,
}: {
    defaults?: StartReviewDefaults;
    /** Buttons before Start review (the dialog's Cancel). */
    actions?: ReactNode;
    onStarted?: () => void;
}) {
    const { ws, slug, project } = useProject();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const id = useId();
    const [kind, setKind] = useState<RunKind>(defaults.kind ?? "pr");
    const [number, setNumber] = useState(defaults.number ? String(defaults.number) : "");
    const [branch, setBranch] = useState(defaults.branch ?? "");
    const [base, setBase] = useState(defaults.base ?? "");
    const [typing, setTyping] = useState(false);
    // The models: what the project uses for this kind of review (so they follow the kind), until someone
    // chooses others for this review.
    const can = useCan();
    const choices = useQuery(modelsQuery(ws, slug));
    const rule = choices.data?.rules?.[kind];
    const [chosen, setChosen] = useState<string[] | null>(null);
    const [choosing, setChoosing] = useState(false);
    const models = chosen ?? rule?.ids ?? [];
    // Options for several models: the project's own, until someone changes them for this review.
    const [options, setOptions] = useState<RunOptionsInput | null>(null);
    const several = models.length > 1;
    // Suggestions: the open pull requests, and the branches this project knows of.
    const prs = useQuery(pullRequestsQuery(ws, slug));
    const branches = useQuery(branchesQuery(ws, slug));
    const open = prs.data?.connected ? prs.data.items : [];
    const known = [
        ...new Set([
            project.defaultBranch,
            ...(branches.data?.items.map((b) => b.name) ?? []),
            ...(branches.data?.github?.notReviewed ?? []),
        ]),
    ];
    // Pick from the open pull requests, unless there are none, someone chose to type a number, or the
    // number given isn't one of them.
    const listed = open.some((p) => String(p.number) === number);
    const picking = open.length > 0 && !typing && (listed || number === "");
    const pr = picking && !listed ? String(open[0]?.number ?? "") : number.trim();

    const start = useMutation({
        mutationFn: () =>
            api.post<Run>(`${paths.project(ws, slug)}/reviews`, {
                kind,
                ...(kind === "pr" ? { number: Number(pr) } : {}),
                ...(kind !== "pr" && branch.trim() ? { branch: branch.trim() } : {}),
                ...(kind === "changes" && base.trim() ? { base: base.trim() } : {}),
                ...(chosen ? { models: chosen } : {}),
                ...(options && several ? { options: optionsFor(options, models.length) } : {}),
            }),
        onSuccess: (run) => {
            toast.success(run.status === "queued" ? `Queued: ${run.title}.` : `Already ${run.status}: ${run.title}.`);
            void queryClient.invalidateQueries({ queryKey: keys.runs(ws) });
            void queryClient.invalidateQueries({ queryKey: keys.pullRequests(ws, slug) });
            onStarted?.();
            void navigate({ to: "/w/$ws/p/$project/runs/$runId", params: { ws, project: slug, runId: run.id } });
        },
    });
    const ready =
        (kind === "pr" ? /^[1-9]\d*$/.test(pr) : kind === "changes" ? Boolean(branch.trim()) : true) &&
        (chosen === null || chosen.length > 0);
    const branchList = `${id}-branches`;
    const modelList = `${id}-models`;

    return (
        <form
            className="grid gap-form"
            onSubmit={(e) => {
                e.preventDefault();
                if (ready) start.mutate();
            }}
        >
            <ChoiceField legend="What to review" name={`${id}-kind`} value={kind} onChange={setKind} choices={KINDS} />
            {kind === "pr" &&
                (picking ? (
                    <Field label="Pull request" hint="Open pull requests on GitHub." width="lg">
                        {(p) => (
                            <NativeSelect
                                {...p}
                                value={pr}
                                onChange={(e) => {
                                    if (e.target.value === OTHER) {
                                        setTyping(true);
                                        setNumber("");
                                    } else setNumber(e.target.value);
                                }}
                            >
                                {open.map((x) => (
                                    <option key={x.number} value={String(x.number)}>
                                        #{x.number} {x.title}
                                    </option>
                                ))}
                                <option value={OTHER}>Another pull request…</option>
                            </NativeSelect>
                        )}
                    </Field>
                ) : (
                    <Field label="Pull request number" width="sm">
                        {(p) => <Input {...p} inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} required />}
                    </Field>
                ))}
            {kind !== "pr" && (
                <Field label="Branch" hint={kind === "full" ? `Leave empty for ${project.defaultBranch}.` : undefined} width="lg">
                    {(p) => (
                        <Input
                            {...p}
                            list={branchList}
                            value={branch}
                            onChange={(e) => setBranch(e.target.value)}
                            placeholder={kind === "full" ? project.defaultBranch : ""}
                            className="font-mono"
                            spellCheck={false}
                            autoComplete="off"
                            required={kind === "changes"}
                        />
                    )}
                </Field>
            )}
            {kind === "changes" && (
                <Field label="Compared with" hint={`Leave empty for ${project.defaultBranch}.`} width="lg">
                    {(p) => (
                        <Input
                            {...p}
                            list={branchList}
                            value={base}
                            onChange={(e) => setBase(e.target.value)}
                            placeholder={project.defaultBranch}
                            className="font-mono"
                            spellCheck={false}
                            autoComplete="off"
                        />
                    )}
                </Field>
            )}
            <datalist id={branchList}>
                {known.map((b) => (
                    <option key={b} value={b} />
                ))}
            </datalist>
            {choices.data && rule && modelOptions(choices.data).length > 0 && (
                <div className="grid gap-field" data-testid="review-models">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm leading-snug font-medium">Models</span>
                        <ModelChips labels={modelLabels(choices.data, models)} data-testid="review-models-chosen" />
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-expanded={choosing}
                            aria-controls={modelList}
                            onClick={() => setChoosing(!choosing)}
                        >
                            {choosing ? "Hide the models" : "Change the models"}
                        </Button>
                        {chosen !== null && (
                            <Button type="button" variant="ghost" size="sm" onClick={() => setChosen(null)}>
                                Use the project's
                            </Button>
                        )}
                    </div>
                    <FieldHint>
                        {chosen !== null
                            ? "Chosen for this review only."
                            : `${RULE_TEXT[kind][rule.from]} Changing them applies to this review only.`}
                        {can("configure") && (
                            <>
                                {" "}
                                <Link to="/w/$ws/p/$project/settings/automation" params={{ ws, project: slug }} className="underline">
                                    Change the project's models
                                </Link>
                            </>
                        )}
                    </FieldHint>
                    <div id={modelList} hidden={!choosing}>
                        {choosing && (
                            <ModelChoice
                                legend="Models for this review"
                                options={modelOptions(choices.data)}
                                value={models}
                                max={choices.data.max}
                                empty="None ticked: tick at least one, or use the project's."
                                onChange={setChosen}
                            />
                        )}
                    </div>
                </div>
            )}
            {choices.data && several && (
                <ReviewOptions
                    value={options ?? choices.data.options ?? {}}
                    models={models.length}
                    choices={choices.data}
                    chosen={models}
                    onChange={setOptions}
                />
            )}
            <FieldError message={start.error ? errorMessage(start.error) : null} />
            <div className="flex flex-wrap items-center justify-end gap-2">
                {actions}
                <Button type="submit" disabled={!ready || start.isPending}>
                    <Play /> {start.isPending ? "Starting…" : "Start review"}
                </Button>
            </div>
        </form>
    );
}

/** A button that opens the form in a dialog, with the choice made already (beside a pull request or branch). */
export function StartReview({
    defaults = {},
    trigger,
    label = "Start review",
}: {
    defaults?: StartReviewDefaults;
    trigger?: ReactNode;
    label?: string;
}) {
    const { project } = useProject();
    const can = useCan();
    const [open, setOpen] = useState(false);
    if (!can("operate")) return null;
    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                {trigger ?? (
                    <Button>
                        <Play /> {label}
                    </Button>
                )}
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Start a review</DialogTitle>
                    <DialogDescription>
                        Open Code Review runs on {project.name}'s code from GitHub. The findings go to the branch's report here.
                    </DialogDescription>
                </DialogHeader>
                {/* The dialog's content mounts each time it opens, so the form starts from the defaults. */}
                <StartReviewForm
                    defaults={defaults}
                    onStarted={() => setOpen(false)}
                    actions={
                        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                            Cancel
                        </Button>
                    }
                />
            </DialogContent>
        </Dialog>
    );
}
