// Pull requests: what's open on GitHub, the state of each in words (waiting for checks, reviewed and how
// many commits since, skipped and why), and why the last check did or didn't queue it, with Review now
// and Check now, plus the webhook deliveries received.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { FieldError } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, paths } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { keys, pullRequestsQuery, runListQuery } from "@/lib/queries";
import { safeHref } from "@/lib/safe-href";
import { useCan, useProject } from "@/lib/session";
import type { GithubDelivery, PullRequests, RefusedDeliveries } from "@/lib/types";
import { NewReviewButton } from "./new-review-button";
import { NextReviewModels, RunStatusBadge } from "./run-bits";
import { WaitingBanner } from "./runs-page";
import { StartReview } from "./start-review";

/** How many deliveries were refused for their signature: counted rather than listed, as anyone can send them. */
export function Refused({ refused }: { refused: RefusedDeliveries | null }) {
    if (!refused) return null;
    return (
        <p className="text-sm text-muted-foreground" data-testid="refused-deliveries">
            {refused.count === 1 ? "1 delivery was" : `${refused.count.toLocaleString("en-GB")} deliveries were`} refused since the server
            started, the last{" "}
            <time dateTime={refused.lastAt} title={formatDateTime(refused.lastAt)}>
                {timeAgo(refused.lastAt)}
            </time>
            : {refused.lastReason}
        </p>
    );
}

export function Deliveries({ items }: { items: GithubDelivery[] }) {
    if (!items.length) return <p className="text-sm text-muted-foreground">None received yet.</p>;
    return (
        <TableFrame>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead scope="col">Received</TableHead>
                        <TableHead scope="col" className="hidden sm:table-cell">
                            Event
                        </TableHead>
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
                            <TableCell className="hidden font-mono text-xs sm:table-cell">
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
        </TableFrame>
    );
}

const FIRST_REVIEW: Record<PullRequests["automation"]["firstReview"], string> = {
    checks: "a pull request is reviewed once, when it's ready and its checks have passed",
    ready: "a pull request is reviewed once, as soon as it's ready",
    manual: "pull requests are only reviewed when someone asks",
};

function Automation({ data, ws, slug }: { data: PullRequests; ws: string; slug: string }) {
    const every = `every ${data.automation.pollMinutes} minute${data.automation.pollMinutes === 1 ? "" : "s"}`;
    return (
        <div className="grid gap-1 text-sm">
            <p>
                {data.automation.enabled
                    ? `Automatic reviews are on: ${FIRST_REVIEW[data.automation.firstReview]} (checked on webhook events, or ${every}).`
                    : "Automatic reviews are off: pull requests are only reviewed when someone uses Review now."}{" "}
                <Link to="/w/$ws/p/$project/settings/automation" params={{ ws, project: slug }} className="link">
                    Automation settings
                </Link>
            </p>
            {data.automation.enabled && (
                <p className="text-muted-foreground">
                    Later pushes aren't reviewed until someone asks: comment <code className="font-mono">/review</code> on the pull request,
                    add the label <code className="font-mono">review</code>, or use Review now.
                </p>
            )}
            {data.automation.enabled && data.automation.firstReview === "checks" && data.checksReadable === false && (
                <p data-testid="checks-unreadable">
                    GitHub won't show Triagent this repository's check runs, so pull requests are reviewed when ready instead.{" "}
                    <Link to="/w/$ws/p/$project/settings/github" params={{ ws, project: slug }} className="link">
                        GitHub settings
                    </Link>{" "}
                    say what's needed.
                </p>
            )}
            {data.scheduledScan?.action === "skipped" && (
                <p className="text-muted-foreground" data-testid="scheduled-scan">
                    The scheduled scan{" "}
                    <time dateTime={data.scheduledScan.at} title={formatDateTime(data.scheduledScan.at)}>
                        {timeAgo(data.scheduledScan.at)}
                    </time>{" "}
                    was skipped: {data.scheduledScan.why}.
                </p>
            )}
        </div>
    );
}

/** A pull request's state, with the first letter capitalised: "Waiting for checks (2 of 4)". */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
            // A check can find out that GitHub won't show its check runs, which the GitHub settings explain.
            void queryClient.invalidateQueries({ queryKey: keys.projectSettings(ws, slug, "github") });
            if (data.lastCheck?.error) toast.error("GitHub couldn't be reached.");
            else toast.success("Checked GitHub.");
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
                            <NewReviewButton />
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
                    <NextReviewModels ws={ws} slug={slug} automatic={data.automation.enabled} />
                    {data.lastCheck && (
                        <p className="text-xs text-muted-foreground" data-testid="last-check">
                            Last checked{" "}
                            <time dateTime={data.lastCheck.at} title={formatDateTime(data.lastCheck.at)}>
                                {timeAgo(data.lastCheck.at)}
                            </time>
                            {data.lastCheck.error ? `: it failed (${data.lastCheck.error})` : `: ${data.lastCheck.openPulls ?? 0} open.`}
                            {data.lastCheck.note ? ` ${data.lastCheck.note}` : ""}
                        </p>
                    )}
                    {data.items.length === 0 ? (
                        <EmptyState title="No open pull requests">
                            {data.lastCheck
                                ? "None were open at the last check."
                                : "GitHub hasn't been checked yet. Check now to list them."}
                        </EmptyState>
                    ) : (
                        <TableFrame>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead scope="col">Pull request</TableHead>
                                        {/* On a phone the branch moves under the title, and the last check gives way. */}
                                        <TableHead scope="col" className="hidden sm:table-cell">
                                            Branch
                                        </TableHead>
                                        <TableHead scope="col">Review</TableHead>
                                        <TableHead scope="col" className="hidden md:table-cell">
                                            Last check
                                        </TableHead>
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
                                                    <span className="block font-mono text-xs break-all text-muted-foreground sm:hidden">
                                                        {p.branch}
                                                    </span>
                                                    <span className="block text-xs text-muted-foreground">
                                                        {p.author ? `by ${p.author}` : ""}
                                                        {p.draft ? " · draft" : ""}
                                                        {url && (
                                                            <>
                                                                {" · "}
                                                                <a href={url} target="_blank" rel="noopener noreferrer" className="link">
                                                                    GitHub<span className="sr-only"> (opens in a new tab)</span>
                                                                </a>
                                                            </>
                                                        )}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="hidden sm:table-cell">
                                                    <span className="font-mono text-xs">{p.branch}</span>
                                                    <span className="block font-mono text-xs text-muted-foreground">
                                                        {p.headSha.slice(0, 7)}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-xs whitespace-normal">
                                                    {p.run ? (
                                                        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                                                            <RunStatusBadge status={p.run.status} />
                                                            <Link
                                                                to="/w/$ws/p/$project/runs/$runId"
                                                                params={{ ws, project: slug, runId: p.run.id }}
                                                                className="link"
                                                            >
                                                                View the run<span className="sr-only"> of #{p.number}</span>
                                                            </Link>
                                                        </span>
                                                    ) : p.reviewed ? (
                                                        <Link
                                                            to="/w/$ws/p/$project/issues"
                                                            params={{ ws, project: slug }}
                                                            search={{ branch: p.branch }}
                                                            className="link"
                                                        >
                                                            Reviewed
                                                        </Link>
                                                    ) : p.status === "waiting for approval" ? (
                                                        <span className="font-medium">Waiting for approval</span>
                                                    ) : p.reviewedSha ? (
                                                        // Reviewed at an earlier commit: its findings are still the branch's.
                                                        <Link
                                                            to="/w/$ws/p/$project/issues"
                                                            params={{ ws, project: slug }}
                                                            search={{ branch: p.branch }}
                                                            className="link"
                                                        >
                                                            {sentence(p.status)}
                                                        </Link>
                                                    ) : (
                                                        <span>{sentence(p.status)}</span>
                                                    )}
                                                </TableCell>
                                                <TableCell className="hidden max-w-md text-xs whitespace-normal md:table-cell">
                                                    {!p.lastDecision
                                                        ? ""
                                                        : p.lastDecision.action === "waiting"
                                                          ? `${sentence(p.lastDecision.why)}.`
                                                          : `${p.lastDecision.action === "queued" ? "Queued" : "Not queued"}: ${p.lastDecision.why}.`}
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
                        </TableFrame>
                    )}
                    <section aria-labelledby="deliveries-heading" className="grid gap-2">
                        <h2 id="deliveries-heading" className="section-title">
                            Webhook deliveries
                        </h2>
                        <p className="text-sm text-muted-foreground">What GitHub sent lately, and what Triagent did with it.</p>
                        <Refused refused={data.refused} />
                        <Deliveries items={data.deliveries} />
                    </section>
                </>
            ) : null}
        </Page>
    );
}
