import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { ConfirmAction } from "@/components/confirm-action";
import { CheckField, Field, FieldError } from "@/components/field";
import { FormActions } from "@/components/form";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api, errorMessage, paths } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { generalQuery, keys } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import type { Project } from "@/lib/types";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

interface General {
    name: string;
    repoUrl: string;
    defaultBranch: string;
}

const toForm = (p: Project): General => ({ name: p.name, repoUrl: p.repoUrl ?? "", defaultBranch: p.defaultBranch });

export function ProjectGeneral() {
    const { ws, slug, project } = useProject();
    const can = useCan();
    const editable = can("configure");
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const query = useQuery(generalQuery(ws, slug));
    const form = useDraft(query.data ? toForm(query.data) : undefined);
    const [purgeAnalytics, setPurgeAnalytics] = useState(false);

    const save = useMutation({
        mutationFn: (v: General) =>
            api.patch<Project>(`${paths.project(ws, slug)}/settings/general`, {
                name: v.name.trim(),
                repoUrl: v.repoUrl.trim() || null,
                defaultBranch: v.defaultBranch.trim(),
            }),
        onSuccess: (p) => {
            form.saved(toForm(p));
            queryClient.setQueryData(keys.projectSettings(ws, slug, "general"), p);
            void queryClient.invalidateQueries({ queryKey: keys.project(ws, slug) });
            void queryClient.invalidateQueries({ queryKey: keys.projects(ws) });
            toast.success("Project settings saved.");
        },
    });

    const remove = async () => {
        await api.delete(paths.project(ws, slug), { confirm: slug, purgeAnalytics });
        queryClient.removeQueries({ queryKey: keys.project(ws, slug) });
        await queryClient.invalidateQueries({ queryKey: keys.projects(ws) });
        toast.success(`Project ${project.name} deleted.`);
        await navigate({ to: "/w/$ws", params: { ws } });
    };

    const d = form.draft;
    return (
        <SettingsPage title="General" description={`Name, repository and default branch of ${project.name}.`}>
            {query.isPending || !d ? (
                query.isError ? (
                    <LoadError error={query.error} onRetry={() => query.refetch()} />
                ) : (
                    <LoadingRows rows={3} />
                )
            ) : (
                <SettingsSection title="Project">
                    {!editable && <ReadOnlyNote />}
                    <ChangedElsewhere show={form.changedElsewhere} onReload={form.reload} what="These settings" />
                    <form
                        className="grid gap-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            save.mutate(d);
                        }}
                    >
                        <Field label="Name">
                            {(p) => (
                                <Input
                                    {...p}
                                    value={d.name}
                                    onChange={(e) => form.setDraft({ ...d, name: e.target.value })}
                                    disabled={!editable}
                                    maxLength={80}
                                />
                            )}
                        </Field>
                        <Field
                            label="Repository URL"
                            hint="The GitHub repository, e.g. https://github.com/acme/app. Used for “View source” links."
                        >
                            {(p) => (
                                <Input
                                    {...p}
                                    type="url"
                                    value={d.repoUrl}
                                    onChange={(e) => form.setDraft({ ...d, repoUrl: e.target.value })}
                                    disabled={!editable}
                                    maxLength={300}
                                />
                            )}
                        </Field>
                        <Field label="Default branch" hint="Pages open on this branch, and other branches are compared with it.">
                            {(p) => (
                                <Input
                                    {...p}
                                    value={d.defaultBranch}
                                    onChange={(e) => form.setDraft({ ...d, defaultBranch: e.target.value })}
                                    disabled={!editable}
                                    maxLength={200}
                                    className="font-mono"
                                />
                            )}
                        </Field>
                        <p className="text-xs text-muted-foreground">
                            Project id: <span className="font-mono">{slug}</span> (used in addresses; it can't be changed).
                        </p>
                        <FieldError message={save.error ? errorMessage(save.error) : null} />
                        {editable && (
                            <FormActions>
                                <Button type="submit" disabled={save.isPending || !form.dirty}>
                                    {save.isPending ? "Saving…" : "Save changes"}
                                </Button>
                            </FormActions>
                        )}
                    </form>
                </SettingsSection>
            )}
            {editable && (
                <SettingsSection
                    title="Delete this project"
                    description="Removes every report, triage decision, note and setting of this project. This can't be undone. Its past reviews and activity stay in Analytics unless you choose to remove them too."
                >
                    <FormActions>
                        <ConfirmAction
                            trigger={<Button variant="destructive">Delete project</Button>}
                            title={`Delete ${project.name}?`}
                            description="All its reports, issues, tasks, notes and settings are deleted for everyone."
                            confirmLabel="Delete project"
                            typeToConfirm={slug}
                            onConfirm={remove}
                            onOpenChange={() => setPurgeAnalytics(false)}
                        >
                            <CheckField label="Also remove this project's past reviews and activity from Analytics">
                                {(p) => <Checkbox {...p} checked={purgeAnalytics} onCheckedChange={(v) => setPurgeAnalytics(v === true)} />}
                            </CheckField>
                        </ConfirmAction>
                    </FormActions>
                </SettingsSection>
            )}
        </SettingsPage>
    );
}
