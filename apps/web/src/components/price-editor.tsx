// Model prices: a list with Remove, and a form to add or replace one. Prices are US dollars per million
// tokens; cache reads are optional (charged at the input price when left empty). Used for the instance's
// prices and a workspace's own.

import { CircleMinus } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
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
/** Plain decimals only: Number() would also take "0x10", "1e3" or "0b1". */
const DECIMAL = /^(\d+\.?\d*|\.\d+)$/;

/** Check a price form; returns the price or a message for people. */
export function readPrice(form: { model: string; input: string; output: string; cacheRead: string }): PriceInput | string {
    const model = form.model.trim();
    if (!MODEL_NAME.test(model)) return "Give the model's name as reviews use it, e.g. anthropic/claude-sonnet-4.5.";
    const number = (v: string, what: string) => {
        const n = DECIMAL.test(v.trim()) ? Number(v) : Number.NaN;
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

/** Whether a price under this name applies to a model reviews used (as the server matches them). */
export function appliesTo(name: string, used: { model: string; provider: string | null }) {
    return name === used.model || (used.provider !== null && name === `${used.provider}/${used.model}`);
}

export function PriceEditor({
    title,
    prices,
    canEdit,
    catalogue = [],
    suggest = [],
    used,
    fill,
    onSave,
    onRemove,
}: {
    /** What these prices are, for labels: "instance prices", "this workspace's prices". */
    title: string;
    prices: PriceEntry[];
    canEdit: boolean;
    /** OpenRouter's models, to fill in their listed prices. */
    catalogue?: CatalogueModel[];
    /** The favourites, whose names the model field suggests. */
    suggest?: { model: string; provider: string | null; label: string }[];
    /** The models this workspace's reviews used, to say when a name matches none of them (nor a favourite). */
    used?: { model: string; provider: string | null }[];
    /** A model name to put in the form (each new object fills it again). */
    fill?: { model: string } | null;
    onSave(price: PriceInput): Promise<unknown>;
    onRemove(model: string): Promise<unknown>;
}) {
    const id = useId();
    const [form, setForm] = useState(EMPTY);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const modelInput = useRef<HTMLInputElement>(null);
    const name = form.model.trim();
    const listed = catalogue.find((m) => m.id === name);
    const unused =
        used !== undefined && MODEL_NAME.test(name) && !used.some((u) => appliesTo(name, u)) && !suggest.some((f) => appliesTo(name, f));
    const suggested = [...new Map(suggest.map((f) => [f.model, f])).values()];

    useEffect(() => {
        if (!fill) return;
        setForm({ ...EMPTY, model: fill.model });
        setError(null);
        modelInput.current?.focus();
    }, [fill]);

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
                            {/* On a phone, the price itself: cache reads and who set it are under Edit and on wider screens. */}
                            <TableHead scope="col" className="hidden text-end sm:table-cell">
                                Cache reads
                            </TableHead>
                            <TableHead scope="col" className="hidden sm:table-cell">
                                Set by
                            </TableHead>
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
                                <TableCell className="min-w-24 font-mono text-xs break-all whitespace-normal">{p.model}</TableCell>
                                <TableCell className="text-end tabular-nums">{perMillion(p.input)}</TableCell>
                                <TableCell className="text-end tabular-nums">{perMillion(p.output)}</TableCell>
                                <TableCell className="hidden text-end tabular-nums sm:table-cell">
                                    {p.cacheRead === null ? "As input" : perMillion(p.cacheRead)}
                                </TableCell>
                                <TableCell className="hidden text-muted-foreground sm:table-cell">
                                    {p.setBy}, {formatDate(p.setAt)}
                                </TableCell>
                                {canEdit && (
                                    <TableCell className="text-end">
                                        <div className="flex justify-end gap-1">
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
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
                                                    <Button type="button" size="sm" variant="danger" className="sm:ms-3">
                                                        <CircleMinus /> <span className="sr-only sm:not-sr-only">Remove</span>{" "}
                                                        <span className="sr-only">the price of {p.model}</span>
                                                    </Button>
                                                }
                                                title={`Remove the price of ${p.model}?`}
                                                description="Costs for this model will use the next price that applies: the instance's, then OpenRouter's, or none. You can set a price again."
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
                            ref: modelInput,
                            list: suggested.length ? `${id}-models` : undefined,
                            spellCheck: false,
                            autoComplete: "off",
                            className: "font-mono",
                        })}
                        {field("input", "Input (US$ per million)", { inputMode: "decimal" })}
                        {field("output", "Output (US$ per million)", { inputMode: "decimal" })}
                        {field("cacheRead", "Cache reads (optional)", { inputMode: "decimal", placeholder: "As input" })}
                    </FieldRow>
                    {suggested.length > 0 && (
                        <datalist id={`${id}-models`}>
                            {suggested.map((f) => (
                                <option key={f.model} value={f.model} label={f.label} />
                            ))}
                        </datalist>
                    )}
                    {unused && (
                        <p className="text-sm text-muted-foreground" data-testid="price-unused">
                            No review here has used a model called {name}, and it isn't a favourite, so this price won't change any costs.
                            Use the name shown under "Models your reviews used".
                        </p>
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
