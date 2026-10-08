// Pull requests: what's open on GitHub, whether each head commit has been reviewed, and why the last
// check did or didn't queue it, with Review now and Check now, plus the webhook deliveries received.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { FieldError } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, paths } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { keys, pullRequestsQuery, runListQuery } from "@/lib/queries";
import { safeHref } from "@/lib/safe-href";
import { useCan, useProject } from "@/lib/session";
import type { GithubDelivery, PullRequests } from "@/lib/types";
import { RunStatusBadge } from "./run-bits";
import { WaitingBanner } from "./runs-page";
import { StartReview } from "./start-review";

export function Deliveries({ items }: { items: GithubDelivery[] }) {
    if (!items.length) return <p className="text-sm text-muted-foreground">None received yet.</p>;
    return (
        <div className="rounded-md border">
            <Table>
                <TableHeader className="bg-muted/50 text-xs">
                    <TableRow>
                        <TableHead scope="col">Received</TableHead>
                        <TableHead scope="col">Event</TableHead>
                        <TableHead scope="col">Outcome</TableHead>
                        <TableHead scope="col">What happened</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {items.map((d, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: deliveries have no id of their own, and the list is replaced whole
                        <TableRow key={`${d.at}-${i}`}>
                            <TableCell className="text-xs">
                                <time dateTime={d.at} title={formatDateTime(d.at)}>
                                    {timeAgo(d.at)}
                                </time>
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                                {d.event ?? "?"}
                                {d.what ? ` (${d.what})` : ""}
                            </TableCell>
                            <TableCell>
                                <Badge
                                    variant={d.outcome === "refused" ? "destructive" : d.outcome === "ignored" ? "outline" : "secondary"}
                                >
                                    {d.outcome}
                                </Badge>
                            </TableCell>
                            <TableCell className="max-w-lg text-xs whitespace-normal">{d.detail}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

function Automation({ data, ws, slug }: { data: PullRequests; ws: string; slug: string }) {
    return (
        <p className="text-sm">
            {data.automation.enabled
                ? `Automatic reviews are on: new commits on open pull requests are reviewed (checked on webhook events, or every ${data.automation.pollMinutes} minute${data.automation.pollMinutes === 1 ? "" : "s"}).`
                : "Automatic reviews are off: pull requests are only reviewed when someone asks."}{" "}
            <Link to="/w/$ws/p/$project/settings/automation" params={{ ws, project: slug }} className="underline">
                Automation settings
            </Link>
        </p>
    );
}

export function PullRequestsPage() {
    const { ws, slug, project } = useProject();
    const can = useCan();
    const queryClient = useQueryClient();
    const prs = useQuery(pullRequestsQuery(ws, slug));
    const runs = useQuery(runListQuery(ws, slug));
    const check = useMutation({
        mutationFn: () => api.post<PullRequests>(`${paths.project(ws, slug)}/pull-requests/check`),
        onSuccess: (data) => {
            queryClient.setQueryData(keys.pullRequests(ws, slug), data);
            void queryClient.invalidateQueries({ queryKey: keys.runs(ws) });
            toast.success(data.lastCheck?.error ? "GitHub couldn't be reached." : "Checked GitHub.");
        },
    });
    const data = prs.data;

    return (
        <Page>
            <PageMeta title={`Pull requests · ${project.name}`} />
            <PageHeader
                title="Pull requests"
                description={data?.repository ? `Open pull requests on ${data.repository}.` : "Open pull requests on GitHub."}
                actions={
                    data?.connected && (
                        <>
                            {can("operate") && (
                                <Button variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
                                    <RefreshCw /> {check.isPending ? "Checking…" : "Check now"}
                                </Button>
                            )}
                            <StartReview />
                        </>
                    )
                }
            />
            <FieldError message={check.error ? errorMessage(check.error) : null} />
            {prs.isPending ? (
                <LoadingRows rows={5} />
            ) : prs.isError ? (
                <LoadError error={prs.error} onRetry={() => prs.refetch()} title="Couldn't load the pull requests" />
            ) : data && !data.connected ? (
                <EmptyState
                    title="Not connected to GitHub"
                    action={
                        can("configure") ? (
                            <Button asChild variant="outline">
                                <Link to="/w/$ws/p/$project/settings/github" params={{ ws, project: slug }}>
                                    Connect GitHub
                                </Link>
                            </Button>
                        ) : undefined
                    }
                >
                    Connect this project to its repository (through the GitHub App, or a token) to see its pull requests here.
                </EmptyState>
            ) : data ? (
                <>
                    {runs.data && <WaitingBanner list={runs.data} ws={ws} />}
                    <Automation data={data} ws={ws} slug={slug} />
                    {data.lastCheck && (
                        <p className="text-xs text-muted-foreground" data-testid="last-check">
                            Last checked{" "}
                            <time dateTime={data.lastCheck.at} title={formatDateTime(data.lastCheck.at)}>
                                {timeAgo(data.lastCheck.at)}
                            </time>
                            {data.lastCheck.error ? `: it failed (${data.lastCheck.error})` : `: ${data.lastCheck.openPulls ?? 0} open.`}
                        </p>
                    )}
                    {data.items.length === 0 ? (
                        <EmptyState title="No open pull requests">
                            {data.lastCheck
                                ? "None were open at the last check."
                                : "GitHub hasn't been checked yet. Check now to list them."}
                        </EmptyState>
                    ) : (
                        <div className="rounded-md border">
                            <Table>
                                <TableHeader className="bg-muted/50 text-xs">
                                    <TableRow>
                                        <TableHead scope="col">Pull request</TableHead>
                                        <TableHead scope="col">Branch</TableHead>
                                        <TableHead scope="col">Review</TableHead>
                                        <TableHead scope="col">Last check</TableHead>
                                        <TableHead scope="col">
                                            <span className="sr-only">Actions</span>
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {data.items.map((p) => {
                                        const url = safeHref(p.url);
                                        return (
                                            <TableRow key={p.number} data-testid={`pr-${p.number}`}>
                                                <TableCell className="max-w-sm whitespace-normal">
                                                    <span className="font-medium">
                                                        #{p.number} {p.title}
                                                    </span>
                                                    <span className="block text-xs text-muted-foreground">
                                                        {p.author ? `by ${p.author}` : ""}
                                                        {p.draft ? " · draft" : ""}
                                                        {url && (
                                                            <>
                                                                {" · "}
                                                                <a
                                                                    href={url}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="underline"
                                                                >
                                                                    GitHub<span className="sr-only"> (opens in a new tab)</span>
                                                                </a>
                                                            </>
                                                        )}
                                                    </span>
                                                </TableCell>
                                                <TableCell>
                                                    <span className="font-mono text-xs">{p.branch}</span>
                                                    <span className="block font-mono text-xs text-muted-foreground">
                                                        {p.headSha.slice(0, 7)}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-xs">
                                                    {p.run ? (
                                                        <Link
                                                            to="/w/$ws/p/$project/runs/$runId"
                                                            params={{ ws, project: slug, runId: p.run.id }}
                                                            className="inline-flex items-center gap-1 hover:underline"
                                                        >
                                                            <RunStatusBadge status={p.run.status} />
                                                            <span className="sr-only">View the run</span>
                                                        </Link>
                                                    ) : p.reviewed ? (
                                                        <Link
                                                            to="/w/$ws/p/$project/issues"
                                                            params={{ ws, project: slug }}
                                                            search={{ branch: p.branch }}
                                                            className="underline"
                                                        >
                                                            Reviewed
                                                        </Link>
                                                    ) : (
                                                        <span>{p.status}</span>
                                                    )}
                                                </TableCell>
                                                <TableCell className="max-w-md text-xs whitespace-normal">
                                                    {p.lastDecision
                                                        ? `${p.lastDecision.action === "queued" ? "Queued" : "Not queued"}: ${p.lastDecision.why}.`
                                                        : ""}
                                                </TableCell>
                                                <TableCell className="text-end">
                                                    {!p.run && (
                                                        <StartReview
                                                            defaults={{ kind: "pr", number: p.number }}
                                                            trigger={
                                                                <Button variant="outline" size="sm">
                                                                    {p.reviewed ? "Review again" : "Review now"}
                                                                    <span className="sr-only"> #{p.number}</span>
                                                                </Button>
                                                            }
                                                        />
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                    <section aria-labelledby="deliveries-heading" className="grid gap-2">
                        <h2 id="deliveries-heading" className="font-semibold">
                            Webhook deliveries
                        </h2>
                        <p className="text-sm text-muted-foreground">What GitHub sent lately, and what Triagent did with it.</p>
                        <Deliveries items={data.deliveries} />
                    </section>
                </>
            ) : null}
        </Page>
    );
}
