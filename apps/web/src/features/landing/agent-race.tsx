// Three coding agents let loose on one list, to show the one thing that makes that safe: claiming. Each
// asks for the next issue and is handed a different one, most urgent first; the finding flagged for
// discussion is left for a person. A picture of a terminal, so it is dark in both themes. Nothing runs
// until the reader starts it, and nothing here is sent anywhere.

import { Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SeverityMark, StatusMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FINDINGS, MODELS, PULL_REQUEST, type SampleFinding } from "./sample";

/** Each agent, and how long it takes over a fix: different, so they finish out of step. */
const AGENTS = [
    { name: "Claude Code", id: "claude-code", ms: 1500 },
    { name: "Codex", id: "codex", ms: 2100 },
    { name: "Cursor", id: "cursor", ms: 1800 },
] as const;
type Agent = (typeof AGENTS)[number];

/** The one a person has to decide first. */
const DISCUSS = "ocr-5e07c2f4";
const LOG_LINES = 9;

interface Row {
    finding: SampleFinding;
    state: "open" | "in_progress" | "resolved";
    by?: string;
}
interface Line {
    n: number;
    who: string;
    mark: "→" | "←";
    text: string;
}

const fresh = (): Row[] => FINDINGS.map((finding) => ({ finding, state: "open" }));

export function AgentRace({ mcp }: { mcp: string }) {
    const [rows, setRows] = useState<Row[]>(fresh);
    const [log, setLog] = useState<Line[]>([]);
    const [phase, setPhase] = useState<"ready" | "running" | "done">("ready");
    // The list as the timers see it: an agent claims from what is true now, not from when it was started.
    const live = useRef<Row[]>(rows);
    const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
    const lines = useRef(0);
    const working = useRef(0);
    const logEl = useRef<HTMLPreElement>(null);

    const stop = useCallback(() => {
        for (const t of timers.current) clearTimeout(t);
        timers.current.clear();
    }, []);
    useEffect(() => stop, [stop]);

    const later = (ms: number, run: () => void) => {
        const t = setTimeout(() => {
            timers.current.delete(t);
            run();
        }, ms);
        timers.current.add(t);
    };
    const say = (who: string, mark: Line["mark"], text: string) =>
        setLog((old) => [...old, { n: lines.current++, who, mark, text }].slice(-LOG_LINES));
    const change = (id: string, patch: Partial<Row>) => {
        live.current = live.current.map((r) => (r.finding.id === id ? { ...r, ...patch } : r));
        setRows(live.current);
    };

    const claim = (agent: Agent) => {
        // FINDINGS is in the order claiming uses: most urgent first.
        const next = live.current.find((r) => r.state === "open" && r.finding.id !== DISCUSS);
        say(agent.id, "→", `claim_next_issue({ branch: "${PULL_REQUEST.branch}" })`);
        if (!next) {
            say(agent.id, "←", "nothing left to claim: one issue is waiting for a person");
            working.current -= 1;
            if (working.current === 0) setPhase("done");
            return;
        }
        const f = next.finding;
        change(f.id, { state: "in_progress", by: agent.name });
        say(agent.id, "←", `${f.id}  ${f.severity}  ${f.path}:${f.line}  found by ${f.foundBy.length} of ${MODELS.length}`);
        later(agent.ms, () => {
            change(f.id, { state: "resolved", by: agent.name });
            say(agent.id, "→", `update_issue({ id: "${f.id}", status: "resolved", note: "Fixed, with a test." })`);
            later(350, () => claim(agent));
        });
    };

    const start = () => {
        stop();
        live.current = fresh();
        setRows(live.current);
        setLog([]);
        setPhase("running");
        working.current = AGENTS.length;
        // One after another, a moment apart, as three people would press Enter.
        AGENTS.forEach((agent, i) => {
            later(150 + i * 260, () => claim(agent));
        });
    };
    const reset = () => {
        stop();
        live.current = fresh();
        setRows(live.current);
        setLog([]);
        setPhase("ready");
    };

    // The newest line stays in view, as it does in a terminal.
    // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a line is added
    useEffect(() => {
        if (logEl.current) logEl.current.scrollTop = logEl.current.scrollHeight;
    }, [log]);

    const resolved = rows.filter((r) => r.state === "resolved").length;
    return (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden rounded-lg border bg-[#11161a]" data-testid="agent-race">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">Three agents, one list.</span>{" "}
                    <span data-testid="race-count">
                        {resolved} of {rows.length} resolved
                    </span>
                </p>
                {phase === "ready" ? (
                    <Button type="button" size="sm" onClick={start}>
                        <Play /> Send them in
                    </Button>
                ) : (
                    <Button type="button" size="sm" variant="outline" onClick={reset}>
                        <RotateCcw /> Start again
                    </Button>
                )}
            </div>

            <ul className="grid grid-cols-[minmax(0,1fr)] border-b" aria-label="The issues on this branch">
                {rows.map((r) => {
                    const waiting = r.finding.id === DISCUSS;
                    return (
                        <li
                            key={r.finding.id}
                            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b px-4 py-1.5 last:border-b-0 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto]"
                        >
                            <SeverityMark severity={r.finding.severity} className="text-xs max-sm:hidden" />
                            <span
                                className={cn(
                                    "min-w-0 truncate text-sm",
                                    r.state === "resolved" && "text-muted-foreground line-through decoration-foreground/40",
                                )}
                            >
                                {r.finding.title}
                            </span>
                            {/* Who has it and where it stands, each in its own column so they line up down the list. */}
                            <span className="flex items-center gap-3 text-xs">
                                {waiting ? (
                                    <span className="text-muted-foreground">Needs discussion</span>
                                ) : (
                                    <>
                                        <span className="w-20 text-end font-medium max-sm:hidden">{r.by}</span>
                                        <StatusMark status={r.state} className="sm:w-[5.5rem]" />
                                    </>
                                )}
                            </span>
                        </li>
                    );
                })}
            </ul>

            <pre
                ref={logEl}
                className="h-[15.5rem] overflow-auto p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable by keyboard
                tabIndex={0}
                data-testid="race-log"
            >
                {log.length === 0 ? (
                    <>
                        <span className="block ps-5 -indent-5">
                            <span className="me-2 inline-block w-3 indent-0 text-muted-foreground select-none">$</span>
                            claude mcp add --transport http triagent {mcp} \
                        </span>
                        <span className="block ps-10">--header "Authorization: Bearer tri_…"</span>
                        <span className="block min-h-[1lh]" />
                        <span className="block ps-5 -indent-5">
                            <span className="me-2 inline-block w-3 indent-0 text-muted-foreground select-none">›</span>
                            Work through the review findings on this branch.
                        </span>
                    </>
                ) : (
                    log.map((l) => (
                        <span key={l.n} className={cn("flex gap-[1ch]", l.mark === "←" && "text-muted-foreground")}>
                            <span className="w-[11ch] shrink-0 text-muted-foreground select-none max-sm:w-[6ch] max-sm:truncate">
                                {l.who}
                            </span>
                            <span className="shrink-0 select-none">{l.mark}</span>
                            <span className="min-w-0">{l.text}</span>
                        </span>
                    ))
                )}
            </pre>
            <p className="sr-only" role="status" aria-live="polite">
                {phase === "done" ? `The agents resolved ${resolved} issues and left one for a person.` : ""}
            </p>
        </div>
    );
}
