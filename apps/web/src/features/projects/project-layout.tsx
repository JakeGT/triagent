import { useQuery } from "@tanstack/react-query";
import { Outlet, useParams, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import { LoadError, LoadingRows } from "@/components/load-state";
import { isApiError } from "@/lib/api";
import { projectQuery } from "@/lib/queries";
import { ProjectContext, type ProjectContextValue } from "@/lib/session";

/** Loads the project in the URL and tells its pages which branch they're showing. */
export function ProjectLayout() {
    const { ws, project: slug } = useParams({ from: "/authed/w/$ws/p/$project" });
    const { branch: branchParam } = useSearch({ from: "/authed/w/$ws/p/$project" });
    const project = useQuery(projectQuery(ws, slug));
    const value = useMemo<ProjectContextValue | null>(
        () =>
            project.data
                ? {
                      ws,
                      slug,
                      project: project.data,
                      branch: branchParam ?? project.data.defaultBranch,
                      branchParam: branchParam && branchParam !== project.data.defaultBranch ? branchParam : undefined,
                  }
                : null,
        [ws, slug, project.data, branchParam],
    );

    if (project.isPending) return <LoadingRows className="p-6" />;
    if (project.isError)
        return (
            <LoadError
                className="m-6"
                title={isApiError(project.error, 404) ? "No such project" : "Couldn't load the project"}
                error={project.error}
                onRetry={isApiError(project.error, 404) ? undefined : () => project.refetch()}
            />
        );
    return (
        <ProjectContext value={value}>
            <Outlet />
        </ProjectContext>
    );
}
