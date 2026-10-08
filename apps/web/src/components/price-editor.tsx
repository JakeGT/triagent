// Model prices: a list with Remove, and a form to add or replace one. Prices are US dollars per million
// tokens; cache reads are optional (charged at the input price when left empty). Used for the instance's
// prices and a workspace's own.

import { type FormEvent, useId, useState } from "react";
import { ConfirmAction } from "@/components/confirm-action";
import { Field, FieldError, FieldRow } from "@/components/field";
import { FormActions } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { perMillion } from "@/lib/insights-format";
import type { CatalogueModel, Price, PriceEntry } from "@/lib/insights-types";

export interface PriceInput extends Price {
    model: string;
}

const MODEL_NAME = /^[\w.:/@+-]{1,150}$/;

/** Check a price form; returns the price or a message for people. */
export function readPrice(form: { model: string; input: string; output: string; cacheRead: string }): PriceInput | string {
    const model = form.model.trim();
    if (!MODEL_NAME.test(model)) return "Give the model's name as reviews use it, e.g. anthropic/claude-sonnet-4.5.";
    const number = (v: string, what: string) => {
        const n = v.trim() === "" ? Number.NaN : Number(v);
        return Number.isFinite(n) && n >= 0 && n <= 10_000
            ? n
            : `The ${what} price must be a number of US dollars per million tokens, from 0 to 10,000.`;
    };
    const input = number(form.input, "input");
    if (typeof input === "string") return input;
    const output = number(form.output, "output");
    if (typeof output === "string") return output;
    const cacheRead = form.cacheRead.trim() === "" ? null : number(form.cacheRead, "cache read");
    if (typeof cacheRead === "string") return cacheRead;
    return { model, input, output, cacheRead };
}

const EMPTY = { model: "", input: "", output: "", cacheRead: "" };

export function PriceEditor({
    title,
    prices,
    canEdit,
    catalogue = [],
    onSave,
    onRemove,
}: {
    /** What these prices are, for labels: "instance prices", "this workspace's prices". */
    title: string;
    prices: PriceEntry[];
    canEdit: boolean;
    /** OpenRouter's models, to suggest names and fill in their listed prices. */
    catalogue?: CatalogueModel[];
    onSave(price: PriceInput): Promise<unknown>;
    onRemove(model: string): Promise<unknown>;
}) {
    const id = useId();
    const [form, setForm] = useState(EMPTY);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const listed = catalogue.find((m) => m.id === form.model.trim());

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const price = readPrice(form);
        if (typeof price === "string") {
            setError(price);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onSave(price);
            setForm(EMPTY);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const field = (key: keyof typeof EMPTY, label: string, extra: Record<string, unknown> = {}) => (
        <Field label={label}>
            {(p) => (
                <Input
                    {...p}
                    value={form[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id}-error` : undefined}
                    {...extra}
                />
            )}
        </Field>
    );

    return (
        <div className="grid gap-form" data-testid="price-editor">
            {prices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No {title} yet.</p>
            ) : (
                <Table>
                    <caption className="sr-only">{title}, in US dollars per million tokens</caption>
                    <TableHeader>
                        <TableRow>
                            <TableHead scope="col">Model</TableHead>
                            <TableHead scope="col" className="text-end">
                                Input
                            </TableHead>
                            <TableHead scope="col" className="text-end">
                                Output
                            </TableHead>
                            <TableHead scope="col" className="text-end">
                                Cache reads
                            </TableHead>
                            <TableHead scope="col">Set by</TableHead>
                            {canEdit && (
                                <TableHead scope="col">
                                    <span className="sr-only">Actions</span>
                                </TableHead>
                            )}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {prices.map((p) => (
                            <TableRow key={p.model}>
                                <TableCell className="font-mono text-xs break-all whitespace-normal">{p.model}</TableCell>
                                <TableCell className="text-end tabular-nums">{perMillion(p.input)}</TableCell>
                                <TableCell className="text-end tabular-nums">{perMillion(p.output)}</TableCell>
                                <TableCell className="text-end tabular-nums">
                                    {p.cacheRead === null ? "As input" : perMillion(p.cacheRead)}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {p.setBy}, {formatDate(p.setAt)}
                                </TableCell>
                                {canEdit && (
                                    <TableCell className="text-end">
                                        <div className="flex justify-end gap-1">
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                onClick={() =>
                                                    setForm({
                                                        model: p.model,
                                                        input: String(p.input),
                                                        output: String(p.output),
                                                        cacheRead: p.cacheRead === null ? "" : String(p.cacheRead),
                                                    })
                                                }
                                            >
                                                Edit <span className="sr-only">the price of {p.model}</span>
                                            </Button>
                                            <ConfirmAction
                                                trigger={
                                                    <Button type="button" size="sm" variant="ghost">
                                                        Remove <span className="sr-only">the price of {p.model}</span>
                                                    </Button>
                                                }
                                                title={`Remove the price of ${p.model}?`}
                                                description="Costs for this model will use the next price that applies: the instance's, then OpenRouter's, or none."
                                                confirmLabel="Remove price"
                                                onConfirm={() => onRemove(p.model)}
                                            />
                                        </div>
                                    </TableCell>
                                )}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
            {canEdit && (
                <form className="grid gap-form" onSubmit={submit} aria-label={`Set a price (${title})`}>
                    <FieldRow columns={4} className="lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
                        {field("model", "Model", {
                            list: catalogue.length ? `${id}-models` : undefined,
                            spellCheck: false,
                            autoComplete: "off",
                            className: "font-mono",
                        })}
                        {field("input", "Input (US$ per million)", { inputMode: "decimal" })}
                        {field("output", "Output (US$ per million)", { inputMode: "decimal" })}
                        {field("cacheRead", "Cache reads (optional)", { inputMode: "decimal", placeholder: "As input" })}
                    </FieldRow>
                    {catalogue.length > 0 && (
                        <datalist id={`${id}-models`}>
                            {catalogue.map((m) => (
                                <option key={m.id} value={m.id} />
                            ))}
                        </datalist>
                    )}
                    <FieldError id={`${id}-error`} message={error} />
                    <FormActions>
                        <Button type="submit" disabled={busy}>
                            {busy ? "Saving…" : "Save price"}
                        </Button>
                        {listed && (
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() =>
                                    setForm({
                                        model: listed.id,
                                        input: String(listed.price.input),
                                        output: String(listed.price.output),
                                        cacheRead: listed.price.cacheRead === null ? "" : String(listed.price.cacheRead),
                                    })
                                }
                            >
                                Use OpenRouter's price
                            </Button>
                        )}
                    </FormActions>
                </form>
            )}
        </div>
    );
}
