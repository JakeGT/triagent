import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { Field, FieldError, NativeSelect } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage, paths } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { automationQuery, keys } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import type { Automation } from "@/lib/types";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** Number inputs are edited as text, so a half-typed value isn't forced into a number. */
interface Form {
    enabled: boolean;
    failOnCritical: boolean;
    archiveDeletedBranches: boolean;
    pollMinutes: string;
    nightlyHourUtc: string;
    maxTokensBudget: string;
    reviewTimeoutMinutes: string;
    fullScanTimeoutMinutes: string;
}

const toForm = (a: Automation): Form => ({
    enabled: a.enabled,
    failOnCritical: a.failOnCritical,
    archiveDeletedBranches: a.archiveDeletedBranches,
    pollMinutes: String(a.pollMinutes),
    nightlyHourUtc: a.nightlyHourUtc === null ? "" : String(a.nightlyHourUtc),
    maxTokensBudget: a.maxTokensBudget === null ? "" : String(a.maxTokensBudget),
    reviewTimeoutMinutes: String(a.reviewTimeoutMinutes),
    fullScanTimeoutMinutes: String(a.fullScanTimeoutMinutes),
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
        reviewTimeoutMinutes: whole("Review time limit", f.reviewTimeoutMinutes, 5, 720),
        fullScanTimeoutMinutes: whole("Full scan time limit", f.fullScanTimeoutMinutes, 5, 720),
    };
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
    const id = useId();
    return (
        <div className="flex items-start gap-3">
            <Switch
                id={id}
                checked={checked}
                onCheckedChange={onChange}
                disabled={disabled}
                aria-describedby={`${id}-hint`}
                className="mt-0.5"
            />
            <div className="grid gap-0.5">
                <Label htmlFor={id}>{label}</Label>
                <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                    {hint}
                </p>
            </div>
        </div>
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
            toast.success("Automation settings saved.");
        },
    });

    const d = form.draft;
    const set = (patch: Partial<Form>) => d && form.setDraft({ ...d, ...patch });
    return (
        <SettingsPage title="Automation" description={`How ${project.name} is reviewed automatically.`}>
            <Alert role="note">
                <Info />
                <AlertTitle>These settings take effect when automatic reviews arrive</AlertTitle>
                <AlertDescription>
                    Triagent doesn't run reviews by itself yet. You can set them now; they'll be used once automatic reviews are available.
                </AlertDescription>
            </Alert>
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
                    <SettingsSection title="Pull requests">
                        <Toggle
                            label="Review pull requests automatically"
                            hint="New pull requests, and new pushes to them, are reviewed and summarised in a comment."
                            checked={d.enabled}
                            disabled={!editable}
                            onChange={(v) => set({ enabled: v })}
                        />
                        <Toggle
                            label="Fail the check when a review finds something critical"
                            hint="The pull request's commit status fails, so branch protection can block the merge."
                            checked={d.failOnCritical}
                            disabled={!editable}
                            onChange={(v) => set({ failOnCritical: v })}
                        />
                        <Field label="Check for pull requests every (minutes)" hint="Used when there's no webhook. 1 to 60.">
                            {(p) => (
                                <Input
                                    {...p}
                                    type="number"
                                    min={1}
                                    max={60}
                                    value={d.pollMinutes}
                                    onChange={(e) => set({ pollMinutes: e.target.value })}
                                    disabled={!editable}
                                    className="w-32"
                                />
                            )}
                        </Field>
                        <Field label="Review time limit (minutes)" hint="A pull request review that runs longer is stopped. 5 to 720.">
                            {(p) => (
                                <Input
                                    {...p}
                                    type="number"
                                    min={5}
                                    max={720}
                                    value={d.reviewTimeoutMinutes}
                                    onChange={(e) => set({ reviewTimeoutMinutes: e.target.value })}
                                    disabled={!editable}
                                    className="w-32"
                                />
                            )}
                        </Field>
                    </SettingsSection>
                    <SettingsSection title="Full scans and branches">
                        <Field label="Nightly full scan of the default branch" hint="The hour it starts, in UTC.">
                            {(p) => (
                                <NativeSelect
                                    {...p}
                                    value={d.nightlyHourUtc}
                                    onChange={(e) => set({ nightlyHourUtc: e.target.value })}
                                    disabled={!editable}
                                    className="w-48"
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
                        <Field label="Full scan time limit (minutes)" hint="5 to 720.">
                            {(p) => (
                                <Input
                                    {...p}
                                    type="number"
                                    min={5}
                                    max={720}
                                    value={d.fullScanTimeoutMinutes}
                                    onChange={(e) => set({ fullScanTimeoutMinutes: e.target.value })}
                                    disabled={!editable}
                                    className="w-32"
                                />
                            )}
                        </Field>
                        <Field
                            label="Model token budget per review"
                            hint="A review that would use more tokens stops. Empty for no limit; at least 10,000."
                        >
                            {(p) => (
                                <Input
                                    {...p}
                                    type="number"
                                    min={10_000}
                                    value={d.maxTokensBudget}
                                    onChange={(e) => set({ maxTokensBudget: e.target.value })}
                                    disabled={!editable}
                                    className="w-48"
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
                        <div>
                            <Button type="submit" disabled={save.isPending || !form.dirty}>
                                {save.isPending ? "Saving…" : "Save changes"}
                            </Button>
                        </div>
                    )}
                </form>
            )}
        </SettingsPage>
    );
}
