// A project's review models: none (the workspace's model), or two or three that each review the change,
// their findings merged into one list marked with the models that found them. Each uses the workspace's
// key for its provider, set in Settings → Models.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUp, Plus, X } from "lucide-react";
import { useId } from "react";
import { Field, FieldHint, FieldRow, FieldRowActions, NativeSelect } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { reviewModelQuery } from "@/lib/queries";
import type { ModelRef, Provider } from "@/lib/types";

export const MAX_MODELS = 3;

function ModelRow({
    index,
    value,
    providers,
    disabled,
    onChange,
    onRemove,
    onMoveUp,
}: {
    index: number;
    value: ModelRef;
    providers: Provider[];
    disabled: boolean;
    onChange(next: ModelRef): void;
    onRemove(): void;
    onMoveUp: (() => void) | null;
}) {
    const listId = useId();
    const legendId = useId();
    const provider = providers.find((p) => p.id === value.provider);
    const choices = provider ? [...new Set([provider.model, ...provider.suggested].filter(Boolean))] : [];
    const n = index + 1;
    return (
        <fieldset aria-labelledby={legendId} className="grid gap-field" data-testid="review-model-row">
            <legend id={legendId} className="mb-field text-sm font-medium">
                Model {n}
                {index === 0 && <span className="font-normal text-muted-foreground"> (its wording leads)</span>}
            </legend>
            <FieldRow columns="auto">
                <Field label="Provider" width="sm" error={provider && !provider.key.set ? `No ${provider.keyLabel} yet` : null}>
                    {(p) => (
                        <NativeSelect
                            {...p}
                            value={value.provider}
                            disabled={disabled}
                            onChange={(e) => {
                                const next = providers.find((x) => x.id === e.target.value);
                                onChange({ provider: e.target.value, model: next?.model ?? "" });
                            }}
                        >
                            {providers.map((x) => (
                                <option key={x.id} value={x.id}>
                                    {x.name}
                                    {x.key.set ? "" : " (no key)"}
                                </option>
                            ))}
                        </NativeSelect>
                    )}
                </Field>
                <Field label="Model" width="lg">
                    {(p) => (
                        <>
                            <Input
                                {...p}
                                list={listId}
                                value={value.model}
                                disabled={disabled}
                                onChange={(e) => onChange({ ...value, model: e.target.value })}
                                className="font-mono"
                                autoComplete="off"
                                spellCheck={false}
                            />
                            <datalist id={listId}>
                                {choices.map((c) => (
                                    <option key={c} value={c} />
                                ))}
                            </datalist>
                        </>
                    )}
                </Field>
                {!disabled && (
                    <FieldRowActions>
                        {onMoveUp && (
                            <Button type="button" variant="outline" size="sm" onClick={onMoveUp} aria-label={`Move model ${n} up`}>
                                <ArrowUp /> Up
                            </Button>
                        )}
                        <Button type="button" variant="outline" size="sm" onClick={onRemove} aria-label={`Remove model ${n}`}>
                            <X /> Remove
                        </Button>
                    </FieldRowActions>
                )}
            </FieldRow>
        </fieldset>
    );
}

export function ProjectModels({
    ws,
    value,
    disabled,
    onChange,
}: {
    ws: string;
    value: ModelRef[];
    disabled: boolean;
    onChange(next: ModelRef[]): void;
}) {
    const review = useQuery(reviewModelQuery(ws));
    const providers = review.data?.providers ?? [];
    const own = providers.find((p) => p.id === review.data?.provider);
    const keys = (
        <Link to="/w/$ws/settings/models" params={{ ws }} className="underline">
            Settings → Models
        </Link>
    );
    const fresh = (): ModelRef => {
        const taken = new Set(value.map((m) => `${m.provider}\0${m.model}`));
        const other = providers.find((p) => p.key.set && p.model && !taken.has(`${p.id}\0${p.model}`));
        return other ? { provider: other.id, model: other.model } : { provider: own?.id ?? providers[0]?.id ?? "openrouter", model: "" };
    };
    const set = (i: number, next: ModelRef) => onChange(value.map((m, j) => (j === i ? next : m)));

    if (!value.length)
        return (
            <div className="grid gap-field">
                <p className="text-sm">
                    Reviews use the workspace's model
                    {review.data?.model ? (
                        <>
                            : <span className="font-mono">{review.data.model}</span> via {own?.name ?? review.data.provider}
                        </>
                    ) : null}
                    .
                </p>
                <FieldHint>
                    Review with two or three models and each looks at the change; their findings are merged into one list, each marked with
                    the models that found it. Each model uses this workspace's key for its provider ({keys}) and spends its own tokens.
                </FieldHint>
                {/* Shown once the providers are known (not disabled meanwhile: it would fade in). */}
                {!disabled && providers.length > 0 && (
                    <div>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                                const first: ModelRef = { provider: own?.id ?? "openrouter", model: own?.model ?? "" };
                                const taken = `${first.provider}\0${first.model}`;
                                const second = providers.find((p) => p.key.set && p.model && `${p.id}\0${p.model}` !== taken) ?? null;
                                onChange([first, second ? { provider: second.id, model: second.model } : { ...first, model: "" }]);
                            }}
                        >
                            <Plus /> Review with several models
                        </Button>
                    </div>
                )}
            </div>
        );

    return (
        <div className="grid gap-form">
            {value.map((m, i) => (
                <ModelRow
                    // Rows are edited in place and reordered; the index is the row.
                    // biome-ignore lint/suspicious/noArrayIndexKey: see above
                    key={i}
                    index={i}
                    value={m}
                    providers={providers}
                    disabled={disabled}
                    onChange={(next) => set(i, next)}
                    onRemove={() => onChange(value.filter((_, j) => j !== i))}
                    onMoveUp={i > 0 ? () => onChange([...value.slice(0, i - 1), m, value[i - 1] as ModelRef, ...value.slice(i + 1)]) : null}
                />
            ))}
            <FieldHint>
                Each model reviews the change in turn, with this workspace's key for its provider ({keys}); the findings are merged into one
                list. A review takes as long, and costs as much, as its models put together. Remove them all to use the workspace's model
                again.
            </FieldHint>
            {!disabled && value.length < MAX_MODELS && (
                <div>
                    <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, fresh()])}>
                        <Plus /> Add a model
                    </Button>
                </div>
            )}
        </div>
    );
}
