// Reports and branches: each branch of a project has one current Open Code Review report, with its own
// triage. Uploading a new report compares it with the current one, carries triage over for findings it
// still contains, and reopens resolved findings it still reports.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CATEGORIES, type Category, permissionsOf, ROLE_PERMISSIONS, SEVERITIES, type Severity } from "@triagent/shared";
import { BranchView, compareBranches } from "../domain/branch.ts";
import { COMMIT, cleanText, isValidBranch } from "../domain/names.ts";
import { EMPTY_REVIEW, parseReport, type RawComment, type RawReport, type Review, sameFinding, type UploadMeta } from "../domain/report.ts";
import { reportMetrics } from "../domain/review-metrics.ts";
import { ApiError, badRequest, conflict, notFound } from "../errors.ts";
import { now, sha256 } from "../security.ts";
import type { Project, Repos, StoredReport, UploadLink } from "../store/types.ts";
import type { Actor, Core } from "./core.ts";
import type { History } from "./history.ts";
import { applyChange, type BranchRef } from "./triage.ts";

const KEEP_ARCHIVED = 10;
const LINK_TTL_MS = 15 * 60_000;
const MAX_LINKS = 1000;
/** New finding ids kept per review, for when each first appeared; a first full scan can have thousands. */
const MAX_ADDED_IDS = 5000;

export interface UploadInput {
    branch?: unknown;
    commit?: unknown;
    fileName?: unknown;
    report: unknown;
    confirm?: unknown;
    reopen?: unknown;
    scope?: unknown;
}

function checkBranch(value: unknown, fallback: string): string {
    const branch = typeof value === "string" && value.trim() ? value.trim() : fallback;
    if (!isValidBranch(branch)) throw badRequest(`"${branch.slice(0, 100)}" isn't a valid branch name.`);
    return branch;
}

function checkCommit(value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !COMMIT.test(value.trim()))
        throw badRequest("The commit must be a Git SHA (7–40 hex characters), or left out.");
    return value.trim();
}

/** Only ever a label, never a path, but kept plain anyway. */
function checkFileName(value: unknown): string {
    const name = cleanText(String(value ?? ""))
        .replace(/[\t\n\r/\\]/g, "")
        .trim()
        .slice(0, 200);
    return !name || /^\.+$/.test(name) ? "report.json" : name;
}

function line(value: unknown, field: string): number | null {
    if (value === undefined || value === null || value === "") return null;
    if (!(typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))))
        throw badRequest(`${field} must be a positive whole number.`);
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 10_000_000) throw badRequest(`${field} must be a positive whole number.`);
    return n;
}

function textField(value: unknown, max: number, field: string, required = false): string | null {
    if (value === undefined || value === null || value === "") {
        if (required) throw badRequest(`${field} is required.`);
        return null;
    }
    if (typeof value !== "string") throw badRequest(`${field} must be text.`);
    const v = cleanText(value);
    if (v.length > max) throw badRequest(`${field} must be at most ${max} characters.`);
    return v;
}

export class Reports {
    private readonly core: Core;
    private readonly reviews: History | null;
    /** Parsed reports by project, branch and version: parsing a large report is the slow part. */
    private readonly parsed = new Map<string, Review>();

    constructor(core: Core, history: History | null = null) {
        this.core = core;
        this.reviews = history;
    }

    private review(stored: StoredReport): Review {
        const key = `${stored.projectId}\0${stored.branch}\0${stored.version}`;
        let review = this.parsed.get(key);
        if (!review) {
            review = parseReport(stored.report, stored.upload);
            this.parsed.set(key, review);
            while (this.parsed.size > 64) this.parsed.delete(this.parsed.keys().next().value as string);
        }
        return review;
    }

    private async build(repos: Repos, project: Project, branch: string, stored: StoredReport | null): Promise<BranchView> {
        const records = stored ? await repos.triage.forBranch(project.id, branch) : [];
        return new BranchView(stored ? this.review(stored) : EMPTY_REVIEW, records, {
            project: { slug: project.slug, name: project.name, repoUrl: project.repoUrl },
            branch,
            commit: stored?.upload.commit ?? null,
        });
    }

    /**
     * A branch with its triage. The project's default branch exists even before its first report (it's
     * just empty); any other branch without a report is a 404.
     */
    async view(repos: Repos, project: Project, branch: string): Promise<BranchView> {
        const stored = await repos.reports.get(project.id, branch);
        if (!stored && branch !== project.defaultBranch) {
            const known = (await repos.reports.branches(project.id)).map((r) => r.branch);
            throw notFound(`No report for branch "${branch.slice(0, 100)}". Branches with reports: ${known.join(", ") || "none"}.`);
        }
        return this.build(repos, project, branch, stored);
    }

    /** A branch's view from a report already read (analytics reads every branch's). */
    viewStored(repos: Repos, project: Project, stored: StoredReport): Promise<BranchView> {
        return this.build(repos, project, stored.branch, stored);
    }

    branchOf(project: Project, value: unknown): string {
        return checkBranch(value, project.defaultBranch);
    }

    // ---- branches ------------------------------------------------------------------------

    async branches(project: Project) {
        const repos = this.core.store;
        const items = [];
        for (const stored of await repos.reports.branches(project.id)) {
            const view = await this.build(repos, project, stored.branch, stored);
            const st = view.counts(view.issues()).status;
            items.push({
                name: stored.branch,
                isDefault: stored.branch === project.defaultBranch,
                fileName: stored.upload.fileName,
                uploadedAt: stored.upload.uploadedAt,
                uploadedBy: stored.upload.uploadedBy,
                commit: stored.upload.commit,
                scope: stored.upload.scope,
                issues: view.issues().length,
                unresolved: st.open + st.in_progress,
                inProgress: st.in_progress,
                done: st.resolved + st.wont_fix,
            });
        }
        items.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.uploadedAt.localeCompare(a.uploadedAt));
        return { defaultBranch: project.defaultBranch, items };
    }

    async history(project: Project, branch: string) {
        const repos = this.core.store;
        const current = await repos.reports.get(project.id, branch);
        const archived = await repos.reports.archived(project.id, branch);
        return {
            branch,
            current: current ? this.review(current).meta : null,
            archived: archived.map((a) => ({
                upload: a.upload,
                archivedAt: a.archivedAt,
                reason: a.reason,
                findings: a.report.comments.length,
            })),
        };
    }

    async compare(project: Project, base: string, head: string) {
        if (base === head) throw badRequest("Pick two different branches to compare.");
        const repos = this.core.store;
        return compareBranches(await this.view(repos, project, base), await this.view(repos, project, head));
    }

    /** Move a branch's report, triage and archive to another name (e.g. one uploaded to the wrong branch). */
    async moveBranch(actor: Actor, project: Project, input: { from: unknown; to: unknown; makeDefault?: unknown }) {
        const from = checkBranch(input.from, "");
        const to = checkBranch(input.to, "");
        if (from === to) throw badRequest("Pick a different branch to move it to.");
        return this.core.write(actor, async (w) => {
            const stored = await w.tx.reports.get(project.id, from);
            if (!stored) throw notFound(`No report for branch "${from}".`);
            if (await w.tx.reports.get(project.id, to))
                throw conflict(`Branch "${to}" already has a report. Delete it first, or pick another branch.`);
            if ((await w.tx.triage.forBranch(project.id, to)).length)
                throw conflict(`Branch "${to}" still has triage from an earlier report. Delete that branch first.`);
            await w.tx.reports.put({ projectId: project.id, branch: to, report: stored.report, upload: { ...stored.upload, branch: to } });
            await w.tx.reports.delete(project.id, from);
            await w.tx.triage.renameBranch(project.id, from, to);
            await w.tx.reports.renameArchive(project.id, from, to);
            // Moving the default branch's report keeps it the default unless told otherwise.
            // The project as it is now: another change may have saved it since this request loaded it.
            const current = (await w.tx.projects.get(project.id)) ?? project;
            const wasDefault = from === current.defaultBranch;
            const makeDefault = input.makeDefault === true || (input.makeDefault === undefined && wasDefault);
            if (makeDefault) await w.tx.projects.put({ ...current, defaultBranch: to });
            const issues = stored.report.comments.length;
            await w.activity(
                {
                    workspaceId: project.workspaceId,
                    projectId: project.id,
                    branch: to,
                    kind: "branch",
                    itemId: to,
                    changes: { moved: { from, to, issues } },
                },
                project.slug,
            );
            return { from, to, issues, defaultBranch: makeDefault ? to : current.defaultBranch };
        });
    }

    /** Delete a branch's report and triage (both kept in its archive). Unresolved issues need `confirm`. */
    async deleteBranch(actor: Actor, project: Project, input: { branch: unknown; confirm?: unknown }) {
        const branch = checkBranch(input.branch, "");
        if (branch === project.defaultBranch)
            throw badRequest(`"${branch}" is the default branch, so it can't be deleted. Upload a new report to replace it.`);
        return this.core.write(actor, async (w) => {
            const stored = await w.tx.reports.get(project.id, branch);
            if (!stored) throw notFound(`No report for branch "${branch}".`);
            const view = await this.build(w.tx, project, branch, stored);
            const st = view.counts(view.issues()).status;
            const unresolved = st.open + st.in_progress;
            if (unresolved && input.confirm !== true) {
                throw new ApiError(
                    409,
                    `Branch "${branch}" has ${unresolved} unresolved issue(s). Send "confirm": true to delete it anyway.`,
                    {
                        details: { requiresConfirmation: true, unresolved },
                    },
                );
            }
            const triage = await w.tx.triage.forBranch(project.id, branch);
            await w.tx.reports.archive(
                {
                    projectId: project.id,
                    branch,
                    report: stored.report,
                    upload: stored.upload,
                    archivedAt: now(),
                    reason: "deleted",
                    triage,
                },
                KEEP_ARCHIVED,
            );
            await w.tx.reports.delete(project.id, branch);
            await w.tx.triage.deleteBranch(project.id, branch);
            const issues = view.issues().length;
            await w.activity(
                {
                    workspaceId: project.workspaceId,
                    projectId: project.id,
                    branch,
                    kind: "branch",
                    itemId: branch,
                    changes: { deleted: { issues, unresolved } },
                },
                project.slug,
            );
            return { deleted: true, branch, issues, unresolved };
        });
    }

    // ---- uploads ---------------------------------------------------------------------------

    /** What replacing `current` with `next` would do. */
    private compareReports(current: BranchView, next: Review) {
        const unresolved = current.issues().filter((x) => !current.isDone(x.id));
        const kept = next.issues.filter((x) => current.review.byId.has(x.id));
        const removed = current.review.issues.filter((x) => !next.byId.has(x.id));
        const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, next.issues.filter((x) => x.severity === s).length])) as Record<
            Severity,
            number
        >;
        return {
            current: {
                loaded: current.review.meta.loaded,
                fileName: current.review.meta.upload?.fileName ?? null,
                issues: current.review.issues.length,
                unresolved: unresolved.length,
                inProgress: unresolved.filter((x) => current.statusOf("issue", x.id) === "in_progress").length,
            },
            next: { issues: next.issues.length, files: next.paths.length, tasks: next.tasks.length, bySeverity },
            carriedOver: kept.length,
            withTriage: next.issues.filter((x) => current.record("issue", x.id)).length,
            added: next.issues.length - kept.length,
            removed: removed.length,
            removedUnresolved: removed.filter((x) => !current.isDone(x.id)).length,
            requiresConfirmation: unresolved.length > 0,
            stillReportedResolved: next.issues.filter((x) => current.statusOf("issue", x.id) === "resolved").length,
        };
    }

    /**
     * Upload a report to a branch, or with `preview` only say what it would do. A branch whose current
     * report has unresolved issues is only replaced with `confirm: true` (409 otherwise).
     */
    async upload(actor: Actor, project: Project, input: UploadInput, { preview = false } = {}) {
        const branch = this.branchOf(project, input.branch);
        const commit = checkCommit(input.commit);
        const fileName = checkFileName(input.fileName);
        const report = input.report;
        const digest = createHash("sha256")
            .update(JSON.stringify(report ?? null))
            .digest("hex");
        const upload: UploadMeta = {
            id: randomUUID(),
            branch,
            commit,
            fileName,
            uploadedAt: now(),
            uploadedBy: actor.name,
            sha256: digest,
            scope: input.scope === "diff" ? "diff" : "full",
        };
        const run = async (tx: Repos) => {
            const stored = await tx.reports.get(project.id, branch);
            // Findings people or agents added by hand survive a new report, unless it contains them itself.
            let merged = report as RawReport;
            let keptAdded = 0;
            const added = stored?.report.comments.filter((c) => c.added_by) ?? [];
            if (added.length && report && typeof report === "object" && Array.isArray((report as RawReport).comments)) {
                const extra = added.filter((c) => !(report as RawReport).comments.some((n) => sameFinding(n, c)));
                keptAdded = extra.length;
                if (keptAdded) merged = { ...(report as RawReport), comments: [...(report as RawReport).comments, ...extra] };
            }
            let next: Review;
            try {
                next = parseReport(merged, upload);
            } catch (err) {
                throw new ApiError(422, (err as Error).message);
            }
            const current = await this.build(tx, project, branch, stored);
            const identical = stored?.upload.sha256 === digest;
            // Re-uploading the same file never reopens anything.
            const reopen = input.reopen !== false && !identical;
            const comparison = { ...this.compareReports(current, next), branch, newBranch: !stored, identical, reopen, keptAdded };
            if (identical) comparison.stillReportedResolved = 0;
            return { stored, merged, next, current, comparison };
        };

        if (preview) return (await run(this.core.store)).comparison;
        return this.core.write(actor, async (w) => {
            const { stored, merged, next, current, comparison } = await run(w.tx);
            if (comparison.requiresConfirmation && input.confirm !== true) {
                throw new ApiError(
                    409,
                    `Branch "${branch}" has ${comparison.current.unresolved} unresolved issue(s). Send "confirm": true to replace its report anyway.`,
                    {
                        details: comparison,
                    },
                );
            }
            if (stored)
                await w.tx.reports.archive(
                    { projectId: project.id, branch, report: stored.report, upload: stored.upload, archivedAt: now(), reason: "replaced" },
                    KEEP_ARCHIVED,
                );
            await w.tx.reports.put({ projectId: project.id, branch, report: merged, upload });
            let reopened = 0;
            if (comparison.reopen) {
                const why = `still reported by ${fileName}${commit ? ` at commit ${commit.slice(0, 10)}` : ""}.`;
                for (const x of next.issues) {
                    if (current.statusOf("issue", x.id) !== "resolved") continue;
                    if (
                        await applyChange(
                            w,
                            project,
                            branch,
                            "issue",
                            x.id,
                            { status: "open", reopened: why, note: `Reopened: ${why}` },
                            actor,
                        )
                    )
                        reopened++;
                }
            }
            await w.activity(
                {
                    workspaceId: project.workspaceId,
                    projectId: project.id,
                    branch,
                    kind: "report",
                    itemId: fileName,
                    changes: {
                        uploaded: {
                            issues: next.issues.length,
                            carriedOver: comparison.carriedOver,
                            added: comparison.added,
                            removed: comparison.removed,
                            reopened,
                            keptAdded: comparison.keptAdded,
                            commit,
                        },
                    },
                },
                project.slug,
            );
            // Reviews run on the server upload through GitHub automation and record themselves, with their timings.
            if (this.reviews && actor.via !== "github") {
                const m = reportMetrics(merged);
                const addedIds: Partial<Record<Severity, string[]>> = {};
                let kept = 0;
                for (const x of next.issues) {
                    if (current.review.byId.has(x.id) || kept++ >= MAX_ADDED_IDS) continue;
                    const ids = addedIds[x.severity] ?? [];
                    ids.push(x.id);
                    addedIds[x.severity] = ids;
                }
                await this.reviews.record(w.tx, {
                    workspaceId: project.workspaceId,
                    projectId: project.id,
                    branch,
                    at: upload.uploadedAt,
                    source: "upload",
                    kind: "upload",
                    status: m.partial ? "partial" : "done",
                    model: m.model,
                    provider: m.provider,
                    keySource: null,
                    tokens: m.tokens,
                    details: {
                        commit,
                        requestedBy: actor.name,
                        ocrVersion: m.ocrVersion,
                        ...(m.runSeconds !== null ? { runSeconds: m.runSeconds } : {}),
                        findings: { total: next.issues.length, bySeverity: comparison.next.bySeverity },
                        counts: { added: comparison.added, carriedOver: comparison.carriedOver, removed: comparison.removed, reopened },
                        ...(m.files ? { files: m.files } : {}),
                        ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
                        ...(m.llm ? { llm: m.llm } : {}),
                        addedIds,
                    },
                });
            }
            return { ok: true, ...comparison, reopened, current: next.meta };
        });
    }

    /** Add one finding by hand to a branch (creating its report if it has none). */
    async addFinding(actor: Actor, ref: BranchRef, input: Record<string, unknown>) {
        const { project, branch } = ref;
        const path = (textField(input.path, 500, "path", true) as string).trim().replace(/^(\.\/)+/, "");
        if (!path || /^[/\\]|^[a-z]:/i.test(path) || /(^|[/\\])\.\.([/\\]|$)/.test(path))
            throw badRequest('path must be relative to the repository root, without "..".');
        const content = (textField(input.content, 8000, "content", true) as string).trim();
        if (content.length < 10) throw badRequest("Describe the problem in at least a sentence.");
        const severity = String(input.severity ?? "medium") as Severity;
        if (!SEVERITIES.includes(severity)) throw badRequest(`severity must be one of: ${SEVERITIES.join(", ")}.`);
        const category = String(input.category ?? "bug") as Category;
        if (!CATEGORIES.includes(category)) throw badRequest(`category must be one of: ${CATEGORIES.join(", ")}.`);
        const start = line(input.startLine ?? input.start_line, "startLine");
        const endInput = line(input.endLine ?? input.end_line, "endLine");
        if (endInput && !start) throw badRequest("endLine needs a startLine too.");
        const end = endInput ?? start;
        if (start && end && end < start) throw badRequest("endLine can't be before startLine.");
        const existing = textField(input.existingCode ?? input.existing_code, 20_000, "existingCode");
        const suggestion = textField(input.suggestionCode ?? input.suggestion_code, 20_000, "suggestionCode");
        const comment: RawComment = {
            path,
            content,
            severity,
            category,
            ...(start ? { start_line: start, end_line: end } : {}),
            ...(existing ? { existing_code: existing } : {}),
            ...(suggestion ? { suggestion_code: suggestion } : {}),
            added_by: actor.name,
            added_at: now(),
        };
        return this.core.write(actor, async (w) => {
            const stored = await w.tx.reports.get(project.id, branch);
            const raw: RawReport = stored ? structuredClone(stored.report) : { status: "manual", comments: [], project_summary: "" };
            if (raw.comments.some((c) => sameFinding(c, comment))) throw conflict("That exact finding is already on this branch.");
            raw.comments.push(comment);
            const upload: UploadMeta = stored?.upload ?? {
                id: randomUUID(),
                branch,
                commit: null,
                fileName: "(added by hand)",
                uploadedAt: now(),
                uploadedBy: actor.name,
                sha256: null,
                scope: "full",
            };
            let next: Review;
            try {
                next = parseReport(raw, upload);
            } catch (err) {
                throw new ApiError(422, (err as Error).message);
            }
            await w.tx.reports.put({ projectId: project.id, branch, report: raw, upload });
            const issue = next.issues.at(-1);
            if (!issue) throw new Error("The added finding is missing.");
            await w.activity(
                {
                    workspaceId: project.workspaceId,
                    projectId: project.id,
                    branch,
                    kind: "issue",
                    itemId: issue.id,
                    changes: { added: { severity, category, path } },
                },
                project.slug,
            );
            return { issue: (await this.view(w.tx, project, branch)).getIssue(issue.id) };
        });
    }

    // ---- single-use upload links ------------------------------------------------------------

    /** A link that accepts one raw OCR JSON file, so large reports never pass through an agent's conversation. */
    async createLink(
        actor: Actor,
        project: Project,
        input: { branch?: unknown; commit?: unknown; confirm?: unknown; reopen?: unknown; fileName?: unknown },
    ) {
        const params = {
            branch: this.branchOf(project, input.branch),
            commit: checkCommit(input.commit),
            confirm: input.confirm === true,
            reopen: input.reopen !== false,
            fileName: input.fileName ? checkFileName(input.fileName) : null,
            actor: actor.name,
            actorUserId: actor.userId,
            actorTokenId: actor.tokenId ?? null,
        };
        const token = randomBytes(24).toString("base64url");
        const expiresAt = Date.now() + LINK_TTL_MS;
        await this.core.store.transaction(async (tx) => {
            await tx.uploadLinks.sweep(Date.now());
            if ((await tx.uploadLinks.count()) >= MAX_LINKS)
                throw new ApiError(429, "Too many upload links are waiting to be used. Use them or let some expire first.");
            await tx.uploadLinks.put({ hash: sha256(token), projectId: project.id, params, expiresAt });
        });
        return {
            url: `${this.core.config.publicOrigin}/api/v1/uploads/${token}`,
            expiresAt: new Date(expiresAt).toISOString(),
            branch: params.branch,
        };
    }

    /** Whether an upload link exists and hasn't expired, checked before reading what's uploaded to it. */
    async linkExists(token: string): Promise<boolean> {
        const link = await this.core.store.uploadLinks.get(sha256(token));
        return Boolean(link && link.expiresAt > Date.now());
    }

    /** Whoever made the link must still be allowed to upload: a revoked token's or removed member's links stop working. */
    private async linkStillAllowed(tx: Repos, link: UploadLink, project: Project): Promise<boolean> {
        const p = link.params;
        if (p.actorTokenId) {
            const t = await tx.tokens.get(p.actorTokenId);
            if (!t || t.workspaceId !== project.workspaceId || (t.expiresAt && Date.parse(t.expiresAt) < Date.now())) return false;
            // As for the token itself: its scope, capped by its owner's role now.
            const m = t.ownerUserId ? await tx.memberships.get(project.workspaceId, t.ownerUserId) : null;
            return Boolean(m && permissionsOf({ kind: "token", scope: t.scope, role: m.role }).has("upload"));
        }
        if (p.actorUserId) {
            const m = await tx.memberships.get(project.workspaceId, p.actorUserId);
            return Boolean(m && ROLE_PERMISSIONS[m.role].includes("upload"));
        }
        return false;
    }

    /**
     * Use up an upload link. Returns null if it's unknown, used, expired or no longer allowed. A refused
     * upload (needs confirmation, not a report) leaves the link usable, so the caller can fix it and retry.
     */
    async redeemLink(token: string, report: unknown) {
        return this.core.store.transaction(async (tx) => {
            const link = await tx.uploadLinks.take(sha256(token));
            if (!link || link.expiresAt <= Date.now()) return null;
            const project = await tx.projects.get(link.projectId);
            if (!project || !(await this.linkStillAllowed(tx, link, project))) return null;
            const p = link.params;
            const actor: Actor = {
                name: p.actor,
                userId: p.actorUserId,
                ...(p.actorTokenId ? { tokenId: p.actorTokenId } : {}),
                via: "link",
            };
            const out = await this.upload(actor, project, {
                branch: p.branch,
                commit: p.commit,
                confirm: p.confirm,
                reopen: p.reopen,
                fileName: p.fileName ?? "code_review.json",
                report,
            });
            return {
                ok: true,
                branch: out.branch,
                issues: out.next.issues,
                carriedOver: out.carriedOver,
                added: out.added,
                removed: out.removed,
                reopened: (out as { reopened?: number }).reopened ?? 0,
                keptAdded: out.keptAdded,
            };
        });
    }

    /** Recent activity on a project (all branches unless one is named). */
    async activity(project: Project, branch: string | null, limit: number, before?: string) {
        return this.core.store.activity.list(
            { workspaceId: project.workspaceId, projectId: project.id, ...(branch ? { branch } : {}) },
            { limit, ...(before ? { before } : {}) },
        );
    }

    async overview(project: Project, branch: string) {
        const view = await this.view(this.core.store, project, branch);
        return view.overview(await this.activity(project, branch, 10));
    }
}
