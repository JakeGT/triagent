// The options a review with several models can have, as a list to tick: on Start a review (for that
// review), and in a project's settings (for reviews that don't choose their own). Each is off unless ticked.

import { CheckField, Field, FieldError, NativeSelect } from "@/components/field";
import { modelOptions } from "@/components/model-choice";
import { Checkbox } from "@/components/ui/checkbox";
import type { ModelChoices, RunOptionsInput } from "@/lib/types";

/** Where a favourite's id goes, for "the review's first model that can be asked" (JUDGE_FIRST on the server). */
const FIRST = "first";

/** The options as they'd be sent for a review with this many models: no rule asks for more models than it has. */
export function optionsFor(value: RunOptionsInput, models: number): RunOptionsInput {
    // Only comparing: the options about the report and the check aren't sent (a project's own may be on).
    if (value.bakeOff) return { bakeOff: true, ...(value.judge ? { judge: value.judge } : {}) };
    const failAt = value.agreement?.failAt ?? null;
    return failAt === null ? value : { ...value, agreement: { ...value.agreement, failAt: Math.min(failAt, Math.max(models, 2)) } };
}

export function ReviewOptions({
    legend = "Options",
    value,
    models,
    choices,
    chosen,
    project,
    disabled,
    onChange,
}: {
    legend?: string;
    value: RunOptionsInput;
    /** The models there are, to choose which is asked about the findings. */
    choices?: ModelChoices | undefined;
    /** The review's own models, in order (not for a project's own options: its reviews differ). */
    chosen?: readonly string[];
    /** How many models the review has; for a project's own options, the most a review can have. */
    models: number;
    /** A project's own options: its reviews can have different numbers of models. */
    project?: boolean;
    disabled?: boolean;
    onChange(next: RunOptionsInput): void;
}) {
    const agreement = value.agreement ?? {};
    const failAt = agreement.failAt ? Math.min(agreement.failAt, Math.max(models, 2)) : null;
    // Which model is asked about the findings: one that can be (not on Amazon Bedrock, nor the instance's).
    const judge = value.judge === true ? FIRST : value.judge || null;
    const able = (choices?.favourites ?? []).filter((f) => f.canJudge !== false);
    const names = new Map(modelOptions(choices).map((o) => [o.id, o.label]));
    const first = chosen?.find((id) => able.some((f) => f.id === id));
    const nobody = judge === FIRST && chosen !== undefined && choices !== undefined && first === undefined;
    const comparing = !project && value.bakeOff === true;
    const setAgreement = (patch: NonNullable<RunOptionsInput["agreement"]>) =>
        onChange({ ...value, agreement: { ...agreement, ...patch } });
    return (
        <fieldset className="grid gap-field" data-testid="review-options">
            <legend className="mb-field text-sm leading-snug font-medium">{legend}</legend>
            <div className="grid gap-2">
                {!project && (
                    <CheckField
                        label="Compare models only"
                        hint="The branch's report and triage are left as they are, and nothing is posted on the pull request. You get a page comparing what each model found."
                    >
                        {(p) => (
                            <Checkbox
                                {...p}
                                checked={comparing}
                                disabled={disabled}
                                // The options about the report and the check don't apply to a comparison: they're dropped.
                                onCheckedChange={(v) =>
                                    onChange(v === true ? { bakeOff: true, judge: value.judge ?? null } : { ...value, bakeOff: false })
                                }
                            />
                        )}
                    </CheckField>
                )}
                {!comparing && (
                    <>
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
                    </>
                )}
                <CheckField
                    label="Ask a model whether findings from different models are the same problem"
                    hint="Findings the models put in different places or categories are compared, up to 200 pairs a review, and those it says are the same are merged. It's sent what the findings say and where they are, never the code. Its tokens are counted with the review's."
                >
                    {(p) => (
                        <Checkbox
                            {...p}
                            checked={judge !== null}
                            disabled={disabled}
                            onCheckedChange={(v) => onChange({ ...value, judge: v === true ? FIRST : null })}
                        />
                    )}
                </CheckField>
                {judge !== null && (
                    <Field
                        label="Model to ask"
                        hint="A model on Amazon Bedrock can't be asked yet, nor can the instance's model."
                        width="lg"
                        className="ps-7"
                    >
                        {(p) => (
                            <NativeSelect
                                {...p}
                                value={judge}
                                disabled={disabled}
                                onChange={(e) => onChange({ ...value, judge: e.target.value })}
                            >
                                <option value={FIRST}>
                                    {first
                                        ? `The review's first model that can be (${names.get(first)})`
                                        : "The review's first model that can be"}
                                </option>
                                {able.map((f) => (
                                    <option key={f.id} value={f.id}>
                                        {names.get(f.id) ?? f.model}
                                    </option>
                                ))}
                                {judge !== FIRST && !able.some((f) => f.id === judge) && (
                                    <option value={judge}>A model that can't be asked now: choose another</option>
                                )}
                            </NativeSelect>
                        )}
                    </Field>
                )}
                {nobody && <FieldError className="ps-7" message="None of this review's models can be asked. Choose a model to ask." />}
                {!comparing && (
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
                )}
            </div>
        </fieldset>
    );
}
