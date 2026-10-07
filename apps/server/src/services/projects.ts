import { randomBytes } from "node:crypto";
import { isValidBranch, isValidSlug, normaliseRepoUrl } from "../domain/names.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { now, randomId } from "../security.ts";
import type { Project, Repos, Workspace } from "../store/types.ts";
import type { Actor, Core } from "./core.ts";

export function publicProject(p: Project) {
    return { id: p.id, slug: p.slug, name: p.name, repoUrl: p.repoUrl, defaultBranch: p.defaultBranch, createdAt: p.createdAt };
}

export class Projects {
    private readonly core: Core;

    constructor(core: Core) {
        this.core = core;
    }

    async get(repos: Repos, workspace: Workspace, slug: string): Promise<Project> {
        const p = isValidSlug(slug) ? await repos.projects.bySlug(workspace.id, slug) : null;
        if (!p) {
            const known = (await repos.projects.forWorkspace(workspace.id)).map((x) => x.slug);
            throw notFound(`No project "${slug.slice(0, 60)}" in this workspace. Projects: ${known.join(", ") || "none yet"}.`);
        }
        return p;
    }

    async list(workspace: Workspace) {
        const out = [];
        for (const p of await this.core.store.projects.forWorkspace(workspace.id)) {
            const reports = await this.core.store.reports.branches(p.id);
            out.push({
                ...publicProject(p),
                branches: reports.length,
                findings: reports.reduce((n, r) => n + r.report.comments.length, 0),
            });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    async create(
        actor: Actor,
        workspace: Workspace,
        input: { slug: string; name?: string; repoUrl?: string | null; defaultBranch?: string },
    ) {
        const slug = input.slug.trim().toLowerCase();
        const name = (input.name ?? "").trim() || slug;
        if (!isValidSlug(slug))
            throw badRequest("Project ids are lower-case letters, numbers and dashes (up to 40), starting with a letter or number.");
        if (name.length > 80) throw badRequest("Keep the name under 80 characters.");
        const defaultBranch = input.defaultBranch?.trim() || this.core.config.defaultBranch;
        if (!isValidBranch(defaultBranch)) throw badRequest(`"${defaultBranch.slice(0, 100)}" isn't a valid branch name.`);
        const repoUrl = input.repoUrl ? this.repoUrl(input.repoUrl) : null;
        return this.core.write(actor, async (w) => {
            if (await w.tx.projects.bySlug(workspace.id, slug)) throw conflict(`There's already a project "${slug}" in this workspace.`);
            const project: Project = {
                id: randomId(),
                workspaceId: workspace.id,
                slug,
                name,
                repoUrl,
                defaultBranch,
                webhookId: randomBytes(18).toString("base64url"),
                createdAt: now(),
            };
            await w.tx.projects.put(project);
            await w.activity(
                {
                    workspaceId: workspace.id,
                    projectId: project.id,
                    branch: null,
                    kind: "project",
                    itemId: slug,
                    changes: { created: { name } },
                },
                slug,
            );
            return publicProject(project);
        });
    }

    repoUrl(input: string): string {
        const url = normaliseRepoUrl(input);
        if (!url)
            throw badRequest(
                "Enter the repository's address, like https://github.com/<owner>/<repo> or git@github.com:<owner>/<repo>.git.",
            );
        return url;
    }

    async update(actor: Actor, project: Project, input: { name?: string; repoUrl?: string | null; defaultBranch?: string }) {
        const next: Project = { ...project };
        const changes: Record<string, unknown> = {};
        if (input.name !== undefined) {
            const name = input.name.trim();
            if (!name || name.length > 80) throw badRequest("Give the project a name (up to 80 characters).");
            next.name = name;
        }
        if (input.repoUrl !== undefined) next.repoUrl = input.repoUrl ? this.repoUrl(input.repoUrl) : null;
        if (input.defaultBranch !== undefined) {
            const b = input.defaultBranch.trim();
            if (!isValidBranch(b)) throw badRequest(`"${b.slice(0, 100)}" isn't a valid branch name.`);
            next.defaultBranch = b;
        }
        for (const k of ["name", "repoUrl", "defaultBranch"] as const)
            if (next[k] !== project[k]) changes[k] = { from: project[k], to: next[k] };
        if (!Object.keys(changes).length) return publicProject(project);
        return this.core.write(actor, async (w) => {
            await w.tx.projects.put(next);
            await w.audit({ workspaceId: project.workspaceId, kind: "settings", target: `project:${project.slug}`, changes });
            await w.activity(
                { workspaceId: project.workspaceId, projectId: project.id, branch: null, kind: "project", itemId: project.slug, changes },
                project.slug,
            );
            return publicProject(next);
        });
    }

    /** Deletes the project and everything stored for it. `confirm` must repeat the project's id. */
    async delete(actor: Actor, project: Project, confirm: unknown) {
        if (confirm !== project.slug)
            throw badRequest(`Deleting a project removes its reports, triage and settings. To confirm, send "confirm": "${project.slug}".`);
        return this.core.write(actor, async (w) => {
            await w.tx.projects.delete(project.id);
            await w.audit({
                workspaceId: project.workspaceId,
                kind: "project",
                target: project.slug,
                changes: { deleted: { name: project.name } },
            });
            await w.activity(
                {
                    workspaceId: project.workspaceId,
                    projectId: null,
                    branch: null,
                    kind: "project",
                    itemId: project.slug,
                    changes: { deleted: true },
                },
                project.slug,
            );
            return { deleted: true };
        });
    }
}
