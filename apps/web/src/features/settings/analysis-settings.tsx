// Settings → Analysis: the model a workspace asks to write about its reviews and findings (a comparison
// of a review's models, what a review changed, answers to questions), and what's written without being
// asked. Admins choose; everyone can see what's chosen and whether it can be asked now.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { CheckField, Field, FieldError, NativeSelect } from "@/components/field";
import { FormActions } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { analysisKeys, analysisSettingsQuery, type AnalysisSettings as Settings } from "@/lib/analysis";
import { api, errorMessage, paths } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { useWorkspace } from "@/lib/session";
import { ReadOnlyNote, SettingsPage, SettingsSection, StatusNote } from "./settings-page";

type Draft = Pick<Settings, "model" | "afterReview">;

export function AnalysisSettings() {
    const { ws, can } = useWorkspace();
    const queryClient = useQueryClient();
    const query = useQuery(analysisSettingsQuery(ws));
    const data = query.data;
    const form = useDraft<Draft>(data ? { model: data.model, afterReview: data.afterReview } : undefined);
    const save = useMutation({
        mutationFn: (v: Draft) => api.put<Settings>(`${paths.workspace(ws)}/settings/analysis`, v),
        onSuccess: async (v) => {
            form.saved({ model: v.model, afterReview: v.afterReview });
            queryClient.setQueryData(analysisKeys.settings(ws), v);
            await queryClient.invalidateQueries({ queryKey: analysisKeys.all(ws) });
            toast.success("Analysis settings saved.");
        },
    });
    const editable = can("configure");
    const d = form.draft;

    return (
        <SettingsPage
            title="Analysis"
            description="A model can write about your reviews: how a review's models compare, what a review changed, and answers to questions on the Analytics page. It's sent figures and findings' titles and places, never code."
        >
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} title="Couldn't load the analysis settings" />
            ) : !data || !d ? (
                <LoadingRows rows={4} />
            ) : (
                <>
                    {!editable && <ReadOnlyNote />}
                    <ChangedElsewhere show={form.changedElsewhere} onReload={form.reload} what="These settings" />
                    <StatusNote data-testid="analysis-status">
                        {data.ready
                            ? `Ready: ${data.label} is asked. ${data.limit.lastHour} of ${data.limit.perHour} analyses used this hour.`
                            : data.reason}
                    </StatusNote>
                    <form
                        className="grid gap-section"
                        onSubmit={(e) => {
                            e.preventDefault();
                            save.mutate(d);
                        }}
                    >
                        <SettingsSection title="Model" description="One of this workspace's models, asked with the workspace's own key.">
                            <Field
                                label="Model for analysis"
                                width="lg"
                                hint={
                                    <>
                                        Each piece of writing is one or two requests of a few thousand tokens, counted under Analytics →
                                        Reviews & cost. Add a model in{" "}
                                        <Link to="/w/$ws/settings/models" params={{ ws }} className="link">
                                            Settings → Models
                                        </Link>{" "}
                                        to see it here.
                                    </>
                                }
                            >
                                {(p) => (
                                    <NativeSelect
                                        {...p}
                                        value={d.model ?? ""}
                                        disabled={!editable}
                                        onChange={(e) => form.setDraft({ ...d, model: e.target.value || null })}
                                    >
                                        <option value="">None: nothing is asked</option>
                                        {data.models.map((m) => (
                                            <option key={m.id} value={m.id} disabled={!m.canBeAsked}>
                                                {m.name} ({m.providerName})
                                                {!m.canBeAsked
                                                    ? ": can't be asked on Amazon Bedrock"
                                                    : !m.ready
                                                      ? `: needs ${m.missing}`
                                                      : ""}
                                            </option>
                                        ))}
                                    </NativeSelect>
                                )}
                            </Field>
                        </SettingsSection>
                        <SettingsSection
                            title="After each review"
                            description="Written as soon as a review finishes, without anyone asking. Otherwise each is a button on the review's page."
                        >
                            <CheckField
                                label="Write what the review changed"
                                hint="What's new, what's no longer reported and what came back."
                            >
                                {(p) => (
                                    <Checkbox
                                        {...p}
                                        checked={d.afterReview.summary}
                                        disabled={!editable}
                                        onCheckedChange={(v) =>
                                            form.setDraft({ ...d, afterReview: { ...d.afterReview, summary: v === true } })
                                        }
                                    />
                                )}
                            </CheckField>
                            <CheckField label="Compare its models" hint="For reviews two or more models finished.">
                                {(p) => (
                                    <Checkbox
                                        {...p}
                                        checked={d.afterReview.comparison}
                                        disabled={!editable}
                                        onCheckedChange={(v) =>
                                            form.setDraft({ ...d, afterReview: { ...d.afterReview, comparison: v === true } })
                                        }
                                    />
                                )}
                            </CheckField>
                        </SettingsSection>
                        <FieldError message={save.error ? errorMessage(save.error) : null} />
                        {editable && (
                            <FormActions>
                                <Button type="submit" disabled={save.isPending || !form.dirty}>
                                    {save.isPending ? "Saving…" : "Save"}
                                </Button>
                            </FormActions>
                        )}
                    </form>
                </>
            )}
        </SettingsPage>
    );
}
