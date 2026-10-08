// Choosing a review model: the provider (grouped), its API where it has more than one, its endpoint or AWS
// region where it needs one, the model (from the provider's own list, fetched by our server with the stored
// key, or a suggestion, or anything typed in), and the provider's keys. Used for a workspace (Settings →
// Review model & keys) and for the instance key (Settings → Instance model key).

import { type QueryKey, useMutation, useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { toast } from "sonner";
import { ChangedElsewhere } from "@/components/changed-elsewhere";
import { Field, FieldError, FieldRow, NativeSelect } from "@/components/field";
import { FormActions } from "@/components/form";
import { ModelPicker } from "@/components/model-picker";
import { SecretField } from "@/components/secret-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { safeHref } from "@/lib/safe-href";
import type { ModelList, ModelProtocol, Provider, ReviewModel } from "@/lib/types";
import { ReadOnlyNote, SettingsSection } from "./settings-page";

export const PROTOCOL_LABELS: Record<ModelProtocol, string> = {
    openai: "Chat Completions",
    "openai-responses": "Responses",
    anthropic: "Anthropic Messages",
    "anthropic-bedrock": "Anthropic on Bedrock",
};

interface Draft {
    provider: string;
    model: string;
    protocol: ModelProtocol;
    url: string;
    region: string;
}

const draftOf = (data: ReviewModel, id: string): Draft => {
    const p = data.providers.find((x) => x.id === id) ?? data.providers[0];
    return { provider: id, model: p?.model ?? "", protocol: p?.protocol ?? "openai", url: p?.endpoint ?? "", region: p?.region ?? "" };
};

/** The provider's groups, in the order the server lists them. */
function groups(providers: Provider[]): [string, Provider[]][] {
    const out = new Map<string, Provider[]>();
    for (const p of providers) out.set(p.group, [...(out.get(p.group) ?? []), p]);
    return [...out];
}

/** Where requests for a provider go, for people. */
function destination(p: Provider, d: Draft): string {
    if (p.fields.includes("region")) return d.region ? `Bedrock in ${d.region}` : "Bedrock, in the region you give";
    if (p.fields.includes("url")) return d.url ? (p.url ?? d.url) : "the address you give";
    return p.url ?? "the provider";
}

export function ModelProviderForm({
    data,
    base,
    ws,
    queryKey,
    scope,
    canConfigure,
    canSetSecrets,
    onSaved,
    refresh,
}: {
    data: ReviewModel;
    /** The settings' API path: PATCH here; keys at {base}/keys/…, model lists at {base}/providers/…/models. */
    base: string;
    ws: string;
    /** Where model lists are kept in the query cache. */
    queryKey: QueryKey;
    scope: "workspace" | "instance";
    canConfigure: boolean;
    canSetSecrets: boolean;
    onSaved(model: ReviewModel): void;
    refresh(): Promise<unknown>;
}) {
    const form = useDraft<Draft>(draftOf(data, data.provider));
    const d = form.draft ?? draftOf(data, data.provider);
    const p = data.providers.find((x) => x.id === d.provider) ?? (data.providers[0] as Provider);
    const listId = useId();

    const list = useQuery({
        queryKey: [...queryKey, "models", p.id, p.key.setAt, p.accessKeyId?.setAt, p.endpoint, p.region],
        queryFn: ({ signal }) => api.get<ModelList>(`${base}/providers/${encodeURIComponent(p.id)}/models`, undefined, { signal }),
        enabled: canConfigure && p.listsModels,
        staleTime: 5 * 60_000,
    });

    const save = useMutation({
        mutationFn: (v: Draft) =>
            api.patch<ReviewModel>(base, {
                provider: v.provider,
                ...(v.model.trim() ? { model: v.model.trim() } : {}),
                ...(p.protocols.length > 1 ? { protocol: v.protocol } : {}),
                ...(p.fields.includes("url") ? { url: v.url.trim() || null } : {}),
                ...(p.fields.includes("region") ? { region: v.region.trim() || null } : {}),
            }),
        onSuccess: (m) => {
            onSaved(m);
            form.saved(draftOf(m, m.provider));
            toast.success(scope === "instance" ? "Instance model saved." : "Review model saved.");
        },
    });

    const choices = [...new Set([...(list.data?.models?.map((m) => m.id) ?? []), ...p.suggested])];
    const keyPath = `${base}/keys/${encodeURIComponent(p.id)}`;
    const keysUrl = safeHref(p.keysUrl);
    const others = data.providers.filter((x) => x.id !== p.id && x.key.set).map((x) => x.name);
    const keyName =
        scope === "instance" ? `${p.name} instance ${p.keyLabel === "API key" ? "key" : p.keyLabel}` : `${p.name} ${p.keyLabel}`;
    const idName = scope === "instance" ? `${p.name} instance AWS access key ID` : `${p.name} AWS access key ID`;

    const providerField = (
        <Field label="Provider" hint={`Requests go to ${destination(p, d)}.`}>
            {(f) => (
                <NativeSelect
                    {...f}
                    value={d.provider}
                    disabled={!canConfigure}
                    onChange={(e) => form.setDraft(draftOf(data, e.target.value))}
                >
                    {groups(data.providers).map(([group, members]) => (
                        <optgroup key={group} label={group}>
                            {members.map((x) => (
                                <option key={x.id} value={x.id}>
                                    {x.name}
                                </option>
                            ))}
                        </optgroup>
                    ))}
                </NativeSelect>
            )}
        </Field>
    );
    const apiField = p.protocols.length > 1 && (
        <Field
            label="API"
            hint={
                p.id === "custom"
                    ? "The API your server speaks. Most speak Chat Completions."
                    : "Pro models, and tool calls with some newer OpenAI models, need Responses."
            }
        >
            {(f) => (
                <NativeSelect
                    {...f}
                    value={d.protocol}
                    disabled={!canConfigure}
                    onChange={(e) => form.setDraft({ ...d, protocol: e.target.value as ModelProtocol })}
                >
                    {p.protocols.map((x) => (
                        <option key={x} value={x}>
                            {PROTOCOL_LABELS[x]}
                        </option>
                    ))}
                </NativeSelect>
            )}
        </Field>
    );
    const regionField = p.fields.includes("region") && (
        <Field label="AWS region" hint="Where your Bedrock models run, like eu-west-2 or us-east-1.">
            {(f) => (
                <Input
                    {...f}
                    value={d.region}
                    onChange={(e) => form.setDraft({ ...d, region: e.target.value })}
                    disabled={!canConfigure}
                    maxLength={40}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono"
                />
            )}
        </Field>
    );
    const keyField = (
        <SecretField
            label={keyName}
            secret={p.key}
            canEdit={canSetSecrets}
            hint={
                <>
                    {`${p.keyFormat ? `${p.keyFormat}. ` : ""}${p.fields.includes("region") ? "Used to sign requests to" : "Sent only to"} ${destination(p, d)}.`}
                    {keysUrl && (
                        <>
                            {" "}
                            <a href={keysUrl} target="_blank" rel="noopener noreferrer" className="underline">
                                Get a {p.name} key<span className="sr-only"> (opens in a new tab)</span>
                            </a>
                        </>
                    )}
                </>
            }
            onSave={async (key) => {
                await api.put(keyPath, { key });
                await refresh();
                toast.success(`${p.name} key saved.`);
            }}
            onClear={async () => {
                await api.delete(keyPath);
                await refresh();
                toast.success(`${p.name} key cleared.`);
            }}
        />
    );

    return (
        <>
            <SettingsSection title="Provider and model">
                {!canConfigure && <ReadOnlyNote />}
                <ChangedElsewhere show={form.changedElsewhere} onReload={form.reload} what="The review model" />
                <form
                    className="grid gap-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        save.mutate(d);
                    }}
                >
                    {/* The provider beside its short settings (its API or region); an address gets a line of its own. */}
                    <FieldRow>
                        {providerField}
                        {apiField || regionField}
                    </FieldRow>
                    {apiField && regionField}
                    {p.fields.includes("url") && (
                        <Field
                            label={p.id === "azure" ? "Endpoint" : "Base URL"}
                            hint={
                                p.id === "azure"
                                    ? "Your Azure OpenAI resource's endpoint, like https://NAME.openai.azure.com. Reviews use its v1 API."
                                    : "Where your server's API is, like https://llm.example.com/v1 (for Ollama, LiteLLM, vLLM or a gateway). It must use https and a public address, unless this instance allows private ones."
                            }
                        >
                            {(f) => (
                                <Input
                                    {...f}
                                    type="url"
                                    value={d.url}
                                    onChange={(e) => form.setDraft({ ...d, url: e.target.value })}
                                    disabled={!canConfigure}
                                    maxLength={500}
                                    spellCheck={false}
                                    autoComplete="off"
                                    className="font-mono"
                                />
                            )}
                        </Field>
                    )}
                    <Field
                        label="Model"
                        hint={
                            p.id === "azure"
                                ? "Your model deployment's name."
                                : p.id === "bedrock"
                                  ? "A Bedrock model or inference profile ID for an Anthropic model."
                                  : p.id === "custom"
                                    ? "The model's name on your server."
                                    : `${p.name}'s name for the model. Any model it offers can be typed in.`
                        }
                    >
                        {(f) => (
                            <Input
                                {...f}
                                value={d.model}
                                onChange={(e) => form.setDraft({ ...d, model: e.target.value })}
                                disabled={!canConfigure}
                                maxLength={150}
                                spellCheck={false}
                                autoComplete="off"
                                list={choices.length ? listId : undefined}
                                className="font-mono"
                            />
                        )}
                    </Field>
                    {choices.length > 0 && (
                        <datalist id={listId}>
                            {choices.map((m) => (
                                <option key={m} value={m} />
                            ))}
                        </datalist>
                    )}
                    {canConfigure && <ModelListStatus provider={p} list={list} />}
                    {canConfigure && p.suggested.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2" data-testid="model-suggestions">
                            <span className="text-sm text-muted-foreground">Suggested:</span>
                            {p.suggested.map((m) => (
                                <Button
                                    key={m}
                                    type="button"
                                    size="sm"
                                    variant={m === d.model ? "secondary" : "outline"}
                                    // Long model ids wrap on a phone rather than widening the page.
                                    className="h-auto min-h-8 max-w-full font-mono break-all whitespace-normal"
                                    aria-pressed={m === d.model}
                                    onClick={() => form.setDraft({ ...d, model: m })}
                                >
                                    {m}
                                </Button>
                            ))}
                        </div>
                    )}
                    <FieldError message={save.error ? errorMessage(save.error) : null} />
                    {canConfigure && (
                        <FormActions>
                            <Button type="submit" disabled={save.isPending || !form.dirty}>
                                {save.isPending ? "Saving…" : "Save model"}
                            </Button>
                            {p.id === "openrouter" && (
                                <ModelPicker ws={ws} current={d.model} onChoose={(m) => form.setDraft({ ...d, model: m.id })} />
                            )}
                        </FormActions>
                    )}
                </form>
            </SettingsSection>
            <SettingsSection
                title={scope === "instance" ? "Instance keys" : "API keys"}
                description={
                    scope === "instance"
                        ? "Stored encrypted, belonging to no workspace, and never shown again. Only instance administrators, in the browser, can set them."
                        : "Stored encrypted for this workspace and never shown again. API tokens and agents can't set or read them."
                }
            >
                {!canSetSecrets && <ReadOnlyNote>Only admins can set or clear keys.</ReadOnlyNote>}
                <div className="grid gap-form" data-testid="provider-keys">
                    {p.accessKeyId ? (
                        // Bedrock's two halves of one credential, side by side.
                        <FieldRow>
                            <SecretField
                                label={idName}
                                secret={p.accessKeyId}
                                canEdit={canSetSecrets}
                                hint="An IAM user's access key ID, starting AKIA. Its user needs permission to invoke the model in that region."
                                onSave={async (key) => {
                                    await api.put(`${keyPath}/access-key-id`, { key });
                                    await refresh();
                                    toast.success(`${p.name} access key ID saved.`);
                                }}
                                onClear={async () => {
                                    await api.delete(`${keyPath}/access-key-id`);
                                    await refresh();
                                    toast.success(`${p.name} access key ID cleared.`);
                                }}
                            />
                            {keyField}
                        </FieldRow>
                    ) : (
                        keyField
                    )}
                    {others.length > 0 && (
                        <p className="text-sm text-muted-foreground">
                            Keys are also stored for {others.join(", ")}. Choose a provider above to change its key.
                        </p>
                    )}
                </div>
            </SettingsSection>
        </>
    );
}

/** What the model list says: how many models the provider offers, or why there's no list. */
function ModelListStatus({ provider: p, list }: { provider: Provider; list: ReturnType<typeof useQuery<ModelList>> }) {
    const who = p.id === "custom" ? "your server" : p.name;
    const text = !p.listsModels
        ? `${p.name} doesn't list its models here. Choose a suggestion or type the model's name.`
        : list.isPending
          ? `Loading ${p.name}'s models…`
          : list.isError
            ? `${errorMessage(list.error)} You can still type the model's name.`
            : list.data.error
              ? `${list.data.error} You can still type the model's name.`
              : list.data.models.length
                ? `${list.data.models.length.toLocaleString("en-GB")} ${list.data.models.length === 1 ? "model" : "models"} from ${who}: start typing in Model to pick one.`
                : `${who === p.name ? who : "Your server"} listed no models. Type the model's name.`;
    return (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="model-list-status">
            {text}
        </p>
    );
}
