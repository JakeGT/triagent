// The filter bar above the issue list. Every control writes to the URL; the list follows the URL.

import { CATEGORIES, ISSUE_SORTS, type IssueSort, SEVERITIES, STATUSES } from "@triagent/shared";
import { ArrowDownUp, ChevronDown, Filter, Search, X } from "lucide-react";
import { type RefObject, useEffect, useId, useState } from "react";
import { Field, NativeSelect } from "@/components/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CATEGORY_LABEL, SEVERITY_LABEL, STATUS_LABEL } from "@/lib/format";
import type { Counts } from "@/lib/types";
import { activeFilters, FLAG_LABEL, FLAGS, type Flag, type IssueSearch, toggle, withFilter, withoutFilters } from "./search";

const SORT_LABEL: Record<IssueSort, string> = {
    priority: "Most urgent first",
    severity: "Severity",
    path: "File path",
    updated: "Recently changed",
    index: "Report order",
    agreement: "Most models agree",
};

/** Found by at least n of the review's models: shown when it ran with several. */
function FoundBy({ models, search, onChange }: { models: string[]; search: IssueSearch; onChange(next: IssueSearch): void }) {
    const n = models.length;
    const label = (k: number) => (k === n ? `All ${n} models` : `At least ${k} of ${n}`);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="border-dashed">
                    Found by
                    {search.foundBy && (
                        <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                            {label(Math.min(search.foundBy, n))}
                        </Badge>
                    )}
                    <ChevronDown className="text-muted-foreground" aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    This review ran with {models.join(", ")}.
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                    value={String(search.foundBy ?? "")}
                    onValueChange={(v) => onChange(withFilter(search, { foundBy: v ? Number(v) : undefined }))}
                >
                    <DropdownMenuRadioItem value="">Any model</DropdownMenuRadioItem>
                    {Array.from({ length: n - 1 }, (_, i) => i + 2).map((k) => (
                        <DropdownMenuRadioItem key={k} value={String(k)}>
                            {label(k)}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function Facet<T extends string>({
    label,
    values,
    selected,
    names,
    counts,
    onToggle,
}: {
    label: string;
    values: readonly T[];
    selected: readonly T[] | undefined;
    names: Record<T, string>;
    counts: Record<T, number> | undefined;
    onToggle(value: T): void;
}) {
    const id = useId();
    const n = selected?.length ?? 0;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="border-dashed">
                    {label}
                    {n > 0 && (
                        <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                            {n === 1 ? names[selected?.[0] as T] : `${n} selected`}
                        </Badge>
                    )}
                    <ChevronDown className="text-muted-foreground" aria-hidden="true" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-60 p-2">
                <fieldset className="grid gap-0.5">
                    <legend className="px-1 pb-1 text-xs font-medium text-muted-foreground">{label}</legend>
                    {values.map((v) => (
                        <div key={v} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-accent">
                            <Checkbox id={`${id}-${v}`} checked={selected?.includes(v) ?? false} onCheckedChange={() => onToggle(v)} />
                            <Label htmlFor={`${id}-${v}`} className="flex-1 font-normal">
                                {names[v]}
                            </Label>
                            {counts && <span className="text-xs text-muted-foreground tabular-nums">{counts[v]}</span>}
                        </div>
                    ))}
                </fieldset>
            </PopoverContent>
        </Popover>
    );
}

type FlagDraft = Record<Flag, "" | "true" | "false">;
const flagDraft = (s: IssueSearch): FlagDraft =>
    Object.fromEntries(FLAGS.map((f) => [f, s[f] === undefined ? "" : String(s[f])])) as FlagDraft;

/** Path, assignee and the yes/no flags. Applied with a button, so changing a select never reloads the list by itself. */
function OtherFilters({
    search,
    markSingles,
    onChange,
}: {
    search: IssueSearch;
    /** The review marks findings only one model found: offer that as a filter (and whenever it's already on). */
    markSingles: boolean;
    onChange(next: IssueSearch): void;
}) {
    const offered = FLAGS.filter((f) => f !== "lowerConfidence" || markSingles || search.lowerConfidence !== undefined);
    const n = ["path", "assignee", ...FLAGS].filter((k) => search[k as keyof IssueSearch] !== undefined).length;
    const [open, setOpen] = useState(false);
    const [path, setPath] = useState(search.path ?? "");
    const [assignee, setAssignee] = useState(search.assignee ?? "");
    const [flags, setFlags] = useState<FlagDraft>(() => flagDraft(search));
    const reset = () => {
        setPath(search.path ?? "");
        setAssignee(search.assignee ?? "");
        setFlags(flagDraft(search));
    };
    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                if (next) reset();
                setOpen(next);
            }}
        >
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="border-dashed">
                    <Filter /> File, assignee, flags
                    {n > 0 && (
                        <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                            {n}
                        </Badge>
                    )}
                    <ChevronDown className="text-muted-foreground" aria-hidden="true" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80">
                <form
                    className="grid gap-3"
                    onSubmit={(e) => {
                        e.preventDefault();
                        const patch: Partial<IssueSearch> = { path: path.trim() || undefined, assignee: assignee.trim() || undefined };
                        for (const f of FLAGS) patch[f] = flags[f] === "" ? undefined : flags[f] === "true";
                        onChange(withFilter(search, patch));
                        setOpen(false);
                    }}
                >
                    <Field label="File or folder" hint="A path, or a folder ending in /">
                        {(p) => <Input {...p} value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" />}
                    </Field>
                    <Field label="Assignee" hint='A name, or "none" for unassigned'>
                        {(p) => <Input {...p} value={assignee} onChange={(e) => setAssignee(e.target.value)} />}
                    </Field>
                    {offered.map((f: Flag) => (
                        <Field key={f} label={FLAG_LABEL[f].yes}>
                            {(p) => (
                                <NativeSelect
                                    {...p}
                                    value={flags[f]}
                                    onChange={(e) => setFlags({ ...flags, [f]: e.target.value as FlagDraft[Flag] })}
                                >
                                    <option value="">Any</option>
                                    <option value="true">Only these</option>
                                    <option value="false">Hide these</option>
                                </NativeSelect>
                            )}
                        </Field>
                    ))}
                    <Button type="submit" size="sm">
                        Apply filters
                    </Button>
                </form>
            </PopoverContent>
        </Popover>
    );
}

export function IssueFilters({
    search,
    counts,
    models,
    markSingles,
    onChange,
    searchRef,
}: {
    search: IssueSearch;
    counts: Counts | undefined;
    /** The models the review ran with, when it ran with several. */
    models?: string[] | null;
    /** The review marks findings only one model found as lower confidence. */
    markSingles?: boolean;
    onChange(next: IssueSearch, options?: { replace?: boolean }): void;
    searchRef: RefObject<HTMLInputElement | null>;
}) {
    const searchId = useId();
    const [q, setQ] = useState(search.q ?? "");
    useEffect(() => setQ(search.q ?? ""), [search.q]);
    // Apply the search a moment after typing stops (replacing the history entry, not adding one each key).
    useEffect(() => {
        if ((search.q ?? "") === q.trim()) return;
        const t = setTimeout(() => onChange(withFilter(search, { q: q.trim() || undefined }), { replace: true }), 300);
        return () => clearTimeout(t);
    }, [q, search, onChange]);

    const sort = search.sort ?? "priority";
    return (
        <search className="flex flex-wrap items-center gap-2" aria-label="Filter issues" data-tour="issue-filters">
            <div className="relative w-full sm:w-64">
                <Label htmlFor={searchId} className="sr-only">
                    Search issues
                </Label>
                <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    id={searchId}
                    ref={searchRef}
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") onChange(withFilter(search, { q: q.trim() || undefined }));
                        if (e.key === "Escape") e.currentTarget.blur();
                    }}
                    placeholder="Search text, file or id"
                    className="h-8 ps-8"
                />
            </div>
            <Facet
                label="Severity"
                values={SEVERITIES}
                selected={search.severity}
                names={SEVERITY_LABEL}
                counts={counts?.severity}
                onToggle={(v) => onChange(withFilter(search, { severity: toggle(search.severity, v) }))}
            />
            <Facet
                label="Status"
                values={STATUSES}
                selected={search.status}
                names={STATUS_LABEL}
                counts={counts?.status}
                onToggle={(v) => onChange(withFilter(search, { status: toggle(search.status, v) }))}
            />
            <Facet
                label="Category"
                values={CATEGORIES}
                selected={search.category}
                names={CATEGORY_LABEL}
                counts={counts?.category}
                onToggle={(v) => onChange(withFilter(search, { category: toggle(search.category, v) }))}
            />
            {models && models.length > 1 && <FoundBy models={models} search={search} onChange={onChange} />}
            <OtherFilters search={search} markSingles={Boolean(markSingles)} onChange={onChange} />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                        <ArrowDownUp />
                        <span className="sr-only">Sort: </span>
                        {SORT_LABEL[sort]}
                        <ChevronDown className="text-muted-foreground" aria-hidden="true" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                        value={sort}
                        onValueChange={(v) =>
                            onChange({ ...search, sort: v === "priority" ? undefined : (v as IssueSort), page: undefined })
                        }
                    >
                        {ISSUE_SORTS.filter((s) => s !== "agreement" || (models && models.length > 1)).map((s) => (
                            <DropdownMenuRadioItem key={s} value={s}>
                                {SORT_LABEL[s]}
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>
            {activeFilters(search) > 0 && (
                <Button variant="outline" size="sm" onClick={() => onChange(withoutFilters(search))}>
                    <X /> Clear filters
                </Button>
            )}
        </search>
    );
}
