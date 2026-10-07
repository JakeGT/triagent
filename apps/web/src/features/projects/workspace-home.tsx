import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import { LoadError, LoadingRows } from "@/components/load-state";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Button } from "@/components/ui/button";
import { PREF, prefs } from "@/lib/prefs";
import { projectsQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";

/** /w/:ws opens the last project used here, or invites you to create the first one. */
export function WorkspaceHome() {
    const { ws, workspace, can } = useWorkspace();
    const projects = useQuery(projectsQuery(ws));
    if (projects.isPending) return <LoadingRows className="p-6" />;
    if (projects.isError) return <LoadError error={projects.error} onRetry={() => projects.refetch()} className="m-6" />;
    const list = projects.data;
    const last = prefs.get(PREF.lastProject(ws));
    const target = list.find((p) => p.slug === last) ?? list[0];
    if (target) return <Navigate to="/w/$ws/p/$project/overview" params={{ ws, project: target.slug }} replace />;
    return (
        <Page>
            <PageMeta title={workspace.name} />
            <PageHeader title={workspace.name} description="A workspace holds projects: one per codebase." />
            <EmptyState
                title="No projects yet"
                action={
                    can("configure") ? (
                        <Button asChild>
                            <Link to="/w/$ws/settings/projects" params={{ ws }}>
                                Create a project
                            </Link>
                        </Button>
                    ) : undefined
                }
            >
                {can("configure")
                    ? "Create a project for a repository, then upload an Open Code Review report to start triaging."
                    : "An admin of this workspace needs to create a project first."}
            </EmptyState>
        </Page>
    );
}
