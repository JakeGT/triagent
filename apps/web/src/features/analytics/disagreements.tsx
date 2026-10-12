// Analytics → Models, for one project: where the models of the branch's review disagreed. The same
// finding rated differently, and findings from different models at the same lines that weren't merged
// (they filed them under different kinds of problem, mostly): the second is where agreement is undercounted.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { CategoryMark, SeverityMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";
import { count } from "@/lib/insights-format";
import { disagreementsQuery } from "@/lib/insights-queries";
import type { DisagreementSide, Disagreements as Found } from "@/lib/insights-types";
import { projectsQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import { Card } from "./sections";

/** How many of each list show before "Show all". */
const FIRST = 5;

const lines = (from: number | null, to?: number | null) => (from === null ? "" : `:${from}${to && to !== from ? `–${to}` : ""}`);

function IssueLink({
    project,
    branch,
    id,
    done,
    children,
}: {
    project: string;
    branch: string;
    id: string;
    done: boolean;
    children: ReactNode;
}) {
    const { ws } = useWorkspace();
    return (
        <Link
            to="/w/$ws/p/$project/issues/$issueId"
            params={{ ws, project, issueId: id }}
            search={{ branch } as never}
            className={done ? "link text-muted-foreground line-through" : "link"}
            title={done ? "Dealt with in triage" : undefined}
        >
            {children}
        </Link>
    );
}

/** A list that shows its first few rows, and the rest when asked. */
function Rows<T>({ items, total, what, children }: { items: T[]; total: number; what: string; children(item: T): ReactNode }) {
    const [all, setAll] = useState(false);
    const shown = all ? items : items.slice(0, FIRST);
    return (
        <>
            <ul className="grid gap-3">{shown.map(children)}</ul>
            {items.length > FIRST && (
                <div>
                    <Button variant="outline" size="sm" onClick={() => setAll(!all)} aria-expanded={all}>
                        {all ? "Show fewer" : `Show all ${count(items.length)}`}
                    </Button>
                </div>
            )}
            {total > items.length && (
                <p className="text-xs text-muted-foreground">
                    The first {count(items.length)} of {count(total)} {what}.
                </p>
            )}
        </>
    );
}

function Side({ project, branch, side }: { project: string; branch: string; side: DisagreementSide }) {
    return (
        <div className="grid gap-0.5">
            <span className="flex flex-wrap items-baseline gap-x-2">
                <SeverityMark severity={side.severity} />
                <CategoryMark category={side.category} />
                <span className="text-xs text-muted-foreground">{side.foundBy.join(", ")}</span>
            </span>
            <IssueLink project={project} branch={branch} id={side.id} done={side.status === "resolved" || side.status === "wont_fix"}>
                {side.title}
            </IssueLink>
        </div>
    );
}

function Lists({ project, d }: { project: string; d: Found }) {
    return (
        <div className="grid gap-4 lg:grid-cols-2" data-testid="disagreements">
            <Card title="Rated differently">
                {d.rated.total ? (
                    <>
                        <p className="text-sm text-muted-foreground">
                            {plural(d.rated.total, "finding")} more than one model found, and gave different severities. The finding shows
                            the first one's.
                        </p>
                        <Rows items={d.rated.items} total={d.rated.total} what="findings">
                            {(r) => (
                                <li key={r.id} className="grid gap-1 border-t pt-3 first:border-t-0 first:pt-0">
                                    <IssueLink
                                        project={project}
                                        branch={d.branch}
                                        id={r.id}
                                        done={r.status === "resolved" || r.status === "wont_fix"}
                                    >
                                        {r.title}
                                    </IssueLink>
                                    <span className="font-mono text-xs break-all text-muted-foreground">
                                        {r.path}
                                        {lines(r.startLine)}
                                    </span>
                                    <span className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
                                        {r.ratings.map((x) => (
                                            <span key={x.model} className="inline-flex items-baseline gap-1.5">
                                                <span className="text-muted-foreground">{x.model}</span>
                                                {x.severity ? <SeverityMark severity={x.severity} /> : "not rated"}
                                            </span>
                                        ))}
                                    </span>
                                </li>
                            )}
                        </Rows>
                    </>
                ) : (
                    <p className="text-sm text-muted-foreground">Wherever several models found the same thing, they rated it the same.</p>
                )}
            </Card>
            <Card title="Near each other, not merged">
                {d.apart.total ? (
                    <>
                        <p className="text-sm text-muted-foreground">
                            {plural(d.apart.total, "pair")} of findings from different models at the same lines, kept apart because they
                            were filed as different kinds of problem. Where a pair is one problem, mark one a duplicate of the other.
                        </p>
                        <Rows items={d.apart.items} total={d.apart.total} what="pairs">
                            {(x) => (
                                <li key={`${x.a.id}:${x.b.id}`} className="grid gap-2 border-t pt-3 first:border-t-0 first:pt-0">
                                    <span className="font-mono text-xs break-all text-muted-foreground">
                                        {x.path}
                                        {lines(Math.min(x.a.startLine, x.b.startLine), Math.max(x.a.endLine, x.b.endLine))}
                                    </span>
                                    <Side project={project} branch={d.branch} side={x.a} />
                                    <Side project={project} branch={d.branch} side={x.b} />
                                </li>
                            )}
                        </Rows>
                    </>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        No two models reported different things at the same lines: what could be merged was.
                    </p>
                )}
            </Card>
        </div>
    );
}

/** `project` and `branch` are the page's scope: without a project there's no one report to look at. */
export function Disagreements({ project, branch }: { project: string | null; branch: string | null }) {
    const { ws } = useWorkspace();
    const projects = useQuery(projectsQuery(ws));
    const on = branch ?? projects.data?.find((p) => p.slug === project)?.defaultBranch ?? null;
    const query = useQuery({ ...disagreementsQuery(ws, project ?? "", on ?? ""), enabled: Boolean(project && on) });
    const note = (text: string) => (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="disagreements-note">
            {text}
        </p>
    );
    return (
        <div className="grid gap-3">
            <div className="space-y-0.5">
                <h3 className="text-base font-semibold">Where models disagreed</h3>
                <p className="text-sm text-muted-foreground">
                    {project && on
                        ? `In the report on ${on}: the latest review of that branch.`
                        : "In one branch's report: its latest review."}
                </p>
            </div>
            {!project ? (
                note("Choose a project above to see where its models disagreed.")
            ) : query.isError ? (
                note("Couldn't load this branch's disagreements.")
            ) : !query.data ? (
                note("Loading…")
            ) : !query.data.models ? (
                note(`The report on ${query.data.branch} is from one model, so there's nothing to disagree about.`)
            ) : (
                <Lists project={project} d={query.data} />
            )}
        </div>
    );
}
