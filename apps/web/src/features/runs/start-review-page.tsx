// Start a review: a page for that alone, reached from the rail's New review button (or a link with the
// choice made, ?kind=pr&number=12). It says what the review will run with and whether it can start now,
// then asks what to review.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";
import { Page, PageHeader, PageMeta } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { api, paths } from "@/lib/api";
import { automationQuery, keys, pullRequestsQuery, reviewModelQuery, runListQuery } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import type { PullRequests } from "@/lib/types";
import { WaitingBanner } from "./runs-page";
import { StartReviewForm } from "./start-review";

/** Which models the project's reviews run with, in words. */
function ModelsLine({ ws, slug }: { ws: string; slug: string }) {
    const can = useCan();
    const automation = useQuery(automationQuery(ws, slug));
    const review = useQuery(reviewModelQuery(ws));
    const listed = automation.data?.models ?? [];
    const own = review.data?.providers.find((p) => p.id === review.data?.provider);
    const text =
        listed.length > 1
            ? `Each of ${listed.map((m) => m.model).join(", ")} reviews it in turn, and their findings are merged.`
            : listed.length === 1
              ? `It runs with ${listed[0]?.model}.`
              : review.data?.model
                ? `It runs with the workspace's model, ${review.data.model}${own ? ` via ${own.name}` : ""}.`
                : null;
    if (!text) return null;
    return (
        <p className="text-sm text-muted-foreground" data-testid="review-models">
            {text}{" "}
            {can("configure") && (
                <Link to="/w/$ws/p/$project/settings/automation" params={{ ws, project: slug }} className="underline">
                    Change the models
                </Link>
            )}
        </p>
    );
}

export function StartReviewPage() {
    const { ws, slug, project } = useProject();
    const can = useCan();
    const search = useSearch({ from: "/authed/w/$ws/p/$project/start-review" });
    const runs = useQuery(runListQuery(ws, slug));
    const prs = useQuery({ ...pullRequestsQuery(ws, slug), enabled: can("operate") });
    const notConnected = prs.data && !prs.data.connected;

    // The open pull requests to pick from are as of the last check with GitHub: check again if that was
    // over a minute ago (as polling would; it queues reviews only if automatic reviews are on).
    const queryClient = useQueryClient();
    const check = useMutation({
        mutationFn: () => api.post<PullRequests>(`${paths.project(ws, slug)}/pull-requests/check`),
        onSuccess: (data) => queryClient.setQueryData(keys.pullRequests(ws, slug), data),
    });
    const checked = useRef(false);
    const lastCheck = prs.data?.lastCheck?.at;
    const stale = prs.data?.connected && (!lastCheck || Date.now() - Date.parse(lastCheck) > 60_000);
    useEffect(() => {
        if (!stale || checked.current) return;
        checked.current = true;
        check.mutate();
    }, [stale, check]);

    return (
        <Page className="max-w-3xl">
            <PageMeta title={`Start a review · ${project.name}`} />
            <PageHeader
                title="Start a review"
                description={
                    <>
                        Open Code Review runs on {project.name}'s code from GitHub, and its findings go to the branch's report here.{" "}
                        <Link to="/w/$ws/p/$project/runs" params={{ ws, project: slug }} className="underline">
                            See all runs
                        </Link>
                    </>
                }
            />
            {!can("operate") ? (
                <Alert>
                    <AlertTriangle />
                    <AlertTitle>Only this workspace's admins can start reviews</AlertTitle>
                    <AlertDescription>Ask one of them, or for a role that can.</AlertDescription>
                </Alert>
            ) : (
                <>
                    {runs.data && <WaitingBanner list={runs.data} ws={ws} />}
                    {notConnected && (
                        <Alert>
                            <AlertTriangle />
                            <AlertTitle>{project.name} isn't connected to GitHub yet</AlertTitle>
                            <AlertDescription>
                                <p>Reviews fetch the code from GitHub, so they can't start until it is.</p>
                                {can("configure") && (
                                    <Link to="/w/$ws/p/$project/settings/github" params={{ ws, project: slug }} className="underline">
                                        Connect it in the project's GitHub settings
                                    </Link>
                                )}
                            </AlertDescription>
                        </Alert>
                    )}
                    <section aria-label="What to review" className="grid gap-form rounded-lg border bg-card p-inset">
                        <ModelsLine ws={ws} slug={slug} />
                        <StartReviewForm defaults={search} />
                    </section>
                </>
            )}
        </Page>
    );
}
