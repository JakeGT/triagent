import { CheckField, type Choice, ChoiceField } from "@/components/field";
import { Switch } from "@/components/ui/switch";
import { type Theme, useTheme } from "@/context/theme-provider";
import { PREF, prefs, useShortcutsEnabled } from "@/lib/prefs";
import { SettingsPage, SettingsSection } from "./settings-page";

const THEMES: readonly Choice<Theme>[] = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "Same as system" },
];

/** Kept in this browser only. */
export function AppearanceSettings() {
    const { theme, setTheme } = useTheme();
    const shortcuts = useShortcutsEnabled();
    return (
        <SettingsPage title="Appearance" description="How Triagent looks and behaves in this browser.">
            <SettingsSection title="Theme">
                <ChoiceField legend="Theme" hideLegend name="theme" value={theme} onChange={setTheme} choices={THEMES} />
            </SettingsSection>
            <SettingsSection title="Keyboard">
                <CheckField
                    label="Single-key shortcuts"
                    hint={
                        <>
                            On the Issues page, <kbd>j</kbd> and <kbd>k</kbd> move to the next and previous issue, <kbd>x</kbd> selects it,{" "}
                            <kbd>1</kbd>–<kbd>4</kbd> set its status and <kbd>/</kbd> jumps to search. Turn them off if you use speech input
                            or press keys by accident.
                        </>
                    }
                >
                    {(p) => <Switch {...p} checked={shortcuts} onCheckedChange={(on) => prefs.set(PREF.shortcuts, on ? null : "off")} />}
                </CheckField>
            </SettingsSection>
        </SettingsPage>
    );
}
