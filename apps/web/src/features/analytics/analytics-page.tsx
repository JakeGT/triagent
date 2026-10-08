// Insights → Analytics: reviews, findings, triage and model performance for every project or one, one
// branch or all, over a range. The scope lives in the URL (?project=&branch=&days=), so it can be shared.

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Field, FieldRow, NativeSelect } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Page, PageHeader, PageMeta } from "@/components/page";
import { analyticsQuery } from "@/lib/insights-queries";
import type { Days } from "@/lib/insights-types";
import { branchesQuery, projectsQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import { type AnalyticsSearch, RANGES } from "./search";
import { FindingsSection, PerformanceSection, ReviewsSection, TriageSection } from "./sections";

const SECTIONS = [
    ["reviews", "Reviews"],
    ["findings", "Findings and backlog"],
    ["triage", "Triage"],
    ["performance", "Model and OCR performance"],
] as const;

export function AnalyticsPage() {
    const { ws, workspace } = useWorkspace();
    const search = useSearch({ strict: false }) as AnalyticsSearch;
    const navigate = useNavigate();
    const days = search.days ?? 30;
    const projects = useQuery(projectsQuery(ws));
    const branches = useQuery({ ...branchesQuery(ws, search.project ?? ""), enabled: Boolean(search.project) });
    const query = useQuery(analyticsQuery(ws, { project: search.project, branch: search.branch, days }));

    const set = (next: AnalyticsSearch) =>
        navigate({ to: "/w/$ws/analytics", params: { ws }, search: { ...search, ...next } as never, replace: true });

    const projectName = projects.data?.find((p) => p.slug === search.project)?.name;
    const scope = `${search.project ? (projectName ?? search.project) : "every project"}, ${search.branch ? `branch ${search.branch}` : "all branches"}`;

    return (
        <Page>
            <PageMeta title="Analytics" />
            <PageHeader title="Analytics" description={`Reviews, findings and triage in ${workspace.name}: ${scope}.`} />

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

            <nav aria-label="Sections" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {SECTIONS.map(([id, label]) => (
                    <a key={id} href={`#${id}`} className="underline-offset-2 hover:underline">
                        {label}
                    </a>
                ))}
            </nav>

            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} title="Couldn't load analytics" />
            ) : !query.data ? (
                <LoadingRows rows={10} />
            ) : (
                <div className="grid gap-10" aria-busy={query.isFetching && query.isPlaceholderData ? "true" : undefined}>
                    {(query.data.truncated.history || query.data.truncated.activity) && (
                        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                            There's a lot of history here, so only the most recent rows were read. Pick a shorter range or one project for
                            exact figures.
                        </p>
                    )}
                    <ReviewsSection a={query.data} />
                    <FindingsSection a={query.data} />
                    <TriageSection a={query.data} />
                    <PerformanceSection a={query.data} />
                </div>
            )}
        </Page>
    );
}
