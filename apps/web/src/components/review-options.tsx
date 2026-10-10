// The options a review with several models can have, as a list to tick: on Start a review (for that
// review), and in a project's settings (for reviews that don't choose their own). Each is off unless ticked.

import { CheckField, Field, NativeSelect } from "@/components/field";
import { Checkbox } from "@/components/ui/checkbox";
import type { RunOptionsInput } from "@/lib/types";

/** The options as they'd be sent for a review with this many models: no rule asks for more models than it has. */
export function optionsFor(value: RunOptionsInput, models: number): RunOptionsInput {
    const failAt = value.agreement?.failAt ?? null;
    return failAt === null ? value : { ...value, agreement: { ...value.agreement, failAt: Math.min(failAt, Math.max(models, 2)) } };
}

export function ReviewOptions({
    legend = "Options",
    value,
    models,
    project,
    disabled,
    onChange,
}: {
    legend?: string;
    value: RunOptionsInput;
    /** How many models the review has; for a project's own options, the most a review can have. */
    models: number;
    /** A project's own options: its reviews can have different numbers of models. */
    project?: boolean;
    disabled?: boolean;
    onChange(next: RunOptionsInput): void;
}) {
    const agreement = value.agreement ?? {};
    const failAt = agreement.failAt ? Math.min(agreement.failAt, Math.max(models, 2)) : null;
    const setAgreement = (patch: NonNullable<RunOptionsInput["agreement"]>) =>
        onChange({ ...value, agreement: { ...agreement, ...patch } });
    return (
        <fieldset className="grid gap-field" data-testid="review-options">
            <legend className="mb-field text-sm leading-snug font-medium">{legend}</legend>
            <div className="grid gap-2">
                <CheckField
                    label="Retry failed models once automatically"
                    hint="A model that fails or goes quiet is run once more by itself, and its findings are added to the report."
                >
                    {(p) => (
                        <Checkbox
                            {...p}
                            checked={value.retryFailed === true}
                            disabled={disabled}
                            onCheckedChange={(v) => onChange({ ...value, retryFailed: v === true })}
                        />
                    )}
                </CheckField>
                <CheckField
                    label={`Fail the pull request check only for criticals at least ${failAt ?? 2} models found`}
                    hint="Otherwise any critical finding fails it. Every finding is still kept, whoever found it."
                >
                    {(p) => (
                        <Checkbox
                            {...p}
                            checked={failAt !== null}
                            disabled={disabled}
                            onCheckedChange={(v) => setAgreement({ failAt: v === true ? 2 : null })}
                        />
                    )}
                </CheckField>
                {failAt !== null && models > 2 && (
                    <Field
                        label="How many models must have found it"
                        hint={project ? "A review with fewer models than this needs all of them to have found it." : undefined}
                        width="sm"
                        className="ps-7"
                    >
                        {(p) => (
                            <NativeSelect
                                {...p}
                                value={String(failAt)}
                                disabled={disabled}
                                onChange={(e) => setAgreement({ failAt: Number(e.target.value) })}
                            >
                                {Array.from({ length: models - 1 }, (_, i) => i + 2).map((n) => (
                                    <option key={n} value={String(n)}>
                                        {project ? `At least ${n}` : n === models ? `All ${n}` : `At least ${n} of ${models}`}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                )}
                <CheckField
                    label="Mark findings only one model found as lower confidence"
                    hint="They're labelled, can be filtered, and are listed after the others of their severity. Nothing about triage changes."
                >
                    {(p) => (
                        <Checkbox
                            {...p}
                            checked={agreement.markSingles === true}
                            disabled={disabled}
                            onCheckedChange={(v) => setAgreement({ markSingles: v === true })}
                        />
                    )}
                </CheckField>
            </div>
        </fieldset>
    );
}
