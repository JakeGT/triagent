// Insights → Analytics: reviews and what they cost, each model side by side, findings and triage, for
// every project or one, one branch or all, over a range. Six tabs, each its own address
// (/analytics/models), so a tab only asks the server for what it shows. The scope lives in the URL
// (?project=&branch=&days=) and is kept from tab to tab, so any view can be shared.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Field, FieldRow, NativeSelect } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Page, PageHeader, PageMeta } from "@/components/page";
import { analyticsQuery } from "@/lib/insights-queries";
import type { AnalyticsSection, Days } from "@/lib/insights-types";
import { branchesQuery, projectsQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import { cn } from "@/lib/utils";
import { InsightsTab } from "./insights-tab";
import { ModelsTab } from "./models-tab";
import { OverviewTab } from "./overview-tab";
import { ANALYTICS_TABS, type AnalyticsSearch, type AnalyticsTab, analyticsTab, RANGES } from "./search";
import { FindingsSection, PerformanceSection, ReviewsSection, TriageSection } from "./sections";

/** What each tab asks the server for. */
const SECTIONS: Record<AnalyticsTab, AnalyticsSection[]> = {
    overview: ["reviews", "findings", "triage"],
    reviews: ["reviews", "performance"],
    models: ["models"],
    findings: ["findings"],
    triage: ["triage"],
    // Nothing: what's there is written from the figures, on the server.
    insights: [],
};

export function AnalyticsPage() {
    const { ws, workspace } = useWorkspace();
    const search = useSearch({ strict: false }) as AnalyticsSearch;
    const navigate = useNavigate();
    const tab = analyticsTab((useParams({ strict: false }) as { tab?: string }).tab);
    const days = search.days ?? 30;
    const projects = useQuery(projectsQuery(ws));
    const branches = useQuery({ ...branchesQuery(ws, search.project ?? ""), enabled: Boolean(search.project) });
    const query = useQuery({
        ...analyticsQuery(ws, { project: search.project, branch: search.branch, days, sections: SECTIONS[tab] }),
        enabled: SECTIONS[tab].length > 0,
    });

    const set = (next: AnalyticsSearch) =>
        navigate({ to: "/w/$ws/analytics/$tab", params: { ws, tab }, search: { ...search, ...next } as never, replace: true });

    const projectName = projects.data?.find((p) => p.slug === search.project)?.name;
    const scope = `${search.project ? (projectName ?? search.project) : "every project"}, ${search.branch ? `branch ${search.branch}` : "all branches"}`;

    return (
        <Page>
            <PageMeta title="Analytics" />
            <PageHeader title="Analytics" description={`Reviews, models, findings and triage in ${workspace.name}: ${scope}.`} />

            <form className="grid" aria-label="What to show" onSubmit={(e) => e.preventDefault()} data-tour="analytics-filters">
                <FieldRow columns="auto">
                    <Field label="Project" width="md">
                        {(p) => (
                            <NativeSelect
                                {...p}
                                value={search.project ?? ""}
                                onChange={(e) => set({ project: e.target.value || undefined, branch: undefined })}
                            >
                                <option value="">All projects</option>
                                {(projects.data ?? []).map((p) => (
                                    <option key={p.slug} value={p.slug}>
                                        {p.name}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                    <Field label="Branch" width="md">
                        {(p) => (
                            <NativeSelect
                                {...p}
                                value={search.branch ?? ""}
                                disabled={!search.project}
                                title={search.project ? undefined : "Choose a project to pick one of its branches"}
                                onChange={(e) => set({ branch: e.target.value || undefined })}
                            >
                                <option value="">All branches</option>
                                {(branches.data?.items ?? []).map((b) => (
                                    <option key={b.name} value={b.name}>
                                        {b.name}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                    <Field label="Range" width="sm">
                        {(p) => (
                            <NativeSelect {...p} value={String(days)} onChange={(e) => set({ days: Number(e.target.value) as Days })}>
                                {RANGES.map((r) => (
                                    <option key={r.days} value={r.days}>
                                        {r.label}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                </FieldRow>
            </form>

            {/* Links, not buttons: each tab is a page of its own, and the browser's back button goes between them. */}
            <nav aria-label="Analytics" className="-mb-2 overflow-x-auto border-b" data-testid="analytics-tabs">
                <ul className="flex min-w-max gap-1">
                    {ANALYTICS_TABS.map((t) => (
                        <li key={t.id}>
                            <Link
                                to="/w/$ws/analytics/$tab"
                                params={{ ws, tab: t.id }}
                                search={search as never}
                                aria-current={t.id === tab ? "page" : undefined}
                                className={cn(
                                    "-mb-px block border-b-2 px-3 py-2 text-sm whitespace-nowrap",
                                    t.id === tab
                                        ? "border-primary font-medium text-foreground"
                                        : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                                )}
                            >
                                {t.label}
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>

            {tab === "insights" ? (
                <InsightsTab search={search} scope={scope} />
            ) : query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} title="Couldn't load analytics" />
            ) : !query.data ? (
                <LoadingRows rows={10} />
            ) : (
                <div className="grid gap-10" aria-busy={query.isFetching && query.isPlaceholderData ? "true" : undefined}>
                    {(query.data.truncated.history || query.data.truncated.activity || query.data.truncated.sources) && (
                        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                            There's a lot of history here, so only the most recent rows were read. Pick a shorter range or one project for
                            exact figures.
                        </p>
                    )}
                    {query.data.truncated.current && (
                        <p
                            className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
                            data-testid="truncated-current"
                        >
                            There are too many findings to count them all, so the figures for current findings cover only some branches.
                            Pick one project or branch for exact figures.
                        </p>
                    )}
                    {tab === "overview" && <OverviewTab a={query.data} search={search} />}
                    {tab === "reviews" && (
                        <>
                            <ReviewsSection a={query.data} />
                            <PerformanceSection a={query.data} />
                        </>
                    )}
                    {tab === "models" && <ModelsTab a={query.data} />}
                    {tab === "findings" && <FindingsSection a={query.data} />}
                    {tab === "triage" && <TriageSection a={query.data} />}
                </div>
            )}
        </Page>
    );
}
