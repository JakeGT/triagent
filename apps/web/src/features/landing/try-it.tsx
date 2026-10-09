// A working miniature of the Issues page, on the made-up review: filter it, open a finding, read what the
// other model said, deal with it, or let "an agent" take the next one the way real agents do (the same two
// tool calls, shown as they'd be sent). All of it is in this browser's memory; nothing is sent anywhere.

import { SEVERITIES, type Severity, type Status } from "@triagent/shared";
import { Bot, Check, RotateCcw, Undo2, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { CategoryMark, SeverityMark, StatusMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { SEVERITY_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FINDINGS, MODELS, nextToClaim, PULL_REQUEST, type SampleFinding } from "./sample";

interface Row extends SampleFinding {
    /** Who dealt with it, in words, once someone has. */
    by?: string;
}

/** Text with `code` in backticks set in the monospace face. */
function Prose({ text }: { text: string }): ReactNode {
    return text.split("`").map((part, i) =>
        i % 2 ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed sentence
            <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">
                {part}
            </code>
        ) : (
            part
        ),
    );
}

function Dots({ finding }: { finding: SampleFinding }) {
    return (
        <span className="inline-flex items-center gap-1 align-middle">
            {MODELS.map((m) => (
                <span
                    key={m}
                    aria-hidden="true"
                    className={cn("size-2 rounded-full", finding.foundBy.includes(m) ? "bg-primary" : "border border-foreground/30")}
                />
            ))}
        </span>
    );
}

const foundByText = (f: SampleFinding) =>
    f.foundBy.length === MODELS.length ? `All ${MODELS.length} models` : `${f.foundBy.length} of ${MODELS.length} models`;

const DONE: ReadonlySet<Status> = new Set(["resolved", "wont_fix"]);

export function TryIt() {
    const [rows, setRows] = useState<Row[]>(FINDINGS);
    const [severities, setSeverities] = useState<Severity[]>([]);
    const [atLeast, setAtLeast] = useState(1);
    const [openId, setOpenId] = useState<string>(FINDINGS[0]?.id ?? "");
    const [log, setLog] = useState<string[]>([]);
    const [announce, setAnnounce] = useState("");
    const [agentBusy, setAgentBusy] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

    const shown = useMemo(
        () => rows.filter((r) => (severities.length ? severities.includes(r.severity) : true) && r.foundBy.length >= atLeast),
        [rows, severities, atLeast],
    );
    const open = rows.find((r) => r.id === openId) ?? null;
    const done = rows.filter((r) => DONE.has(r.status)).length;
    const next = nextToClaim(rows);

    const set = (id: string, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    const decide = (row: Row, status: Status) => {
        set(row.id, { status, by: status === "open" ? undefined : "You" });
        setAnnounce(`${row.id} is now ${status === "wont_fix" ? "won't fix" : status}.`);
    };

    // What an agent does over MCP: claim the most urgent open issue, fix it, say what it changed.
    const runAgent = () => {
        if (!next || agentBusy) return;
        const target = next;
        setAgentBusy(true);
        setOpenId(target.id);
        set(target.id, { status: "in_progress", by: "An agent" });
        setLog([
            `→ claim_next_issue({ project: "shop", branch: "${PULL_REQUEST.branch}" })`,
            `← ${target.id}  ${target.severity}  ${target.path}:${target.line}  (found by ${target.foundBy.length} of ${MODELS.length})`,
        ]);
        setAnnounce(`An agent claimed ${target.id}.`);
        timer.current = setTimeout(() => {
            set(target.id, { status: "resolved", by: "An agent" });
            setLog((l) => [
                ...l,
                `→ update_issue({ id: "${target.id}", status: "resolved", note: "Fixed, with a test." })`,
                "← resolved; the next review will check it's gone",
            ]);
            setAnnounce(`The agent resolved ${target.id}.`);
            setAgentBusy(false);
        }, 1600);
    };

    const reset = () => {
        if (timer.current) clearTimeout(timer.current);
        setRows(FINDINGS);
        setSeverities([]);
        setAtLeast(1);
        setLog([]);
        setAgentBusy(false);
        setOpenId(FINDINGS[0]?.id ?? "");
        setAnnounce("The example is back to how it started.");
    };

    return (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm" data-testid="try-it">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
                <div className="min-w-0 flex-1">
                    <p className="font-medium">
                        <span className="font-mono text-muted-foreground">#{PULL_REQUEST.number}</span> {PULL_REQUEST.title}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        Branch <span className="font-mono">{PULL_REQUEST.branch}</span>, reviewed by {MODELS.length} models
                    </p>
                </div>
                <div className="grid w-full gap-1 sm:w-56">
                    <p className="flex justify-between text-xs text-muted-foreground" data-testid="try-progress">
                        <span>Dealt with</span>
                        <span className="tabular-nums">
                            {done} of {rows.length}
                        </span>
                    </p>
                    <progress
                        value={done}
                        max={rows.length}
                        aria-label="Findings dealt with"
                        className="h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-st-resolved [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-st-resolved [&::-webkit-progress-value]:transition-all"
                    />
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
                <fieldset className="flex flex-wrap items-center gap-1.5">
                    <legend className="sr-only">Severity</legend>
                    {SEVERITIES.map((s) => {
                        const on = severities.includes(s);
                        return (
                            <Button
                                key={s}
                                type="button"
                                size="sm"
                                variant={on ? "secondary" : "outline"}
                                aria-pressed={on}
                                className="h-7 border-dashed"
                                onClick={() => setSeverities(on ? severities.filter((x) => x !== s) : [...severities, s])}
                            >
                                {SEVERITY_LABEL[s]}
                                <span className="text-xs text-muted-foreground tabular-nums">
                                    {rows.filter((r) => r.severity === s).length}
                                </span>
                            </Button>
                        );
                    })}
                </fieldset>
                <fieldset className="flex items-center gap-1 rounded-md border bg-background p-0.5">
                    <legend className="sr-only">Found by</legend>
                    {[1, 2, MODELS.length].map((n) => (
                        <Button
                            key={n}
                            type="button"
                            size="sm"
                            variant={atLeast === n ? "secondary" : "ghost"}
                            aria-pressed={atLeast === n}
                            className="h-6 px-2 text-xs"
                            onClick={() => setAtLeast(n)}
                        >
                            {n === 1 ? "Any model" : n === MODELS.length ? `All ${n}` : `${n} or more`}
                        </Button>
                    ))}
                </fieldset>
                <span className="ms-auto flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" className="h-7" onClick={runAgent} disabled={!next || agentBusy}>
                        <Bot /> {agentBusy ? "Agent working…" : next ? "Let an agent take the next one" : "Nothing left to take"}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7" onClick={reset}>
                        <RotateCcw /> Start again
                    </Button>
                </span>
            </div>

            <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
                <div className="min-w-0 overflow-x-auto lg:border-e">
                    <table className="w-full text-sm">
                        <caption className="sr-only">Findings on this pull request, most urgent first</caption>
                        <thead>
                            <tr className="border-b text-start text-xs text-muted-foreground">
                                <th scope="col" className="px-4 py-2 text-start font-medium">
                                    Severity
                                </th>
                                <th scope="col" className="px-2 py-2 text-start font-medium">
                                    Finding
                                </th>
                                <th scope="col" className="px-4 py-2 text-start font-medium">
                                    Status
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((r) => (
                                <tr
                                    key={r.id}
                                    className={cn(
                                        "border-b align-top transition-colors last:border-b-0",
                                        r.id === openId ? "bg-accent/60" : "hover:bg-accent/30",
                                    )}
                                >
                                    <td className="px-4 py-2.5 whitespace-nowrap">
                                        <SeverityMark severity={r.severity} className="text-xs" />
                                    </td>
                                    <td className="px-2 py-2.5">
                                        <button
                                            type="button"
                                            onClick={() => setOpenId(r.id)}
                                            aria-current={r.id === openId ? "true" : undefined}
                                            className={cn(
                                                "text-start font-medium hover:underline focus-visible:underline focus-visible:outline-none",
                                                DONE.has(r.status) && "text-muted-foreground line-through decoration-foreground/30",
                                            )}
                                        >
                                            <Prose text={r.title} />
                                        </button>
                                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                                            <span className="font-mono">
                                                {r.path}:{r.line}
                                            </span>
                                            <span className="inline-flex items-center gap-1.5">
                                                <Dots finding={r} /> {foundByText(r)}
                                            </span>
                                        </p>
                                    </td>
                                    <td className="px-4 py-2.5 whitespace-nowrap">
                                        <StatusMark status={r.status} className="text-xs" />
                                    </td>
                                </tr>
                            ))}
                            {shown.length === 0 && (
                                <tr>
                                    <td colSpan={3} className="px-4 py-8 text-center text-sm text-muted-foreground">
                                        No findings match these filters.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="grid content-start gap-3 border-t p-4 lg:border-t-0" data-testid="try-panel">
                    {open ? (
                        <>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                                <SeverityMark severity={open.severity} />
                                <CategoryMark category={open.category} />
                                <StatusMark status={open.status} />
                            </div>
                            <h3 className="text-base leading-snug font-semibold">
                                <Prose text={open.title} />
                            </h3>
                            <p className="font-mono text-xs text-muted-foreground">
                                {open.path}:{open.line} · {open.id}
                            </p>
                            <p className="text-sm">
                                <Prose text={open.body} />
                            </p>
                            {open.suggestion && <p className="-mb-1.5 text-xs font-medium text-muted-foreground">Suggested change</p>}
                            {open.suggestion && (
                                <pre
                                    className="overflow-x-auto rounded-md border font-mono text-xs leading-relaxed"
                                    // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable by keyboard
                                    tabIndex={0}
                                >
                                    {open.suggestion.before.split("\n").map((l) => (
                                        <span key={`-${l}`} className="block bg-diff-del px-2.5 py-0.5">
                                            <span aria-hidden="true">- </span>
                                            <span className="sr-only">Removed: </span>
                                            {l}
                                        </span>
                                    ))}
                                    {open.suggestion.after.split("\n").map((l) => (
                                        <span key={`+${l}`} className="block bg-diff-add px-2.5 py-0.5">
                                            <span aria-hidden="true">+ </span>
                                            <span className="sr-only">Added: </span>
                                            {l}
                                        </span>
                                    ))}
                                </pre>
                            )}
                            <div className="grid gap-1.5 rounded-md border bg-muted/30 p-3 text-sm">
                                <p className="flex flex-wrap items-center gap-x-2 font-medium">
                                    <Dots finding={open} /> Found by {foundByText(open).toLowerCase()}
                                </p>
                                <p className="font-mono text-xs text-muted-foreground">{open.foundBy.join(", ")}</p>
                                {open.also && (
                                    <details className="group text-sm">
                                        <summary className="cursor-pointer text-primary underline-offset-2 hover:underline">
                                            What {open.also.model} said
                                        </summary>
                                        <p className="mt-1.5 text-muted-foreground">
                                            <Prose text={open.also.text} />
                                        </p>
                                    </details>
                                )}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                {DONE.has(open.status) ? (
                                    <Button type="button" size="sm" variant="outline" onClick={() => decide(open, "open")}>
                                        <Undo2 /> Reopen
                                    </Button>
                                ) : (
                                    <>
                                        <Button type="button" size="sm" onClick={() => decide(open, "resolved")} disabled={agentBusy}>
                                            <Check /> Resolve
                                        </Button>
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() => decide(open, "wont_fix")}
                                            disabled={agentBusy}
                                        >
                                            <X /> Won't fix
                                        </Button>
                                    </>
                                )}
                                {open.by && open.status !== "open" && (
                                    <span className="text-xs text-muted-foreground">
                                        {open.by}{" "}
                                        {open.status === "in_progress"
                                            ? "claimed it"
                                            : open.status === "resolved"
                                              ? "resolved it"
                                              : "marked it won't fix"}
                                        .
                                    </span>
                                )}
                            </div>
                        </>
                    ) : (
                        <p className="text-sm text-muted-foreground">Choose a finding to read it.</p>
                    )}

                    {log.length > 0 && (
                        <div className="dark rounded-md border border-white/10 bg-[#11161a] p-3 text-foreground" data-testid="agent-log">
                            <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Bot className="size-3.5" aria-hidden="true" /> What the agent sent, over MCP
                            </p>
                            <pre
                                className="overflow-x-auto font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap"
                                // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable by keyboard
                                tabIndex={0}
                            >
                                {log.map((l) => (
                                    <span key={l} className={cn("block", l.startsWith("←") && "text-muted-foreground")}>
                                        {l}
                                    </span>
                                ))}
                            </pre>
                        </div>
                    )}
                </div>
            </div>
            <p className="sr-only" role="status" aria-live="polite">
                {announce}
            </p>
        </div>
    );
}
