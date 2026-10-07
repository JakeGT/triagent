import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { FieldError } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { api, errorMessage, paths } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { keys } from "@/lib/queries";
import { useMe } from "@/lib/session";
import type { NotifyPrefs } from "@/lib/types";
import { SettingsPage, SettingsSection } from "./settings-page";

const SCOPES: { value: NotifyPrefs["scope"]; label: string; hint: string }[] = [
    { value: "mine", label: "Reviews I start", hint: "Including those started by API tokens that act for you." },
    { value: "all", label: "Every review in my workspaces", hint: "Useful for whoever looks after a project." },
    { value: "none", label: "None", hint: "No notifications about finished reviews." },
];

export function NotificationsSettings() {
    const me = useMe();
    const queryClient = useQueryClient();
    const id = useId();
    const form = useDraft<NotifyPrefs>(me.notify);
    const save = useMutation({
        mutationFn: (v: NotifyPrefs) => api.put<NotifyPrefs>(`${paths.me}/notifications`, v),
        onSuccess: async (v) => {
            form.saved(v);
            await queryClient.invalidateQueries({ queryKey: keys.me });
            toast.success("Notification settings saved.");
        },
    });
    const d = form.draft ?? me.notify;
    return (
        <SettingsPage title="Notifications" description="Which finished reviews you hear about.">
            <ChangedElsewhere show={form.changedElsewhere} onReload={form.reload} what="Your notification settings" />
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    save.mutate(d);
                }}
                className="grid gap-4"
            >
                <SettingsSection title="Finished reviews">
                    <fieldset className="grid gap-2">
                        <legend className="sr-only">Tell me about</legend>
                        {SCOPES.map((s) => (
                            <label key={s.value} htmlFor={`${id}-${s.value}`} className="flex items-start gap-2 text-sm">
                                <input
                                    type="radio"
                                    id={`${id}-${s.value}`}
                                    name="scope"
                                    value={s.value}
                                    checked={d.scope === s.value}
                                    onChange={() => form.setDraft({ ...d, scope: s.value })}
                                    className="mt-1 accent-primary"
                                />
                                <span>
                                    <span className="font-medium">{s.label}</span>
                                    <span className="block text-xs text-muted-foreground">{s.hint}</span>
                                </span>
                            </label>
                        ))}
                    </fieldset>
                    <div className="flex items-center gap-2">
                        <Checkbox
                            id={`${id}-problems`}
                            checked={d.problemsOnly}
                            onCheckedChange={(v) => form.setDraft({ ...d, problemsOnly: v === true })}
                            disabled={d.scope === "none"}
                        />
                        <Label htmlFor={`${id}-problems`}>Only when a review fails or finds something critical</Label>
                    </div>
                </SettingsSection>
                <FieldError message={save.error ? errorMessage(save.error) : null} />
                <div>
                    <Button type="submit" disabled={save.isPending || !form.dirty}>
                        {save.isPending ? "Saving…" : "Save"}
                    </Button>
                </div>
            </form>
        </SettingsPage>
    );
}
