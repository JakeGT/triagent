// The one table of who may do what. Every API route and MCP tool names the permission it needs, and the
// web app uses the same table to decide what to show. Roles belong to a person in one workspace; scopes
// belong to an API token, which always belongs to exactly one workspace.

export const PERMISSIONS = [
    "read",
    "triage",
    "upload",
    "operate",
    "configure",
    "moderate",
    "secrets",
    "members",
    "tokens",
    "workspace",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_INFO: Readonly<Record<Permission, string>> = {
    read: "See projects, reports, issues, tasks and activity",
    triage: "Change issue and task status, assignee, ratings and notes; add findings",
    upload: "Upload reports and create upload links",
    operate: "Start and cancel reviews",
    configure: "Create, rename and delete projects; change project and automation settings",
    moderate: "Delete other people's notes",
    secrets: "Set or clear secrets (GitHub credentials, webhook secrets, model keys)",
    members: "Add and remove members and change their roles",
    tokens: "Create and revoke API tokens",
    workspace: "Rename the workspace and transfer ownership",
};

export const ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const TOKEN_SCOPES = ["read", "write", "upload", "full", "manage"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

const ADMIN: readonly Permission[] = ["read", "triage", "upload", "operate", "configure", "moderate", "secrets", "members", "tokens"];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
    viewer: ["read"],
    editor: ["read", "triage"],
    admin: ADMIN,
    owner: [...ADMIN, "workspace"],
};

export const SCOPE_PERMISSIONS: Readonly<Record<TokenScope, readonly Permission[]>> = {
    read: ["read"],
    write: ["read", "triage"],
    upload: ["read", "upload"],
    full: ["read", "triage", "upload"],
    manage: ["read", "triage", "upload", "operate", "configure"],
};

export const SCOPE_INFO: Readonly<Record<TokenScope, string>> = {
    read: "Read only",
    write: "Read and triage",
    upload: "Read and upload reports (CI)",
    full: "Read, triage and upload (agent sessions)",
    manage: "Also run reviews and configure projects",
};

/**
 * Never granted to an API token, whatever its scope. A leaked token can't give itself more access,
 * and secrets never pass through an agent's conversation.
 */
export const BROWSER_ONLY: ReadonlySet<Permission> = new Set(["secrets", "members", "tokens", "workspace"]);

export type Grant = { kind: "role"; role: Role } | { kind: "scope"; scope: TokenScope };

export function permissionsOf(grant: Grant): ReadonlySet<Permission> {
    return new Set(grant.kind === "role" ? ROLE_PERMISSIONS[grant.role] : SCOPE_PERMISSIONS[grant.scope]);
}

export function can(grant: Grant, permission: Permission): boolean {
    return permissionsOf(grant).has(permission);
}

/** Roles in increasing order of access, for "at least" comparisons. */
export function roleRank(role: Role): number {
    return ROLES.indexOf(role);
}
