// Choosing a review's models: the workspace's favourite models (and the instance's model, when the
// workspace has an allowance) as a list to tick, up to a few. They review in the order they were ticked,
// and the first one's wording leads, so the order is said underneath.

import { type ReactNode, useId } from "react";
import { CheckField, FieldHint } from "@/components/field";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import type { ModelChoices } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ModelOption {
    id: string;
    /** What people call it: its nickname, or the model's own name. */
    label: string;
    /** The model (when it has a nickname) and its provider. */
    detail: string;
    /** Why it can't review yet, if it can't. */
    notReady: string | null;
}

/** Everything that can be chosen: the favourites in their order, then the instance's model. */
export function modelOptions(choices: ModelChoices | undefined): ModelOption[] {
    if (!choices) return [];
    const options: ModelOption[] = choices.favourites.map((f) => ({
        id: f.id,
        label: f.name ?? f.model,
        detail: f.name ? `${f.model} · ${f.providerName}` : f.providerName,
        notReady: f.ready ? null : `Not ready: add ${f.missing ?? "its provider's key"} in Settings → Models.`,
    }));
    if (choices.instance)
        options.push({
            id: choices.instance.id,
            label: choices.instance.name,
            detail: `${choices.instance.model ?? "No model yet"} · the instance's key, from this workspace's monthly allowance`,
            notReady: choices.instance.ready ? null : `Not ready: ${choices.instance.reason}`,
        });
    return options;
}

/** What to call a model that was chosen once but isn't on offer now (a favourite removed, the allowance taken away). */
const goneLabel = (id: string) => (id === "instance" ? "Instance model" : "A model that isn't a favourite any more");

/**
 * What people call the models with these ids, in order. One that's gone is still named (as the list to
 * tick names it), so a review that would wait for it, or fail, isn't shown as if it used the others only.
 * Nothing until the choices are known.
 */
export function modelLabels(choices: ModelChoices | undefined, ids: readonly string[]): string[] {
    if (!choices) return [];
    const options = modelOptions(choices);
    return ids.map((id) => options.find((o) => o.id === id)?.label ?? goneLabel(id));
}

/** Models as chips: what a review ran with, or will. */
export function ModelChips({ labels, className, ...props }: { labels: readonly string[] } & React.ComponentProps<"span">) {
    return (
        <span className={cn("inline-flex flex-wrap items-center gap-1 align-middle", className)} {...props}>
            {labels.map((label, i) => (
                // Labels in one review are never the same, but the position is what a chip is.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <Badge key={i} variant="outline" className="max-w-full font-mono font-normal whitespace-normal">
                    {label}
                </Badge>
            ))}
        </span>
    );
}

/** Tick up to `max` models. `empty` says what happens with none ticked. */
export function ModelChoice({
    legend,
    hideLegend,
    hint,
    options,
    value,
    max,
    disabled,
    empty,
    onChange,
}: {
    legend: ReactNode;
    /** For a list whose section or switch already says what it is. */
    hideLegend?: boolean;
    hint?: ReactNode;
    options: readonly ModelOption[];
    value: readonly string[];
    max: number;
    disabled?: boolean;
    empty: ReactNode;
    onChange(next: string[]): void;
}) {
    const id = useId();
    // Chosen once, but not on offer now (the allowance was taken away, say): shown, so it can be unticked.
    const gone: ModelOption[] = value
        .filter((v) => !options.some((o) => o.id === v))
        .map((v) => ({
            id: v,
            label: goneLabel(v),
            detail: "Not available now: untick it.",
            notReady: null,
        }));
    const all = [...options, ...gone];
    const chosen = value.flatMap((v) => all.find((o) => o.id === v) ?? []);
    const full = value.length >= max;
    return (
        <fieldset className="grid gap-field" aria-describedby={`${id}-order${hint ? ` ${id}-hint` : ""}`} data-model-choice="">
            <legend className={cn("mb-field text-sm leading-snug font-medium", hideLegend && "sr-only")}>{legend}</legend>
            <div className="grid gap-2">
                {all.map((o) => {
                    const checked = value.includes(o.id);
                    return (
                        <CheckField
                            key={o.id}
                            label={o.label}
                            hint={
                                <>
                                    {o.detail}
                                    {o.notReady && <span className="block">{o.notReady}</span>}
                                </>
                            }
                        >
                            {(p) => (
                                <Checkbox
                                    {...p}
                                    checked={checked}
                                    disabled={disabled || (!checked && full)}
                                    onCheckedChange={(v) => onChange(v === true ? [...value, o.id] : value.filter((x) => x !== o.id))}
                                />
                            )}
                        </CheckField>
                    );
                })}
            </div>
            <p id={`${id}-order`} className="text-sm" data-testid="models-chosen">
                {chosen.length === 0
                    ? empty
                    : chosen.length === 1
                      ? `Reviews with ${chosen[0]?.label}.`
                      : `Reviews with ${chosen.map((o) => o.label).join(", then ")}: each reviews it, and their findings are merged. ${chosen[0]?.label}'s wording leads.`}
            </p>
            {hint && <FieldHint id={`${id}-hint`}>{hint}</FieldHint>}
        </fieldset>
    );
}
