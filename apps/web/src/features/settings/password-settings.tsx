import { toast } from "sonner";
import { PasswordForm } from "@/features/auth/password-form";
import { SettingsPage, SettingsSection } from "./settings-page";

export function PasswordSettings() {
    return (
        <SettingsPage title="Password" description="Changing your password signs you out everywhere else.">
            <SettingsSection title="Change your password">
                <PasswordForm onChanged={(n) => toast.success(`Password changed. Your other sessions were signed out (${n}).`)} />
            </SettingsSection>
        </SettingsPage>
    );
}
