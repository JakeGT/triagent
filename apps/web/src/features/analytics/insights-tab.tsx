// Analytics → Insights: what the workspace's analysis model writes from the figures on the other tabs.
// A question, answered from the analytics for the page's scope (and up to three issue lists it may ask
// to see, each linked so the answer can be checked); and, for one project, what its branch's latest
// review changed and how that review's models compare. It never sees code, and says so.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Markdown } from "@/components/markdown";
import { SeverityMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Caution, NoModel, Writing, Written, WrittenBy } from "@/features/analysis/written";
import {
    type Analysis,
    type AnalysisLookup,
    analysisKeys,
    analysisQuery,
    analysisSettingsQuery,
    askQuestion,
    branchAnalysisQuery,
    writeForRun,
} from "@/lib/analysis";
import { errorMessage } from "@/lib/api";
import { count } from "@/lib/insights-format";
import type { Days } from "@/lib/insights-types";
import { falsePositivesQuery, patternApi, patternKeys } from "@/lib/patterns";
import { projectsQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import type { AnalyticsSearch } from "./search";
import { Card, Section } from "./sections";

const MAX_QUESTION = 500;
const EXAMPLES = ["What should we fix first?", "Which model finds the most that the others miss?", "Where are the open critical findings?"];

/** A lookup as the Issues page's address. */
function LookupLink({ lookup }: { lookup: AnalysisLookup }) {
    const { ws } = useWorkspace();
    const { project, label, total, error, ...filters } = lookup;
    if (error)
        return (
            <span className="text-muted-foreground">
                {label}: {error}
            </span>
        );
    return (
        <>
            <Link to="/w/$ws/p/$project/issues" params={{ ws, project }} search={filters as never} className="link">
                {label}
            </Link>{" "}
            <span className="text-muted-foreground tabular-nums">({count(total)})</span>
        </>
    );
}

function Answer({ analysis }: { analysis: Analysis }) {
    const lookups = analysis.result?.lookups ?? [];
    return (
        <div className="grid gap-3 border-t pt-4" data-testid="answer" aria-live="polite">
            <p className="text-sm font-medium">{analysis.input?.question}</p>
            {analysis.status === "running" ? (
                <Writing analysis={analysis} />
            ) : analysis.status === "failed" ? (
                <p className="text-sm text-muted-foreground" data-testid="analysis-failed">
                    {analysis.error} Ask again.
                </p>
            ) : (
                <>
                    {analysis.result?.warning && <Caution>{analysis.result.warning}</Caution>}
                    <Markdown className="max-w-measure text-[0.9375rem] leading-relaxed">{analysis.result?.markdown ?? ""}</Markdown>
                    <div className="grid gap-1 text-sm">
                        <p className="text-muted-foreground">
                            Answered from the analytics for {analysis.result?.scope}
                            {lookups.length ? ", and from:" : "."}
                        </p>
                        {lookups.length > 0 && (
                            <ul className="grid list-disc gap-0.5 ps-5">
                                {lookups.map((l, i) => (
                                    // biome-ignore lint/suspicious/noArrayIndexKey: an answer's lookups are a fixed list, and two can read alike
                                    <li key={`${i}:${l.label}`}>
                                        <LookupLink lookup={l} />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <WrittenBy analysis={analysis} />
                </>
            )}
        </div>
    );
}

function Ask({ search, scope }: { search: AnalyticsSearch; scope: string }) {
    const { ws, can } = useWorkspace();
    const settings = useQuery(analysisSettingsQuery(ws));
    const [question, setQuestion] = useState("");
    const [asked, setAsked] = useState<string | null>(null);
    const answer = useQuery({ ...analysisQuery(ws, asked ?? ""), enabled: asked !== null });
    const ask = useMutation({
        mutationFn: (q: string) =>
            askQuestion(ws, {
                question: q,
                days: (search.days ?? 30) as Days,
                ...(search.project ? { project: search.project } : {}),
                ...(search.project && search.branch ? { branch: search.branch } : {}),
            }),
        onSuccess: (a) => setAsked(a.id),
    });
    // From the click until there's an answer to show: asking, then the answer's first load, then while it's being written.
    const waiting = ask.isPending || (asked !== null && !answer.data && !answer.isError) || answer.data?.status === "running";
    const model = settings.data;
    return (
        <Card title="Ask a question">
            {model && !model.ready ? (
                <NoModel model={{ ready: false, reason: model.reason ?? "" }} />
            ) : !can("triage") ? (
                <p className="text-sm text-muted-foreground">Asking uses the workspace's model, so it needs the right to triage.</p>
            ) : (
                <form
                    className="grid gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (question.trim().length >= 3) ask.mutate(question.trim());
                    }}
                >
                    <Label htmlFor="ask-question">About {scope}</Label>
                    <div className="flex flex-wrap gap-2">
                        <Input
                            id="ask-question"
                            className="min-w-0 flex-1 basis-64"
                            value={question}
                            maxLength={MAX_QUESTION}
                            onChange={(e) => setQuestion(e.target.value)}
                            placeholder="Which folders have the most open critical findings?"
                            autoComplete="off"
                        />
                        <Button type="submit" disabled={waiting || question.trim().length < 3}>
                            {waiting ? "Asking…" : "Ask"}
                        </Button>
                    </div>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        Try:
                        {EXAMPLES.map((e) => (
                            <button key={e} type="button" className="link" onClick={() => setQuestion(e)}>
                                {e}
                            </button>
                        ))}
                    </p>
                    {ask.isError && (
                        <p className="text-sm text-destructive" role="alert">
                            {errorMessage(ask.error)}
                        </p>
                    )}
                </form>
            )}
            {answer.data && <Answer analysis={answer.data} />}
        </Card>
    );
}

/** One project's branch: what its latest review changed, and how that review's models compare. */
function LatestReview({ project, branch }: { project: string; branch: string }) {
    const { ws } = useWorkspace();
    const queryClient = useQueryClient();
    const { data, isError, error } = useQuery(branchAnalysisQuery(ws, project, branch));
    const write = useMutation({
        mutationFn: ({ runId, kind }: { runId: string; kind: "comparison" | "summary" }) => writeForRun(ws, runId, kind),
        onSettled: () => queryClient.invalidateQueries({ queryKey: analysisKeys.all(ws) }),
    });
    if (isError)
        return (
            <p className="text-sm text-destructive" role="alert">
                Couldn't load what's been written about {branch}: {errorMessage(error)}
            </p>
        );
    if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
    const run = (r: { id: string; title: string } | null): ReactNode =>
        r && (
            <p className="text-sm text-muted-foreground">
                <Link to="/w/$ws/p/$project/runs/$runId" params={{ ws, project, runId: r.id }} className="link">
                    {r.title}
                </Link>
            </p>
        );
    const part = (kind: "summary" | "comparison", ask: string, none: string) => {
        const p = data[kind];
        return (
            <>
                {run(p.run)}
                <Written
                    analysis={p.analysis}
                    model={data.model}
                    unavailable={p.run ? null : none}
                    ask={ask}
                    onAsk={() => p.run && write.mutate({ runId: p.run.id, kind })}
                    asking={write.isPending && write.variables?.kind === kind}
                    error={write.isError && write.variables?.kind === kind ? errorMessage(write.error) : null}
                />
            </>
        );
    };
    return (
        <div className="grid gap-4 lg:grid-cols-2" data-testid="latest-review">
            <Card title={`What the latest review of ${branch} changed`}>
                {part("summary", "Write a summary", `No review run here has finished on ${branch} yet.`)}
            </Card>
            <Card title="Its models compared">
                {part("comparison", "Write a comparison", `No review of ${branch} has finished with two or more models yet.`)}
            </Card>
        </div>
    );
}

/** Open findings a model thinks the team would dismiss, going by what it has dismissed before. Suggestions: nothing is closed. */
function LikelyFalsePositives({ project, branch }: { project: string; branch: string }) {
    const { ws, can } = useWorkspace();
    const queryClient = useQueryClient();
    const { data } = useQuery(falsePositivesQuery(ws, project, branch));
    const find = useMutation({
        mutationFn: () => patternApi.findFalsePositives(ws, project, branch),
        onSettled: () => queryClient.invalidateQueries({ queryKey: patternKeys.falsePositives(ws, project, branch) }),
    });
    if (!data) return null;
    const a = data.analysis;
    const looked = a?.status === "done";
    return (
        <Card title="Likely false positives">
            <p className="max-w-measure text-sm text-muted-foreground">
                Open findings on {branch} that look like ones this project has already dismissed, going by the reason given each time.
                Suggestions to check: nothing is closed for you.
            </p>
            {data.dismissed === 0 ? (
                <Caution>
                    Nothing has been dismissed with a reason in this project yet, so there's nothing to learn from. Mark findings won't fix
                    with a note saying why, and come back.
                </Caution>
            ) : a?.status === "running" ? (
                <Writing analysis={a} />
            ) : (
                <>
                    {looked && a.result?.warning && <Caution>{a.result.warning}</Caution>}
                    {!looked && data.dismissed < data.enough && (
                        <Caution>
                            Only {data.dismissed} {data.dismissed === 1 ? "finding has" : "findings have"} been dismissed with a reason
                            here. Suggestions drawn from fewer than {data.enough} are guesses.
                        </Caution>
                    )}
                    {a?.status === "failed" && (
                        <p className="text-sm text-muted-foreground" data-testid="analysis-failed">
                            {a.error}
                        </p>
                    )}
                    {looked &&
                        (data.items.length ? (
                            <ul className="grid gap-3" data-testid="false-positives">
                                {data.items.map((x) => (
                                    <li key={x.id} className="grid gap-1 border-t pt-3 text-sm first:border-t-0 first:pt-0">
                                        <span className="flex flex-wrap items-baseline gap-x-2">
                                            <SeverityMark severity={x.severity} />
                                            <Link
                                                to="/w/$ws/p/$project/issues/$issueId"
                                                params={{ ws, project, issueId: x.id }}
                                                search={{ branch } as never}
                                                className="link"
                                            >
                                                {x.title}
                                            </Link>
                                        </span>
                                        <span className="font-mono text-xs break-all text-muted-foreground">
                                            {x.path}
                                            {x.startLine ? `:${x.startLine}` : ""}
                                        </span>
                                        {x.why && <span>{x.why}</span>}
                                        <span className="text-muted-foreground">
                                            Like “{x.like.title}”, dismissed because: {x.like.reason}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm">None of the open findings it looked at seem to be cases like those.</p>
                        ))}
                    {looked && <WrittenBy analysis={a} />}
                    {can("triage") &&
                        (data.model.ready ? (
                            <div>
                                <Button variant="outline" size="sm" onClick={() => find.mutate()} disabled={find.isPending}>
                                    {find.isPending ? "Asking…" : looked ? "Look again" : "Look for likely false positives"}
                                </Button>
                            </div>
                        ) : (
                            <NoModel model={data.model} />
                        ))}
                    {find.isError && (
                        <p className="text-sm text-destructive" role="alert">
                            {errorMessage(find.error)}
                        </p>
                    )}
                </>
            )}
        </Card>
    );
}

export function InsightsTab({ search, scope }: { search: AnalyticsSearch; scope: string }) {
    const { ws } = useWorkspace();
    const projects = useQuery(projectsQuery(ws));
    const branch = search.branch ?? projects.data?.find((p) => p.slug === search.project)?.defaultBranch;
    return (
        <Section
            id="insights"
            title="Insights"
            description="Written by the workspace's analysis model from the figures on the other tabs. It hasn't seen your code: read it as a view of the numbers, and check what it points to."
        >
            <Ask search={search} scope={scope} />
            {search.project && branch ? (
                <>
                    <LatestReview project={search.project} branch={branch} />
                    <LikelyFalsePositives project={search.project} branch={branch} />
                </>
            ) : search.project ? (
                // A project is chosen: its default branch is on its way with the list of projects.
                <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
                <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="insights-note">
                    Choose a project above to see what its latest review changed, how that review's models compare, and which open findings
                    look like ones already dismissed.
                </p>
            )}
        </Section>
    );
}
