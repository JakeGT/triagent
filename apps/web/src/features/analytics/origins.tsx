// Where findings came from, for one project's branch, in workspaces that trace them: how old the code
// behind the open findings is and the pull requests behind the most (on the Findings tab), and the
// authors leaderboard (a tab of its own, only when the workspace's admins have turned it on).
//
// Git blame names whoever last changed a line. That isn't always who wrote the problem, and both views say so.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { BarList } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { plural, timeAgo } from "@/lib/format";
import { count } from "@/lib/insights-format";
import { type AgeKey, type Origins, originKeys, originsQuery, traceOrigins } from "@/lib/origins";
import { projectsQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import type { AnalyticsSearch } from "./search";
import { Card, DataTable, Section } from "./sections";

const AGES: [AgeKey, string][] = [
    ["month", "The last 30 days"],
    ["quarter", "1 to 3 months"],
    ["year", "3 to 12 months"],
    ["older", "Over a year"],
];

/** The page's project and the branch it's about (the project's default when none is chosen). */
function useBranch(search: AnalyticsSearch) {
    const { ws } = useWorkspace();
    const projects = useQuery(projectsQuery(ws));
    const branch = search.branch ?? projects.data?.find((p) => p.slug === search.project)?.defaultBranch;
    return { project: search.project, branch };
}

/** How the last tracing went, and the button that does it again. */
function Tracing({ project, data }: { project: string; data: Origins }) {
    const { ws, can } = useWorkspace();
    const queryClient = useQueryClient();
    const trace = useMutation({
        mutationFn: () => traceOrigins(ws, project, data.branch),
        onSettled: () => queryClient.invalidateQueries({ queryKey: originKeys.branch(ws, project, data.branch) }),
    });
    const s = data.scan;
    return (
        <div className="grid justify-items-start gap-2" data-testid="tracing">
            {s?.status === "running" ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                    <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Asking GitHub who last changed each file…
                </p>
            ) : (
                <>
                    {s?.status === "failed" && <p className="text-sm text-muted-foreground">Tracing failed: {s.error}</p>}
                    {s?.status === "done" && (
                        <p className="text-xs text-muted-foreground">
                            Traced {timeAgo(s.finishedAt)} at {s.commit?.slice(0, 7)}: {plural(s.traced, "finding")} in{" "}
                            {plural(s.files, "file")}
                            {s.skipped ? `; ${count(s.skipped)} couldn't be (no lines, or a file GitHub couldn't blame)` : ""}.
                            {data.stale && " The report has moved on to another commit since."}
                        </p>
                    )}
                    {!s && <p className="text-sm text-muted-foreground">This branch's findings haven't been traced to commits yet.</p>}
                    {can("triage") && (!s || s.status === "failed" || data.stale) && (
                        <Button variant="outline" size="sm" onClick={() => trace.mutate()} disabled={trace.isPending}>
                            {trace.isPending ? "Starting…" : s ? "Trace again" : "Trace them now"}
                        </Button>
                    )}
                </>
            )}
            {trace.isError && (
                <p className="text-sm text-destructive" role="alert">
                    {errorMessage(trace.error)}
                </p>
            )}
        </div>
    );
}

/** Findings tab: the age of the code behind the open findings, and the pull requests behind the most. Nothing when it's off. */
export function WhereFrom({ search }: { search: AnalyticsSearch }) {
    const { ws } = useWorkspace();
    const { project, branch } = useBranch(search);
    const query = useQuery({ ...originsQuery(ws, project ?? "", branch ?? ""), enabled: Boolean(project && branch) });
    const data = query.data;
    if (!project || !data || data.level === "off") return null;
    return (
        <div className="grid gap-4 lg:grid-cols-2" data-testid="where-from">
            <Card title={`How old the code behind ${data.branch}'s open findings is`}>
                {data.traced > 0 && data.age ? (
                    <BarList
                        label="Open findings by when their lines were last changed"
                        rows={AGES.map(([key, label]) => ({ key, label, value: data.age?.[key] ?? 0, barClass: "bg-chart-1" }))}
                    />
                ) : null}
                <Tracing project={project} data={data} />
                <p className="text-xs text-muted-foreground">
                    From Git blame: when each finding's lines were last changed. That's often, but not always, when the problem was written.
                </p>
            </Card>
            <Card title="Pull requests behind the most open findings">
                <DataTable
                    caption="The pull requests whose changes have the most open findings, the most serious first"
                    columns={[{ label: "Pull request" }, { label: "Open", numeric: true }, { label: "Critical or high", numeric: true }]}
                    rows={data.pulls.map((p) => ({
                        key: String(p.number),
                        cells: [
                            <span key="t">
                                <span className="font-mono text-xs text-muted-foreground">#{p.number}</span> {p.title}
                            </span>,
                            count(p.open),
                            count(p.serious),
                        ],
                    }))}
                    empty={data.traced ? "None of the open findings is in code that came in by a pull request." : "Nothing traced yet."}
                />
            </Card>
        </div>
    );
}

/** The Authors tab: findings counted by who last changed the code. Only reachable when the workspace shows it. */
export function AuthorsTab({ search }: { search: AnalyticsSearch }) {
    const { ws } = useWorkspace();
    const { project, branch } = useBranch(search);
    const query = useQuery({ ...originsQuery(ws, project ?? "", branch ?? ""), enabled: Boolean(project && branch) });
    const data = query.data;
    const note = (text: string) => (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="authors-note">
            {text}
        </p>
    );
    return (
        <Section
            id="authors"
            title="Authors"
            description="Open findings by who last changed the code they're in. For fun, and for knowing who to ask: Git blame names the last person to touch a line, not always the one who wrote the problem."
        >
            {!project || !branch ? (
                note("Choose a project above to see its authors.")
            ) : query.isError ? (
                note(errorMessage(query.error))
            ) : !data ? (
                note("Loading…")
            ) : !data.authors ? (
                note("This workspace doesn't show an authors leaderboard. An admin can turn it on in Settings → Analysis.")
            ) : (
                <>
                    <Tracing project={project} data={data} />
                    <Card title={`Leaderboard for ${data.branch}`}>
                        <DataTable
                            caption="Authors by open findings in code they last changed, with how much of the code looked at is theirs"
                            columns={[
                                { label: "#", numeric: true },
                                { label: "Author" },
                                { label: "Open findings", numeric: true },
                                { label: "Critical or high", numeric: true },
                                { label: "All findings", numeric: true },
                                { label: "Lines", numeric: true },
                                { label: "Open per 1,000 lines", numeric: true },
                            ]}
                            rows={data.authors.map((a, i) => ({
                                key: a.key,
                                cells: [
                                    i + 1,
                                    <span key="a">
                                        {a.open > 0 ? (
                                            <Link
                                                to="/w/$ws/p/$project/issues"
                                                params={{ ws, project }}
                                                search={{ branch: data.branch, author: a.key, status: ["open", "in_progress"] } as never}
                                                className="link"
                                            >
                                                {a.member ?? a.name}
                                            </Link>
                                        ) : (
                                            (a.member ?? a.name)
                                        )}
                                        <span className="block font-mono text-xs text-muted-foreground">
                                            {[a.login ? `@${a.login}` : null, a.member && a.member !== a.name ? a.name : null]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </span>
                                    </span>,
                                    count(a.open),
                                    count(a.serious),
                                    count(a.findings),
                                    count(a.lines),
                                    a.perThousand === null ? (
                                        <span key="r" className="text-muted-foreground" title="Too few lines to say">
                                            —
                                        </span>
                                    ) : (
                                        a.perThousand.toFixed(1)
                                    ),
                                ],
                            }))}
                            empty="Nothing traced yet."
                        />
                        <p className="text-xs text-muted-foreground">
                            Lines are those each author last changed in the files that have findings, so someone who wrote a lot there has
                            more to be found in. A name opens their open findings. An author with fewer than 200 lines has no rate.
                        </p>
                    </Card>
                </>
            )}
        </Section>
    );
}
