// A finished review's models side by side: what each found, what only it found, how serious, what became
// of it in triage, and what it cost. Under the run's own details, for reviews run with several models.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SEVERITIES } from "@triagent/shared";
import { SeverityMark } from "@/components/marks";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { count, usd } from "@/lib/insights-format";
import { runModelsQuery } from "@/lib/insights-queries";

export function RunModelsTable({ ws, project, runId, branch }: { ws: string; project: string; runId: string; branch: string }) {
    const { data } = useQuery(runModelsQuery(ws, runId));
    // Nothing to compare, or nothing was kept to compare with (a review from before this was): the list above is enough.
    if (!data?.recorded || data.models.length < 2) return null;
    const dash = <span className="text-muted-foreground">—</span>;
    return (
        <section aria-labelledby="run-models-title" className="grid gap-1" data-testid="run-models-table">
            <h3 id="run-models-title" className="text-sm font-medium">
                Models side by side
            </h3>
            <div className="overflow-x-auto rounded-md border">
                <Table>
                    <caption className="sr-only">What each model of this review found, and what became of it</caption>
                    <TableHeader>
                        <TableRow>
                            <TableHead scope="col">Model</TableHead>
                            <TableHead scope="col" className="text-end">
                                Findings
                            </TableHead>
                            <TableHead scope="col" className="text-end">
                                Only it found
                            </TableHead>
                            <TableHead scope="col">By severity</TableHead>
                            <TableHead scope="col" className="text-end">
                                Accepted
                            </TableHead>
                            <TableHead scope="col" className="text-end">
                                Rejected
                            </TableHead>
                            <TableHead scope="col" className="text-end">
                                Cost
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data.models.map((m, i) => {
                            const severities = SEVERITIES.filter((s) => m.bySeverity?.[s]);
                            return (
                                // biome-ignore lint/suspicious/noArrayIndexKey: a review's models are in a fixed order
                                <TableRow key={`${i}:${m.label}`}>
                                    <TableCell className="min-w-32 whitespace-normal">
                                        {m.findings ? (
                                            // Its findings, in the issues list.
                                            <Link
                                                to="/w/$ws/p/$project/issues"
                                                params={{ ws, project }}
                                                search={{ branch, model: m.label } as never}
                                                className="link"
                                            >
                                                {m.label}
                                            </Link>
                                        ) : (
                                            m.label
                                        )}
                                    </TableCell>
                                    <TableCell className="text-end tabular-nums">
                                        {m.findings === null ? dash : count(m.findings)}
                                    </TableCell>
                                    <TableCell className="text-end tabular-nums">{m.unique === null ? dash : count(m.unique)}</TableCell>
                                    <TableCell>
                                        {severities.length ? (
                                            <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                                                {severities.map((s) => (
                                                    <span key={s} className="inline-flex items-center gap-1 tabular-nums">
                                                        {m.bySeverity?.[s]} <SeverityMark severity={s} />
                                                    </span>
                                                ))}
                                            </span>
                                        ) : (
                                            dash
                                        )}
                                    </TableCell>
                                    <TableCell className="text-end tabular-nums">
                                        {m.accepted === null ? dash : count(m.accepted)}
                                    </TableCell>
                                    <TableCell className="text-end tabular-nums">
                                        {m.rejected === null ? dash : count(m.rejected)}
                                    </TableCell>
                                    {/* Nothing to price without its tokens; with them, usd() says "No price" when the model has none. */}
                                    <TableCell className="text-end tabular-nums">{m.tokens === null ? dash : usd(m.cost)}</TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
            <p className="text-xs text-muted-foreground">
                Accepted: since resolved. Rejected: marked won't fix. A model's name opens its findings in the issues list.
            </p>
        </section>
    );
}
