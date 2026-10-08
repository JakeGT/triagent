// Pick a model from OpenRouter's catalogue, searching by name or id, with its prices. The catalogue is
// fetched by our server; if it's unavailable the picker says so and the model can still be typed in.

import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "@/lib/api";
import { perMillion } from "@/lib/insights-format";
import { catalogueQuery } from "@/lib/insights-queries";
import type { CatalogueModel } from "@/lib/insights-types";

const SHOWN = 60;

/** Models whose id or name contain every word of the search. */
export function searchModels(models: readonly CatalogueModel[], q: string): CatalogueModel[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [...models];
    return models.filter((m) => {
        const text = `${m.id} ${m.name}`.toLowerCase();
        return words.every((w) => text.includes(w));
    });
}

export function ModelPicker({
    ws,
    current,
    onChoose,
    disabled,
}: {
    ws: string;
    current?: string;
    onChoose(model: CatalogueModel): void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const search = useDeferredValue(q);
    const id = useId();
    const catalogue = useQuery({ ...catalogueQuery(ws), enabled: open });
    const models = catalogue.data?.models ?? [];
    const found = searchModels(models, search);

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next) setQ("");
            }}
        >
            <DialogTrigger asChild>
                <Button type="button" variant="outline" disabled={disabled}>
                    Browse OpenRouter models
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>OpenRouter models</DialogTitle>
                    <DialogDescription>Prices are OpenRouter's, in US dollars per million tokens.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-1.5">
                    <Label htmlFor={id}>Search models</Label>
                    <Input
                        id={id}
                        type="search"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="e.g. sonnet, gpt-5, deepseek"
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>
                {catalogue.isPending ? (
                    <p className="text-sm text-muted-foreground" aria-busy="true">
                        Loading OpenRouter's models…
                    </p>
                ) : catalogue.isError ? (
                    <p className="text-sm text-destructive" role="alert">
                        {errorMessage(catalogue.error)}
                    </p>
                ) : !catalogue.data.enabled ? (
                    <p className="text-sm text-muted-foreground">
                        The OpenRouter catalogue is turned off on this server (OPENROUTER_CATALOGUE=false). Type the model's name instead.
                    </p>
                ) : models.length === 0 ? (
                    <p className="text-sm text-muted-foreground" role="status">
                        {catalogue.data.error ?? "OpenRouter listed no models."} Type the model's name instead, or try again later.
                    </p>
                ) : (
                    <>
                        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
                            {found.length === 0
                                ? "No models match."
                                : found.length > SHOWN
                                  ? `${found.length.toLocaleString("en-GB")} models match; showing the first ${SHOWN}. Search to narrow them down.`
                                  : `${found.length.toLocaleString("en-GB")} ${found.length === 1 ? "model matches" : "models match"}.`}
                        </p>
                        <div className="max-h-[50vh] overflow-auto">
                            <Table>
                                <caption className="sr-only">OpenRouter models and their prices</caption>
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
                                        <TableHead scope="col">
                                            <span className="sr-only">Choose</span>
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {found.slice(0, SHOWN).map((m) => (
                                        <TableRow key={m.id} aria-current={m.id === current ? "true" : undefined}>
                                            <TableCell className="whitespace-normal">
                                                <span className="block">{m.name}</span>
                                                <span className="block font-mono text-xs break-all text-muted-foreground">{m.id}</span>
                                            </TableCell>
                                            <TableCell className="text-end tabular-nums">{perMillion(m.price.input)}</TableCell>
                                            <TableCell className="text-end tabular-nums">{perMillion(m.price.output)}</TableCell>
                                            <TableCell className="text-end tabular-nums">{perMillion(m.price.cacheRead)}</TableCell>
                                            <TableCell className="text-end">
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant={m.id === current ? "secondary" : "outline"}
                                                    onClick={() => {
                                                        onChoose(m);
                                                        setOpen(false);
                                                        setQ("");
                                                    }}
                                                >
                                                    {m.id === current ? "Chosen" : "Choose"} <span className="sr-only">{m.name}</span>
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
