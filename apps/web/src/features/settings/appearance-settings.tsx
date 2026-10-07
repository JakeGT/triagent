import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { type Theme, useTheme } from "@/context/theme-provider";
import { PREF, prefs, useShortcutsEnabled } from "@/lib/prefs";
import { SettingsPage, SettingsSection } from "./settings-page";

const THEMES: { value: Theme; label: string }[] = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "Same as system" },
];

/** Kept in this browser only. */
export function AppearanceSettings() {
    const { theme, setTheme } = useTheme();
    const shortcuts = useShortcutsEnabled();
    const id = useId();
    return (
        <SettingsPage title="Appearance" description="How Triagent looks and behaves in this browser.">
            <SettingsSection title="Theme">
                <fieldset className="grid gap-2">
                    <legend className="sr-only">Theme</legend>
                    {THEMES.map((t) => (
                        <label key={t.value} htmlFor={`${id}-${t.value}`} className="flex items-center gap-2 text-sm">
                            <input
                                type="radio"
                                id={`${id}-${t.value}`}
                                name="theme"
                                value={t.value}
                                checked={theme === t.value}
                                onChange={() => setTheme(t.value)}
                                className="accent-primary"
                            />
                            {t.label}
                        </label>
                    ))}
                </fieldset>
            </SettingsSection>
            <SettingsSection title="Keyboard">
                <div className="flex items-start gap-3">
                    <Switch
                        id={`${id}-shortcuts`}
                        checked={shortcuts}
                        onCheckedChange={(on) => prefs.set(PREF.shortcuts, on ? null : "off")}
                        aria-describedby={`${id}-shortcuts-hint`}
                        className="mt-0.5"
                    />
                    <div className="grid gap-1">
                        <Label htmlFor={`${id}-shortcuts`}>Single-key shortcuts</Label>
                        <p id={`${id}-shortcuts-hint`} className="text-sm text-muted-foreground">
                            On the Issues page, <kbd>j</kbd> and <kbd>k</kbd> move to the next and previous issue, <kbd>x</kbd> selects it,{" "}
                            <kbd>1</kbd>–<kbd>4</kbd> set its status and <kbd>/</kbd> jumps to search. Turn them off if you use speech input
                            or press keys by accident.
                        </p>
                    </div>
                </div>
            </SettingsSection>
        </SettingsPage>
    );
}
