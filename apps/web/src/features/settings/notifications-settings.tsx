import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { CheckField, type Choice, ChoiceField, FieldError } from "@/components/field";
import { FormActions } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { api, errorMessage, paths } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { PREF, prefs, usePref } from "@/lib/prefs";
import { keys } from "@/lib/queries";
import { useMe } from "@/lib/session";
import type { NotifyPrefs } from "@/lib/types";
import { SettingsPage, SettingsSection } from "./settings-page";

const SCOPES: readonly Choice<NotifyPrefs["scope"]>[] = [
    { value: "mine", label: "Reviews I start", hint: "Including those started by API tokens that act for you." },
    { value: "all", label: "Every review in my workspaces", hint: "Useful for whoever looks after a project." },
    { value: "none", label: "None", hint: "No notifications about finished reviews." },
];

export function NotificationsSettings() {
    const me = useMe();
    const queryClient = useQueryClient();
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
            <SettingsSection title="Finished reviews">
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        save.mutate(d);
                    }}
                    className="grid gap-form"
                >
                    <ChoiceField
                        legend="Tell me about"
                        name="scope"
                        value={d.scope}
                        onChange={(scope) => form.setDraft({ ...d, scope })}
                        choices={SCOPES}
                    />
                    <CheckField label="Only when a review fails or finds something critical">
                        {(p) => (
                            <Checkbox
                                {...p}
                                checked={d.problemsOnly}
                                onCheckedChange={(v) => form.setDraft({ ...d, problemsOnly: v === true })}
                                disabled={d.scope === "none"}
                            />
                        )}
                    </CheckField>
                    <FieldError message={save.error ? errorMessage(save.error) : null} />
                    <FormActions>
                        <Button type="submit" disabled={save.isPending || !form.dirty}>
                            {save.isPending ? "Saving…" : "Save"}
                        </Button>
                    </FormActions>
                </form>
            </SettingsSection>
            <DesktopNotifications />
        </SettingsPage>
    );
}

/** Desktop notifications are a choice for this browser, so they're kept here rather than on the account. */
function DesktopNotifications() {
    const on = usePref(PREF.desktopNotify) === "on";
    const supported = typeof window !== "undefined" && "Notification" in window;
    const [denied, setDenied] = useState(supported && Notification.permission === "denied");
    return (
        <SettingsSection
            title="In this browser"
            description="Finished reviews always appear as a message on the page. They can also appear as desktop notifications while this tab isn't in view."
        >
            {!supported ? (
                <p className="text-sm text-muted-foreground">This browser doesn't support desktop notifications.</p>
            ) : (
                <CheckField
                    label="Show desktop notifications"
                    hint={denied ? "This browser blocks notifications from Triagent. Allow them in its site settings first." : undefined}
                >
                    {(p) => (
                        <Checkbox
                            {...p}
                            checked={on && Notification.permission === "granted"}
                            disabled={denied}
                            onCheckedChange={async (v) => {
                                if (v !== true) return prefs.set(PREF.desktopNotify, null);
                                const permission =
                                    Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
                                setDenied(permission === "denied");
                                prefs.set(PREF.desktopNotify, permission === "granted" ? "on" : null);
                            }}
                        />
                    )}
                </CheckField>
            )}
        </SettingsSection>
    );
}
