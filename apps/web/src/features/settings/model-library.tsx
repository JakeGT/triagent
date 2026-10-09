// A workspace's models: the providers it has connected (each opens to its settings and keys, the same
// form the instance key uses) and its favourites, the models reviews can use, one of them the default.
// Shown in Settings → Models and in the workspace's guided setup.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { CheckField, Field, FieldError, FieldRow, FieldRowActions, NativeSelect } from "@/components/field";
import { FormActions } from "@/components/form";
import { ModelPicker } from "@/components/model-picker";
import { describeSecret } from "@/components/secret-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, isApiError, paths } from "@/lib/api";
import { insightKeys } from "@/lib/insights-queries";
import { keys } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import type { Favourite, ModelSet, Provider, ReviewModel } from "@/lib/types";
import { groups, ModelField, ModelProviderForm } from "./model-provider-form";
import { ReadOnlyNote, SettingsSection } from "./settings-page";

export const MAX_FAVOURITES = 20;
export const MAX_FAVOURITE_NAME = 40;

/** What people call a favourite: its nickname, or the model's own name. */
export const favouriteLabel = (f: Pick<Favourite, "name" | "model">) => f.name ?? f.model;

/** A project whose reviews use a favourite, and in which of its sets (the server's 409 when one is removed). */
interface FavouriteUse {
    slug: string;
    name: string;
    sets: ModelSet[];
}

const SET_WORDS: Record<ModelSet, string> = { all: "every review", pr: "pull requests", changes: "branch changes", full: "full scans" };

/** The projects using a favourite, from the server's refusal to remove it; null for any other error. */
function usesFrom(err: unknown): FavouriteUse[] | null {
    return isApiError(err, 409) && err.code === "favourite_in_use" ? (err.body.projects as FavouriteUse[]) : null;
}

/** Which projects' reviews use the favourite being removed, and what removing it does to them. */
function InUse({ uses }: { uses: FavouriteUse[] }) {
    return (
        <div className="grid gap-2" data-testid="favourite-in-use">
            <p>These projects' reviews use it:</p>
            <ul className="list-disc ps-5">
                {uses.map((u) => (
                    <li key={u.slug}>
                        {u.name} ({u.sets.map((k) => SET_WORDS[k]).join(", ")})
                    </li>
                ))}
            </ul>
            <p>Removing it takes it out of their review models too. A project left with none uses the workspace default.</p>
        </div>
    );
}

/** `ids` with the one at `index` moved one place up (-1) or down (1); unchanged at either end. */
export function moved(ids: readonly string[], index: number, by: -1 | 1): string[] {
    const to = index + by;
    const out = [...ids];
    if (index < 0 || index >= out.length || to < 0 || to >= out.length) return out;
    [out[index], out[to]] = [out[to] as string, out[index] as string];
    return out;
}

/** "Ready", or what's still needed. */
function Readiness({ missing }: { missing: string | null }) {
    return missing === null ? (
        <span className="inline-flex items-center gap-1.5">
            <Check className="size-4 shrink-0 text-st-resolved" aria-hidden="true" />
            Ready
        </span>
    ) : (
        <span className="inline-flex items-start gap-1.5">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            Needs {missing}
        </span>
    );
}

export function ModelLibrary({
    data,
    setup,
}: {
    data: ReviewModel /** In the guided setup: worded for a first model. */;
    setup?: boolean;
}) {
    const { ws, can } = useWorkspace();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState<string | null>(null);
    const detailId = useId();
    const base = `${paths.workspace(ws)}/settings/review-model`;
    const queryKey = keys.wsSettings(ws, "review-model");
    const refresh = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey }),
            queryClient.invalidateQueries({ queryKey: insightKeys.allowance(ws) }),
            // What reviews can be given, and what projects' reviews use (removing a favourite can change that).
            queryClient.invalidateQueries({ queryKey: keys.models(ws) }),
        ]);
    const canConfigure = can("configure");
    const canSetSecrets = can("secrets");
    const shown = data.providers.filter((p) => p.connected || p.id === open);
    const rest = data.providers.filter((p) => !p.connected && p.id !== open);
    const opened = data.providers.find((p) => p.id === open);

    return (
        <>
            <SettingsSection
                title="Providers"
                description="Where models come from. Each provider has its own key and settings, and several can be connected at once."
            >
                {!canConfigure && <ReadOnlyNote />}
                {shown.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No providers connected yet.</p>
                ) : (
                    <TableFrame>
                        <Table data-testid="providers">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Provider</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Key</TableHead>
                                    <TableHead>
                                        <span className="sr-only">Actions</span>
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {shown.map((p) => (
                                    <TableRow key={p.id}>
                                        <TableCell className="font-medium">{p.name}</TableCell>
                                        <TableCell className="min-w-36 whitespace-normal">
                                            <Readiness missing={p.needs} />
                                        </TableCell>
                                        <TableCell className="min-w-40 text-xs whitespace-normal text-muted-foreground">
                                            {describeSecret(p.key)}
                                        </TableCell>
                                        <TableCell className="text-end">
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant={p.id === open ? "secondary" : "outline"}
                                                aria-expanded={p.id === open}
                                                aria-controls={p.id === open ? detailId : undefined}
                                                onClick={() => setOpen(p.id === open ? null : p.id)}
                                            >
                                                {p.id === open ? "Close" : canConfigure || canSetSecrets ? "Edit" : "View"}
                                                <span className="sr-only"> {p.name}</span>
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableFrame>
                )}
                {(canConfigure || canSetSecrets) && rest.length > 0 && <AddProvider providers={rest} onAdd={setOpen} />}
            </SettingsSection>
            {opened && (
                <div id={detailId} className="grid grid-cols-[minmax(0,1fr)] gap-section" data-testid="provider-detail">
                    <ModelProviderForm
                        // A form of its own for each provider: nothing typed for one carries over to the next.
                        key={opened.id}
                        data={data}
                        base={base}
                        ws={ws}
                        queryKey={queryKey}
                        scope="workspace"
                        only={opened.id}
                        canConfigure={canConfigure}
                        canSetSecrets={canSetSecrets}
                        onSaved={(m) => {
                            queryClient.setQueryData(queryKey, m);
                            void queryClient.invalidateQueries({ queryKey: insightKeys.allowance(ws) });
                        }}
                        refresh={refresh}
                    />
                </div>
            )}
            <Favourites data={data} canConfigure={canConfigure} refresh={refresh} />
            {canConfigure && (
                <AddFavourite
                    data={data}
                    title={!setup ? "Add a favourite" : data.favourites.length ? "Add another model" : "Choose a model"}
                    base={base}
                    refresh={refresh}
                />
            )}
        </>
    );
}

function AddProvider({ providers, onAdd }: { providers: Provider[]; onAdd(id: string): void }) {
    const [chosen, setChosen] = useState("");
    const id = providers.some((p) => p.id === chosen) ? chosen : (providers[0]?.id ?? "");
    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                if (id) onAdd(id);
            }}
        >
            <FieldRow columns="auto">
                <Field label="Add a provider" width="md">
                    {(f) => (
                        <NativeSelect {...f} value={id} onChange={(e) => setChosen(e.target.value)}>
                            {groups(providers).map(([group, members]) => (
                                <optgroup key={group} label={group}>
                                    {members.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.name}
                                        </option>
                                    ))}
                                </optgroup>
                            ))}
                        </NativeSelect>
                    )}
                </Field>
                <FieldRowActions>
                    <Button type="submit" variant="outline">
                        Add provider
                    </Button>
                </FieldRowActions>
            </FieldRow>
        </form>
    );
}

function Favourites({ data, canConfigure, refresh }: { data: ReviewModel; canConfigure: boolean; refresh(): Promise<unknown> }) {
    const { ws } = useWorkspace();
    const base = `${paths.workspace(ws)}/settings/models`;
    const list = data.favourites;
    const [renaming, setRenaming] = useState<Favourite | null>(null);
    const [removing, setRemoving] = useState<Favourite | null>(null);
    const change = useMutation({
        mutationFn: (c: { run(): Promise<unknown>; done: string }) => c.run(),
        onSuccess: async (_r, c) => {
            await refresh();
            toast.success(c.done);
        },
        onError: (err) => toast.error(errorMessage(err)),
    });
    const move = (index: number, by: -1 | 1) =>
        change.mutate({
            run: () =>
                api.put(`${base}/favourites/order`, {
                    ids: moved(
                        list.map((f) => f.id),
                        index,
                        by,
                    ),
                }),
            done: `${favouriteLabel(list[index] as Favourite)} moved ${by < 0 ? "up" : "down"}.`,
        });

    return (
        <SettingsSection
            title="Favourites"
            description="The models this workspace reviews with. Reviews use the default unless a project, or the person starting one, chooses others."
        >
            {list.length === 0 ? (
                <p className="text-sm text-muted-foreground">No favourite models yet. Connect a provider, then add one of its models.</p>
            ) : (
                <TableFrame>
                    <Table data-testid="favourites">
                        <TableHeader>
                            <TableRow>
                                <TableHead>Model</TableHead>
                                <TableHead>Provider</TableHead>
                                <TableHead>Status</TableHead>
                                {canConfigure && (
                                    <TableHead>
                                        <span className="sr-only">Actions</span>
                                    </TableHead>
                                )}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {list.map((f, i) => {
                                const label = favouriteLabel(f);
                                return (
                                    <TableRow key={f.id}>
                                        <TableCell className="min-w-72 whitespace-normal">
                                            <div className="flex flex-wrap items-center gap-2">
                                                {f.name && <span className="font-medium">{f.name}</span>}
                                                {f.isDefault && <Badge variant="secondary">Default</Badge>}
                                            </div>
                                            <div className="font-mono text-xs break-all">{f.model}</div>
                                        </TableCell>
                                        <TableCell>{f.providerName}</TableCell>
                                        <TableCell className="min-w-36 whitespace-normal">
                                            <Readiness missing={f.missing} />
                                        </TableCell>
                                        {canConfigure && (
                                            <TableCell>
                                                <div className="flex items-center justify-end gap-1">
                                                    {list.length > 1 && (
                                                        <>
                                                            <Button
                                                                type="button"
                                                                size="icon"
                                                                variant="ghost"
                                                                className="size-8"
                                                                aria-label={`Move ${label} up`}
                                                                disabled={i === 0 || change.isPending}
                                                                onClick={() => move(i, -1)}
                                                            >
                                                                <ArrowUp />
                                                            </Button>
                                                            <Button
                                                                type="button"
                                                                size="icon"
                                                                variant="ghost"
                                                                className="size-8"
                                                                aria-label={`Move ${label} down`}
                                                                disabled={i === list.length - 1 || change.isPending}
                                                                onClick={() => move(i, 1)}
                                                            >
                                                                <ArrowDown />
                                                            </Button>
                                                        </>
                                                    )}
                                                    {!f.isDefault && (
                                                        <Button
                                                            type="button"
                                                            size="sm"
                                                            variant="ghost"
                                                            aria-label={`Make default: ${label}`}
                                                            disabled={change.isPending}
                                                            onClick={() =>
                                                                change.mutate({
                                                                    run: () => api.put(`${base}/default`, { id: f.id }),
                                                                    done: `${label} is now the default.`,
                                                                })
                                                            }
                                                        >
                                                            Make default
                                                        </Button>
                                                    )}
                                                    <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(f)}>
                                                        Rename<span className="sr-only"> {label}</span>
                                                    </Button>
                                                    {list.length > 1 &&
                                                        (f.isDefault ? (
                                                            <Button type="button" size="sm" variant="ghost" onClick={() => setRemoving(f)}>
                                                                Remove<span className="sr-only"> {label}</span>
                                                            </Button>
                                                        ) : (
                                                            <RemoveFavourite favourite={f} base={base} refresh={refresh} />
                                                        ))}
                                                </div>
                                            </TableCell>
                                        )}
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </TableFrame>
            )}
            <RenameDialog favourite={renaming} base={base} refresh={refresh} onClose={() => setRenaming(null)} />
            <RemoveDefaultDialog favourite={removing} others={list} base={base} refresh={refresh} onClose={() => setRemoving(null)} />
        </SettingsSection>
    );
}

function RenameDialog({
    favourite,
    base,
    refresh,
    onClose,
}: {
    favourite: Favourite | null;
    base: string;
    refresh(): Promise<unknown>;
    onClose(): void;
}) {
    const [name, setName] = useState("");
    const [open, setOpen] = useState<string | null>(null);
    // Start from the favourite's own nickname each time one is opened.
    if (favourite && open !== favourite.id) {
        setOpen(favourite.id);
        setName(favourite.name ?? "");
    }
    const close = () => {
        setOpen(null);
        save.reset();
        onClose();
    };
    const save = useMutation({
        mutationFn: () => api.patch(`${base}/favourites/${encodeURIComponent(favourite?.id ?? "")}`, { name: name.trim() || null }),
        onSuccess: async () => {
            await refresh();
            toast.success(name.trim() ? `Renamed to ${name.trim()}.` : "Nickname removed.");
            close();
        },
    });
    return (
        <Dialog
            open={Boolean(favourite)}
            onOpenChange={(next) => {
                if (!next) close();
            }}
        >
            <DialogContent>
                <form
                    className="grid gap-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        save.mutate();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Rename {favourite ? favouriteLabel(favourite) : ""}</DialogTitle>
                        <DialogDescription>
                            A nickname for <span className="font-mono break-all">{favourite?.model}</span> from {favourite?.providerName}.
                        </DialogDescription>
                    </DialogHeader>
                    <Field label="Nickname" hint="A short name, like Fast or Careful. Leave it empty for none.">
                        {(p) => (
                            <Input
                                {...p}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                maxLength={MAX_FAVOURITE_NAME}
                                autoComplete="off"
                            />
                        )}
                    </Field>
                    <FieldError message={save.error ? errorMessage(save.error) : null} />
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={save.isPending}>
                            {save.isPending ? "Saving…" : "Save nickname"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Removing a favourite that isn't the default: asked once, and again, naming them, if projects' reviews use it.
 */
function RemoveFavourite({ favourite, base, refresh }: { favourite: Favourite; base: string; refresh(): Promise<unknown> }) {
    const { ws } = useWorkspace();
    const queryClient = useQueryClient();
    const [uses, setUses] = useState<FavouriteUse[] | null>(null);
    const label = favouriteLabel(favourite);
    return (
        <ConfirmAction
            trigger={
                <Button type="button" size="sm" variant="ghost">
                    Remove<span className="sr-only"> {label}</span>
                </Button>
            }
            title={`Remove ${label}?`}
            description={uses ? <InUse uses={uses} /> : "It leaves the favourites. Its provider and key stay."}
            confirmLabel={uses ? "Remove it from them too" : "Remove favourite"}
            onOpenChange={(open) => {
                if (!open) setUses(null);
            }}
            onConfirm={async () => {
                try {
                    await api.delete(`${base}/favourites/${encodeURIComponent(favourite.id)}${uses ? "?force=true" : ""}`);
                } catch (err) {
                    const found = usesFrom(err);
                    if (!found) throw err;
                    // The dialog stays open, now saying which projects, and asks again.
                    setUses(found);
                    throw new Error(
                        `${found.length === 1 ? "A project's reviews use" : `${found.length} projects' reviews use`} this model.`,
                    );
                }
                // The projects' own settings changed with it.
                if (uses) void queryClient.invalidateQueries({ queryKey: ["ws", ws, "p"] });
                await refresh();
                toast.success(`${label} removed.`);
            }}
        />
    );
}

/** Removing the default: reviews always have one, so another favourite takes over. */
function RemoveDefaultDialog({
    favourite,
    others,
    base,
    refresh,
    onClose,
}: {
    favourite: Favourite | null;
    others: Favourite[];
    base: string;
    refresh(): Promise<unknown>;
    onClose(): void;
}) {
    const { ws } = useWorkspace();
    const queryClient = useQueryClient();
    const choices = others.filter((f) => f.id !== favourite?.id);
    const [chosen, setChosen] = useState("");
    // The projects whose reviews use it, once the server has refused to remove it for that.
    const [uses, setUses] = useState<FavouriteUse[] | null>(null);
    const next = choices.find((f) => f.id === chosen) ?? choices.find((f) => f.ready) ?? choices[0];
    const close = () => {
        setChosen("");
        setUses(null);
        remove.reset();
        onClose();
    };
    const remove = useMutation({
        mutationFn: () =>
            api.delete(
                `${base}/favourites/${encodeURIComponent(favourite?.id ?? "")}?defaultId=${encodeURIComponent(next?.id ?? "")}${uses ? "&force=true" : ""}`,
            ),
        onError: (err) => setUses(usesFrom(err) ?? uses),
        onSuccess: async () => {
            if (uses) void queryClient.invalidateQueries({ queryKey: ["ws", ws, "p"] });
            await refresh();
            toast.success(
                `${favourite ? favouriteLabel(favourite) : "Favourite"} removed. ${next ? favouriteLabel(next) : ""} is now the default.`,
            );
            close();
        },
    });
    return (
        <Dialog
            open={Boolean(favourite)}
            onOpenChange={(open) => {
                if (!open) close();
            }}
        >
            <DialogContent>
                <form
                    className="grid gap-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (next) remove.mutate();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Remove {favourite ? favouriteLabel(favourite) : ""}?</DialogTitle>
                        <DialogDescription>
                            It's the default model, so another favourite takes its place. Its provider and key stay.
                        </DialogDescription>
                    </DialogHeader>
                    <Field label="New default">
                        {(p) => (
                            <NativeSelect {...p} value={next?.id ?? ""} onChange={(e) => setChosen(e.target.value)}>
                                {choices.map((f) => (
                                    <option key={f.id} value={f.id}>
                                        {f.name ? `${f.name} (${f.model})` : f.model} · {f.providerName}
                                        {f.ready ? "" : " (not ready)"}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                    {uses && (
                        <div className="text-sm">
                            <InUse uses={uses} />
                        </div>
                    )}
                    <FieldError message={remove.error && !usesFrom(remove.error) ? errorMessage(remove.error) : null} />
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="destructive" disabled={remove.isPending || !next}>
                            {remove.isPending ? "Working…" : uses ? "Remove it from them too" : "Remove favourite"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function AddFavourite({ data, title, base, refresh }: { data: ReviewModel; title: string; base: string; refresh(): Promise<unknown> }) {
    const { ws } = useWorkspace();
    const connected = data.providers.filter((p) => p.connected);
    const [chosen, setChosen] = useState("");
    const [model, setModel] = useState("");
    const [name, setName] = useState("");
    // Until someone decides: the default when the current one can't run reviews.
    const [asDefault, setAsDefault] = useState<boolean | null>(null);
    const current = data.favourites.find((f) => f.isDefault);
    const makeDefault = asDefault ?? (current ? !current.ready : false);
    const p = connected.find((x) => x.id === chosen) ?? connected.find((x) => x.needs === null) ?? connected[0];
    const full = data.favourites.length >= MAX_FAVOURITES;

    const add = useMutation({
        mutationFn: () =>
            api.post(`${paths.workspace(ws)}/settings/models/favourites`, {
                provider: p?.id,
                model: model.trim(),
                ...(name.trim() ? { name: name.trim() } : {}),
                ...(current && makeDefault ? { makeDefault: true } : {}),
            }),
        onSuccess: async () => {
            await refresh();
            toast.success(`${name.trim() || model.trim()} added.`);
            setModel("");
            setName("");
            setAsDefault(null);
        },
    });

    return (
        <SettingsSection
            title={title}
            description="One of a connected provider's models: from its list, a suggestion, or its name typed in."
        >
            {!p ? (
                <p className="text-sm text-muted-foreground">Connect a provider above first: its models can then be added here.</p>
            ) : full ? (
                <p className="text-sm text-muted-foreground">
                    A workspace can have up to {MAX_FAVOURITES} favourite models. Remove one to add another.
                </p>
            ) : (
                <form
                    className="grid gap-form"
                    data-testid="add-favourite"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (model.trim()) add.mutate();
                    }}
                >
                    <FieldRow>
                        <Field label="Provider" hint={p.needs ? `Needs ${p.needs} before reviews can use it.` : undefined}>
                            {(f) => (
                                <NativeSelect
                                    {...f}
                                    value={p.id}
                                    onChange={(e) => {
                                        setChosen(e.target.value);
                                        setModel("");
                                    }}
                                >
                                    {connected.map((x) => (
                                        <option key={x.id} value={x.id}>
                                            {x.name}
                                        </option>
                                    ))}
                                </NativeSelect>
                            )}
                        </Field>
                        <Field label="Nickname" hint="Optional: a short name, like Fast or Careful.">
                            {(f) => (
                                <Input
                                    {...f}
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    maxLength={MAX_FAVOURITE_NAME}
                                    autoComplete="off"
                                />
                            )}
                        </Field>
                    </FieldRow>
                    <ModelField
                        // The model list and suggestions are the chosen provider's.
                        key={p.id}
                        provider={p}
                        base={base}
                        queryKey={keys.wsSettings(ws, "review-model")}
                        value={model}
                        onChange={setModel}
                        canConfigure
                    />
                    {current && (
                        <CheckField
                            label="Make it the default"
                            hint="The model reviews use unless a project, or the person starting one, chooses others."
                        >
                            {(f) => <Checkbox {...f} checked={makeDefault} onCheckedChange={(v) => setAsDefault(v === true)} />}
                        </CheckField>
                    )}
                    <FieldError message={add.error ? errorMessage(add.error) : null} />
                    <FormActions>
                        <Button type="submit" disabled={add.isPending || !model.trim()}>
                            {add.isPending ? "Adding…" : "Add favourite"}
                        </Button>
                        {p.id === "openrouter" && <ModelPicker ws={ws} current={model} onChoose={(m) => setModel(m.id)} />}
                    </FormActions>
                </form>
            )}
        </SettingsSection>
    );
}
