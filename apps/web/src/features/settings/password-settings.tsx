import { toast } from "sonner";
import { PasswordForm } from "@/features/auth/password-form";
import { useMe } from "@/lib/session";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

export function PasswordSettings() {
    const me = useMe();
    if (me.authMode !== "local")
        return (
            <SettingsPage title="Password">
                <ReadOnlyNote>You sign in through your identity provider, so your password is changed there, not here.</ReadOnlyNote>
            </SettingsPage>
        );
    return (
        <SettingsPage title="Password" description="Changing your password signs you out everywhere else.">
            <SettingsSection title="Change your password">
                <PasswordForm onChanged={(n) => toast.success(`Password changed. Your other sessions were signed out (${n}).`)} />
            </SettingsSection>
        </SettingsPage>
    );
}
