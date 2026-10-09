import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { CheckField, ChoiceField, Field, FieldError, NativeSelect } from "@/components/field";
import { FormActions } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, paths } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { automationQuery, keys } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import type { Automation } from "@/lib/types";
import { fromModelSets, type ModelSets, ProjectModels, toModelSets } from "./project-models";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** A week, and a day, in minutes. */
const MAX_LIMIT = 10_080;
const MAX_STALL = 1440;

/** Number inputs are edited as text, so a half-typed value isn't forced into a number. */
interface Form {
    enabled: boolean;
    failOnCritical: boolean;
    archiveDeletedBranches: boolean;
    pollMinutes: string;
    nightlyHourUtc: string;
    maxTokensBudget: string;
    /** Each limit is a switch and, when it's on, a number. */
    reviewLimit: boolean;
    reviewTimeoutMinutes: string;
    fullScanLimit: boolean;
    fullScanTimeoutMinutes: string;
    stallCheck: boolean;
    stallMinutes: string;
    reviewPullRequestsFrom: Automation["reviewPullRequestsFrom"];
    firstReview: Automation["firstReview"];
    /** One pattern on each line. */
    skipPaths: string;
    skipBots: boolean;
    models: ModelSets;
}

const toForm = (a: Automation): Form => ({
    enabled: a.enabled,
    failOnCritical: a.failOnCritical,
    archiveDeletedBranches: a.archiveDeletedBranches,
    pollMinutes: String(a.pollMinutes),
    nightlyHourUtc: a.nightlyHourUtc === null ? "" : String(a.nightlyHourUtc),
    maxTokensBudget: a.maxTokensBudget === null ? "" : String(a.maxTokensBudget),
    reviewLimit: a.reviewTimeoutMinutes !== null,
    reviewTimeoutMinutes: String(a.reviewTimeoutMinutes ?? ""),
    fullScanLimit: a.fullScanTimeoutMinutes !== null,
    fullScanTimeoutMinutes: String(a.fullScanTimeoutMinutes ?? ""),
    stallCheck: a.stallMinutes !== null,
    stallMinutes: String(a.stallMinutes ?? ""),
    reviewPullRequestsFrom: a.reviewPullRequestsFrom,
    firstReview: a.firstReview ?? "checks",
    skipPaths: (a.skipPaths ?? []).join("\n"),
    skipBots: a.skipBots ?? true,
    models: toModelSets(a.models),
});

function fromForm(f: Form): Automation {
    const whole = (label: string, v: string, min: number, max: number) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
        return n;
    };
    return {
        enabled: f.enabled,
        failOnCritical: f.failOnCritical,
        archiveDeletedBranches: f.archiveDeletedBranches,
        pollMinutes: whole("Check for pull requests every", f.pollMinutes, 1, 60),
        nightlyHourUtc: f.nightlyHourUtc === "" ? null : whole("Nightly scan hour", f.nightlyHourUtc, 0, 23),
        maxTokensBudget: f.maxTokensBudget.trim() === "" ? null : whole("Token budget", f.maxTokensBudget, 10_000, 1_000_000_000),
        reviewTimeoutMinutes: f.reviewLimit ? whole("Review time limit", f.reviewTimeoutMinutes, 5, MAX_LIMIT) : null,
        fullScanTimeoutMinutes: f.fullScanLimit ? whole("Full scan time limit", f.fullScanTimeoutMinutes, 5, MAX_LIMIT) : null,
        stallMinutes: f.stallCheck ? whole("Minutes without output", f.stallMinutes, 1, MAX_STALL) : null,
        reviewPullRequestsFrom: f.reviewPullRequestsFrom,
        firstReview: f.firstReview,
        skipPaths: skipPaths(f.skipPaths),
        skipBots: f.skipBots,
        models: fromModelSets(f.models),
    };
}

/** The patterns typed, one on each line, within what the server takes. */
function skipPaths(text: string): string[] {
    const patterns = text
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean);
    if (patterns.length > 50) throw new Error("Files that don't need a review: at most 50 patterns.");
    const long = patterns.find((p) => p.length > 200);
    if (long) throw new Error(`Files that don't need a review: "${long.slice(0, 40)}…" is longer than 200 characters.`);
    return patterns;
}

function Toggle({
    label,
    hint,
    checked,
    disabled,
    onChange,
}: {
    label: string;
    hint: string;
    checked: boolean;
    disabled: boolean;
    onChange(v: boolean): void;
}) {
    return (
        <CheckField label={label} hint={hint}>
            {(p) => <Switch {...p} checked={checked} onCheckedChange={onChange} disabled={disabled} />}
        </CheckField>
    );
}

/** A limit that's off (none) or on with a number of minutes, shown only while it's on. */
function Limit({
    label,
    hint,
    field,
    min,
    max,
    initial,
    on,
    value,
    disabled,
    onChange,
}: {
    label: string;
    hint: string;
    /** The number field's own label. */
    field: string;
    min: number;
    max: number;
    /** What the number starts at when the limit is switched on. */
    initial: string;
    on: boolean;
    value: string;
    disabled: boolean;
    onChange(on: boolean, value: string): void;
}) {
    return (
        <>
            <Toggle
                label={label}
                hint={hint}
                checked={on}
                disabled={disabled}
                onChange={(v) => onChange(v, v && !value ? initial : value)}
            />
            {on && (
                <Field label={field} hint={`${min.toLocaleString("en")} to ${max.toLocaleString("en")}.`} width="xs">
                    {(p) => (
                        <Input
                            {...p}
                            type="number"
                            min={min}
                            max={max}
                            value={value}
                            onChange={(e) => onChange(true, e.target.value)}
                            disabled={disabled}
                        />
                    )}
                </Field>
            )}
        </>
    );
}

export function ProjectAutomation() {
    const { ws, slug, project } = useProject();
    const editable = useCan()("configure");
    const queryClient = useQueryClient();
    const query = useQuery(automationQuery(ws, slug));
    const form = useDraft(query.data ? toForm(query.data) : undefined);

    const save = useMutation({
        mutationFn: (f: Form) => api.patch<Automation>(`${paths.project(ws, slug)}/settings/automation`, fromForm(f)),
        onSuccess: (a) => {
            form.saved(toForm(a));
            queryClient.setQueryData(keys.projectSettings(ws, slug, "automation"), a);
            // What each kind of review uses (the Start a review picker, the Pull requests page).
            void queryClient.invalidateQueries({ queryKey: keys.models(ws) });
            toast.success("Automation settings saved.");
        },
    });

    const d = form.draft;
    const set = (patch: Partial<Form>) => d && form.setDraft({ ...d, ...patch });
    return (
        <SettingsPage title="Automation" description={`How ${project.name} is reviewed automatically.`}>
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : !d ? (
                <LoadingRows rows={5} />
            ) : (
                <form
                    className="grid gap-6"
                    onSubmit={(e) => {
                        e.preventDefault();
                        save.mutate(d);
                    }}
                >
                    {!editable && <ReadOnlyNote />}
                    <ChangedElsewhere show={form.changedElsewhere} onReload={form.reload} what="These settings" />
                    <SettingsSection
                        title="Review models"
                        description="Which models review this project's code. Someone starting a review can choose others for that review."
                    >
                        <ProjectModels ws={ws} value={d.models} disabled={!editable} onChange={(models) => set({ models })} />
                    </SettingsSection>
                    <SettingsSection title="Pull requests">
                        <Toggle
                            label="Review pull requests automatically"
                            hint="Each pull request is reviewed once by itself, and summarised in a comment. Later pushes aren't reviewed until someone asks."
                            checked={d.enabled}
                            disabled={!editable}
                            onChange={(v) => set({ enabled: v })}
                        />
                        <ChoiceField
                            legend="When a pull request gets its first review"
                            name="firstReview"
                            value={d.firstReview}
                            disabled={!editable}
                            onChange={(firstReview) => set({ firstReview })}
                            choices={[
                                {
                                    value: "checks",
                                    label: "When it's ready and its checks have passed",
                                    hint: "Drafts wait. So does a pull request whose checks are running or have failed; with no checks at all, it's reviewed after two minutes.",
                                },
                                { value: "ready", label: "As soon as it's ready", hint: "Drafts wait; checks are ignored." },
                                { value: "manual", label: "Only when someone asks" },
                            ]}
                            hint={
                                <>
                                    Later pushes are never reviewed by themselves. To ask for a review of any pull request, drafts too:
                                    comment <code className="font-mono">/review</code> on it (people with write access to the repository),
                                    add the label <code className="font-mono">review</code>, or use Review now on the Pull requests page. A
                                    push that changes nothing (a rebase, or a merge from the base) keeps the review it had.
                                </>
                            }
                        />
                        <Field
                            label="Files that don't need a review"
                            hint={
                                <>
                                    One pattern on each line, such as <code className="font-mono">docs/**</code>,{" "}
                                    <code className="font-mono">*.md</code> or <code className="font-mono">**/*.lock</code>. A pull request
                                    that changes only these isn't reviewed by itself. A pattern with no slash matches in every directory.
                                </>
                            }
                            width="lg"
                        >
                            {(p) => (
                                <Textarea
                                    {...p}
                                    rows={3}
                                    className="font-mono text-xs"
                                    value={d.skipPaths}
                                    onChange={(e) => set({ skipPaths: e.target.value })}
                                    disabled={!editable}
                                    spellCheck={false}
                                />
                            )}
                        </Field>
                        <Toggle
                            label="Skip pull requests opened by bots"
                            hint="Dependabot, Renovate and the like. The label skip-review does the same for any pull request."
                            checked={d.skipBots}
                            disabled={!editable}
                            onChange={(v) => set({ skipBots: v })}
                        />
                        <Toggle
                            label="Fail the check when a review finds something critical"
                            hint="The pull request's commit status fails, so branch protection can block the merge."
                            checked={d.failOnCritical}
                            disabled={!editable}
                            onChange={(v) => set({ failOnCritical: v })}
                        />
                        <Field
                            label="Review pull requests from"
                            hint="Each review spends this workspace's model budget. Pull requests from forks by anyone else wait until someone who can start reviews clicks Review now."
                            width="lg"
                        >
                            {(p) => (
                                <NativeSelect
                                    {...p}
                                    value={d.reviewPullRequestsFrom}
                                    onChange={(e) =>
                                        set({ reviewPullRequestsFrom: e.target.value as Automation["reviewPullRequestsFrom"] })
                                    }
                                    disabled={!editable}
                                >
                                    <option value="collaborators">Branches of the repository, and its collaborators</option>
                                    <option value="everyone">Everyone, forks included</option>
                                </NativeSelect>
                            )}
                        </Field>
                        <Field label="Check for pull requests every (minutes)" hint="Used when there's no webhook. 1 to 60." width="xs">
                            {(p) => (
                                <Input
                                    {...p}
                                    type="number"
                                    min={1}
                                    max={60}
                                    value={d.pollMinutes}
                                    onChange={(e) => set({ pollMinutes: e.target.value })}
                                    disabled={!editable}
                                />
                            )}
                        </Field>
                    </SettingsSection>
                    <SettingsSection
                        title="Time limits"
                        description="Reviews run for as long as they need unless you limit them. A limit applies to each model's review."
                    >
                        <Limit
                            label="Limit how long a pull request review can run"
                            hint="A review of a pull request, or of a branch's changes, that runs longer is stopped."
                            field="Review time limit (minutes)"
                            min={5}
                            max={MAX_LIMIT}
                            initial="45"
                            on={d.reviewLimit}
                            value={d.reviewTimeoutMinutes}
                            disabled={!editable}
                            onChange={(on, value) => set({ reviewLimit: on, reviewTimeoutMinutes: value })}
                        />
                        <Limit
                            label="Limit how long a full scan can run"
                            hint="A full scan that runs longer is stopped."
                            field="Full scan time limit (minutes)"
                            min={5}
                            max={MAX_LIMIT}
                            initial="120"
                            on={d.fullScanLimit}
                            value={d.fullScanTimeoutMinutes}
                            disabled={!editable}
                            onChange={(on, value) => set({ fullScanLimit: on, fullScanTimeoutMinutes: value })}
                        />
                        <Limit
                            label="Limit how long a review can go without output"
                            hint="A review whose model has produced nothing for this long is stopped and marked as stalled, so a model that stops answering doesn't hold up other reviews."
                            field="Minutes without output"
                            min={1}
                            max={MAX_STALL}
                            initial="30"
                            on={d.stallCheck}
                            value={d.stallMinutes}
                            disabled={!editable}
                            onChange={(on, value) => set({ stallCheck: on, stallMinutes: value })}
                        />
                    </SettingsSection>
                    <SettingsSection title="Full scans and branches">
                        <Field label="Nightly full scan of the default branch" hint="The hour it starts, in UTC." width="sm">
                            {(p) => (
                                <NativeSelect
                                    {...p}
                                    value={d.nightlyHourUtc}
                                    onChange={(e) => set({ nightlyHourUtc: e.target.value })}
                                    disabled={!editable}
                                >
                                    <option value="">None</option>
                                    {HOURS.map((h) => (
                                        <option key={h} value={String(h)}>
                                            {`${String(h).padStart(2, "0")}:00 UTC`}
                                        </option>
                                    ))}
                                </NativeSelect>
                            )}
                        </Field>
                        <Field
                            label="Model token budget per review"
                            hint="A review that would use more tokens stops. Empty for no limit; at least 10,000."
                            width="sm"
                        >
                            {(p) => (
                                <Input
                                    {...p}
                                    type="number"
                                    min={10_000}
                                    value={d.maxTokensBudget}
                                    onChange={(e) => set({ maxTokensBudget: e.target.value })}
                                    disabled={!editable}
                                />
                            )}
                        </Field>
                        <Toggle
                            label="Archive a branch here when it's deleted on GitHub"
                            hint="Its report and triage are kept in the branch's history."
                            checked={d.archiveDeletedBranches}
                            disabled={!editable}
                            onChange={(v) => set({ archiveDeletedBranches: v })}
                        />
                    </SettingsSection>
                    <FieldError message={save.error ? errorMessage(save.error) : null} />
                    {editable && (
                        <FormActions>
                            <Button type="submit" disabled={save.isPending || !form.dirty}>
                                {save.isPending ? "Saving…" : "Save changes"}
                            </Button>
                        </FormActions>
                    )}
                </form>
            )}
        </SettingsPage>
    );
}
