// Who's signed in, which workspace and project the page is about, and what the person may do there.
// Permissions come from the shared table (packages/shared/src/permissions.ts), so the app hides exactly
// what the server would refuse.

import { useSuspenseQuery } from "@tanstack/react-query";
import { notFound, useParams } from "@tanstack/react-router";
import { type Permission, permissionsOf, type Role } from "@triagent/shared";
import { createContext, use } from "react";
import { meQuery } from "./queries";
import type { Me, Project, WorkspaceSummary } from "./types";

export function useMe(): Me {
    return useSuspenseQuery(meQuery).data;
}

export interface WorkspaceAccess {
    ws: string;
    workspace: WorkspaceSummary;
    role: Role;
    can(permission: Permission): boolean;
}

export function accessFor(me: Me, ws: string): WorkspaceAccess | null {
    const workspace = me.workspaces.find((w) => w.slug === ws);
    if (!workspace) return null;
    const role = workspace.role ?? "viewer";
    const granted = permissionsOf({ kind: "role", role });
    return { ws, workspace, role, can: (p) => granted.has(p) };
}

/** The workspace in the URL and your role in it. Only inside /w/:ws. */
export function useWorkspace(): WorkspaceAccess {
    const me = useMe();
    const { ws } = useParams({ strict: false }) as { ws?: string };
    const access = ws ? accessFor(me, ws) : null;
    // Not (or no longer) a member, e.g. removed while the page was open: the same answer as a missing workspace.
    if (!access) throw notFound();
    return access;
}

/** Shorthand: may the signed-in person do this in the current workspace? */
export function useCan(): (permission: Permission) => boolean {
    return useWorkspace().can;
}

export interface ProjectContextValue {
    ws: string;
    slug: string;
    project: Project;
    /** The branch the page shows: ?branch=, or the project's default branch. */
    branch: string;
    /** The ?branch= value to keep in links (undefined on the default branch). */
    branchParam: string | undefined;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

/** The project in the URL and the branch the page is about. Only inside /w/:ws/p/:project. */
export function useProject(): ProjectContextValue {
    const ctx = use(ProjectContext);
    if (!ctx) throw new Error("useProject must be used inside a project page");
    return ctx;
}
