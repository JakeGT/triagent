// A project's review models: a set for every review, and optional sets for pull requests, branch changes
// and full scans, which win for that kind of review. Each is chosen from the workspace's favourite models
// (Settings → Models); with none chosen, reviews use the workspace default.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckField } from "@/components/field";
import { ModelChoice, modelLabels, modelOptions } from "@/components/model-choice";
import { Switch } from "@/components/ui/switch";
import { modelsQuery } from "@/lib/queries";
import type { ProjectModels as Saved } from "@/lib/types";

/** The sets as the form holds them: a kind's set is null while that kind uses the project's. */
export interface ModelSets {
    all: string[];
    pr: string[] | null;
    changes: string[] | null;
    full: string[] | null;
}

const KINDS = [
    {
        key: "pr",
        label: "Use different models for pull requests",
        hint: "Reviews of pull requests, automatic or asked for.",
        legend: "Models for pull requests",
        what: "pull requests",
    },
    {
        key: "changes",
        label: "Use different models for branch changes",
        hint: "Reviews of what a branch changed since it left its base.",
        legend: "Models for branch changes",
        what: "branch changes",
    },
    {
        key: "full",
        label: "Use different models for full scans",
        hint: "Scans of a whole branch, the nightly one included.",
        legend: "Models for full scans",
        what: "full scans",
    },
] as const;

export const toModelSets = (m: Saved | undefined): ModelSets => ({
    all: m?.all ?? [],
    pr: m?.pr?.length ? m.pr : null,
    changes: m?.changes?.length ? m.changes : null,
    full: m?.full?.length ? m.full : null,
});

/** What to save. Throws, saying which, when a kind is switched on with nothing ticked. */
export function fromModelSets(sets: ModelSets): Saved {
    const out: Saved = {};
    if (sets.all.length) out.all = sets.all;
    for (const k of KINDS) {
        const ids = sets[k.key];
        if (ids === null) continue;
        if (!ids.length) throw new Error(`Tick at least one model for ${k.what}, or switch that off.`);
        out[k.key] = ids;
    }
    return out;
}

export function ProjectModels({
    ws,
    value,
    disabled,
    onChange,
}: {
    ws: string;
    value: ModelSets;
    disabled: boolean;
    onChange(next: ModelSets): void;
}) {
    const choices = useQuery(modelsQuery(ws));
    const options = modelOptions(choices.data);
    const max = choices.data?.max ?? 3;
    const usual = modelLabels(choices.data, choices.data?.fallback ?? []).join(", ");
    const settings = (
        <Link to="/w/$ws/settings/models" params={{ ws }} className="underline">
            Settings → Models
        </Link>
    );
    // The lists appear once the favourites are known (nothing is shown disabled meanwhile: it would fade in).
    if (!choices.data) return null;
    if (!options.length)
        return <p className="text-sm">This workspace has no favourite models yet. Add one in {settings}, then choose here.</p>;
    return (
        <div className="grid gap-form">
            <ModelChoice
                legend="For every review"
                hint={
                    <>
                        Up to {max}, from this workspace's favourite models; add more in {settings}. Each model spends its own tokens, and a
                        review takes as long as its models put together.
                    </>
                }
                options={options}
                value={value.all}
                max={max}
                disabled={disabled}
                empty={`None ticked: reviews use the workspace default${usual ? `, ${usual}` : ""}.`}
                onChange={(all) => onChange({ ...value, all })}
            />
            {KINDS.map((k) => {
                const ids = value[k.key];
                return (
                    <div key={k.key} className="grid gap-form">
                        <CheckField label={k.label} hint={k.hint}>
                            {(p) => (
                                <Switch
                                    {...p}
                                    checked={ids !== null}
                                    onCheckedChange={(on) => onChange({ ...value, [k.key]: on ? [] : null })}
                                    disabled={disabled}
                                />
                            )}
                        </CheckField>
                        {ids !== null && (
                            <ModelChoice
                                legend={k.legend}
                                options={options}
                                value={ids}
                                max={max}
                                disabled={disabled}
                                empty={`None ticked yet: tick the models for ${k.what}.`}
                                onChange={(next) => onChange({ ...value, [k.key]: next })}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}
