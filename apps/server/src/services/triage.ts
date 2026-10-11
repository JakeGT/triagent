// Changing issues and tasks: status, assignee, rating corrections, duplicates, discussion flags, notes,
// claims and bulk changes. Every change is conditional on what the caller saw when they ask for that
// (rev), runs in one transaction, and is written to the activity log.

import { CATEGORIES, type Category, MAX_ID, SEVERITIES, type Severity, STATUSES, type Status } from "@triagent/shared";
import type { BranchView } from "../domain/branch.ts";
import { list, parseFilters } from "../domain/filters.ts";
import { cleanText } from "../domain/names.ts";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { now, randomId } from "../security.ts";
import type { ItemKind, Note, Project, TriageRecord } from "../store/types.ts";
import { type Actor, authorKey, type Core, type Write } from "./core.ts";
import type { Reports } from "./reports.ts";

const MAX_NOTES = 200;

export interface Change {
    status?: Status;
    assignee?: string | null;
    /** null puts back the reviewer's rating. */
    severity?: Severity | null;
    category?: Category | null;
    duplicateOf?: string | null;
    needsDiscussion?: boolean;
    note?: string;
    reopened?: string;
    /** Only apply if the record still matches. */
    expect?: { rev?: number; status?: Status; assignee?: string | null };
}

export class StaleError extends ApiError {}

function blank(project: Project, branch: string, kind: ItemKind, itemId: string): TriageRecord {
    return {
        projectId: project.id,
        branch,
        kind,
        itemId,
        status: "open",
        assignee: null,
        severity: null,
        category: null,
        duplicateOf: null,
        needsDiscussion: false,
        notes: [],
        rev: 0,
        updatedAt: null,
        updatedBy: null,
    };
}

/**
 * Apply one change to one issue or task's triage. Returns what changed, or null if nothing did.
 * Throws StaleError (409) if `expect` doesn't match the saved record.
 */
/**
 * What a finding's triage says about the finding itself: accepted once it's resolved, rejected when it's
 * dismissed as not worth fixing. A duplicate is neither: it says nothing about whether the finding was right.
 */
export function outcomeOf(record: Pick<TriageRecord, "status" | "duplicateOf"> | null): "accepted" | "rejected" | null {
    if (record?.status === "resolved") return "accepted";
    if (record?.status === "wont_fix" && !record.duplicateOf) return "rejected";
    return null;
}

export async function applyChange(
    w: Write,
    project: Project,
    branch: string,
    kind: ItemKind,
    itemId: string,
    change: Change,
    actor: Actor,
): Promise<Record<string, unknown> | null> {
    const prev = (await w.tx.triage.get(project.id, branch, kind, itemId)) ?? blank(project, branch, kind, itemId);
    const e = change.expect ?? {};
    if (
        (e.rev !== undefined && e.rev !== prev.rev) ||
        (e.status !== undefined && e.status !== prev.status) ||
        (e.assignee !== undefined && (e.assignee || null) !== prev.assignee)
    ) {
        throw new StaleError(409, `Someone else changed ${itemId} since you loaded it. Reload it and try again.`);
    }
    const next: TriageRecord = { ...prev, notes: [...prev.notes] };
    const changes: Record<string, unknown> = {};
    const set = <K extends "status" | "assignee" | "severity" | "category" | "duplicateOf" | "needsDiscussion">(
        k: K,
        value: TriageRecord[K] | undefined,
    ) => {
        if (value === undefined || value === prev[k]) return;
        changes[k] = { from: prev[k], to: value };
        next[k] = value;
    };
    set("status", change.status);
    set("assignee", change.assignee === undefined ? undefined : change.assignee || null);
    set("severity", change.severity);
    set("category", change.category);
    set("duplicateOf", change.duplicateOf);
    set("needsDiscussion", change.needsDiscussion);
    if (change.reopened) changes.reopened = change.reopened;
    if (change.note) {
        const note: Note = { id: `n${randomId(6)}`, at: now(), by: actor.name, authorKey: authorKey(actor), text: change.note };
        next.notes = [...next.notes, note].slice(-MAX_NOTES);
        changes.note = change.note;
    }
    if (!Object.keys(changes).length) return null;
    await w.tx.triage.put({ ...next, rev: prev.rev + 1, updatedAt: now(), updatedBy: actor.name });
    // What became of the finding is kept with who found it (for each model's figures), and stays when the branch goes.
    if (kind === "issue" && ("status" in changes || "duplicateOf" in changes))
        await w.tx.findingSources.setOutcome(project.id, branch, itemId, outcomeOf(next), now());
    await w.activity({ workspaceId: project.workspaceId, projectId: project.id, branch, kind, itemId, changes }, project.slug);
    return changes;
}

function text(value: unknown, max: number, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw badRequest(`${field} must be text.`);
    const v = cleanText(value).trim();
    if (v.length > max) throw badRequest(`${field} must be at most ${max} characters.`);
    return v;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
    if (!(allowed as readonly unknown[]).includes(value))
        throw badRequest(`Unknown ${field}: ${String(value)}. Allowed: ${allowed.join(", ")}.`);
    return value as T;
}

export interface Patch {
    status?: Status;
    assignee?: string | null;
    severity?: Severity | "reviewer" | null;
    category?: Category | "reviewer" | null;
    duplicateOf?: string | null;
    needsDiscussion?: boolean;
    note?: string;
    rev?: number;
}

/** Validate a change sent by a person or agent. */
export function parsePatch(body: unknown): Patch {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Send a JSON object.");
    const b = body as Record<string, unknown>;
    const p: Patch = {};
    if (b.status !== undefined) p.status = pick(b.status, STATUSES, "status");
    if (b.rev !== undefined && b.rev !== null) {
        if (!Number.isInteger(b.rev) || (b.rev as number) < 0)
            throw badRequest("rev must be the whole number from the issue or task you loaded.");
        p.rev = b.rev as number;
    }
    if (b.assignee !== undefined) p.assignee = b.assignee === null ? null : (text(b.assignee, 64, "assignee") ?? null);
    const note = text(b.note, 4000, "note");
    if (note) p.note = note;
    // null or "reviewer" puts back what the reviewer said.
    if (b.severity !== undefined)
        p.severity = b.severity === null || b.severity === "reviewer" ? "reviewer" : pick(b.severity, SEVERITIES, "severity");
    if (b.category !== undefined)
        p.category = b.category === null || b.category === "reviewer" ? "reviewer" : pick(b.category, CATEGORIES, "category");
    if (b.duplicateOf !== undefined)
        p.duplicateOf = b.duplicateOf === null || b.duplicateOf === "" ? null : (text(b.duplicateOf, MAX_ID, "duplicateOf") ?? null);
    if (b.needsDiscussion !== undefined) {
        if (typeof b.needsDiscussion !== "boolean") throw badRequest("needsDiscussion must be true or false.");
        p.needsDiscussion = b.needsDiscussion;
    }
    const fields = Object.keys(p).filter((k) => k !== "rev");
    if (!fields.length)
        throw badRequest(
            "Nothing to change. Send at least one of: status, assignee, severity, category, duplicateOf, needsDiscussion, note.",
        );
    return p;
}

export interface BranchRef {
    project: Project;
    branch: string;
}

export class Triage {
    private readonly core: Core;
    private readonly reports: Reports;

    constructor(core: Core, reports: Reports) {
        this.core = core;
        this.reports = reports;
    }

    /** Follow a duplicate chain to its original, refusing unknown ids and loops back to `self`. */
    private duplicateRoot(view: BranchView, target: string, self: string): string {
        if (!view.review.byId.has(target)) throw notFound(`No issue ${target} on branch ${view.branch}.`);
        if (target === self) throw badRequest("An issue can't be a duplicate of itself.");
        let root = target;
        for (let hops = 0; hops < 50; hops++) {
            if (root === self) throw badRequest(`${self} can't be a duplicate of ${target}: that would make a loop.`);
            const next = view.record("issue", root)?.duplicateOf;
            // Stop at the last link still in this branch's report (a newer report may have dropped the rest).
            if (!next || !view.review.byId.has(next)) return root;
            root = next;
        }
        throw badRequest("That duplicate chain is too long.");
    }

    /** Turn a patch into a change for one issue: ratings relative to the reviewer's, duplicates, notes. */
    private async issueChange(
        w: Write,
        ref: BranchRef,
        view: BranchView,
        id: string,
        patch: Patch,
        actor: Actor,
    ): Promise<Record<string, unknown> | null> {
        const original = view.review.byId.get(id);
        const current = view.issue(id);
        const record = view.record("issue", id);
        if (!original || !current) throw notFound(`No issue ${id} on branch ${ref.branch}.`);
        const change: Change = { status: patch.status, assignee: patch.assignee, needsDiscussion: patch.needsDiscussion };
        if (patch.rev !== undefined) change.expect = { rev: patch.rev };
        const said: string[] = [];
        if (patch.severity !== undefined) {
            const target = patch.severity === "reviewer" ? original.severity : patch.severity;
            change.severity = target === original.severity ? null : target;
            if (target !== current.severity)
                said.push(
                    `Severity changed from ${current.severity} to ${target}${target === original.severity ? " (the reviewer's original)" : ""}.`,
                );
        }
        if (patch.category !== undefined) {
            const target = patch.category === "reviewer" ? original.category : patch.category;
            change.category = target === original.category ? null : target;
            if (target !== current.category)
                said.push(
                    `Category changed from ${current.category} to ${target}${target === original.category ? " (the reviewer's original)" : ""}.`,
                );
        }
        if (patch.duplicateOf !== undefined) {
            if (patch.duplicateOf) {
                const root = this.duplicateRoot(view, patch.duplicateOf, id);
                if (record?.duplicateOf !== root) {
                    change.duplicateOf = root;
                    change.status ??= "wont_fix";
                    said.push(
                        `Marked as a duplicate of ${root}${root !== patch.duplicateOf ? ` (${patch.duplicateOf} is itself a duplicate of it)` : ""}.`,
                    );
                }
            } else if (record?.duplicateOf) {
                change.duplicateOf = null;
                // Undo the "won't fix" that marking it a duplicate applied, unless told otherwise.
                if (patch.status === undefined && record.status === "wont_fix") change.status = "open";
                said.push(`No longer a duplicate of ${record.duplicateOf}.`);
            }
        }
        if (patch.needsDiscussion !== undefined && patch.needsDiscussion !== Boolean(record?.needsDiscussion)) {
            said.push(patch.needsDiscussion ? "Flagged as needing discussion." : "Discussion flag cleared.");
        }
        const note = [said.join(" "), patch.note].filter(Boolean).join(" ");
        if (note) change.note = note;
        const changes = await applyChange(w, ref.project, ref.branch, "issue", id, change, actor);
        // Duplicates of this issue now point at its new original.
        if (changes && change.duplicateOf) {
            for (const child of view.duplicatesOf(id)) {
                await applyChange(
                    w,
                    ref.project,
                    ref.branch,
                    "issue",
                    child,
                    {
                        duplicateOf: change.duplicateOf,
                        note: `${id} was marked as a duplicate of ${change.duplicateOf}, so this now points there too.`,
                    },
                    actor,
                );
            }
        }
        return changes;
    }

    async updateIssue(actor: Actor, ref: BranchRef, id: string, body: unknown) {
        const patch = parsePatch(body);
        try {
            return await this.core.write(actor, async (w) => {
                const view = await this.reports.view(w.tx, ref.project, ref.branch);
                const changes = await this.issueChange(w, ref, view, id, patch, actor);
                const after = await this.reports.view(w.tx, ref.project, ref.branch);
                return { issue: after.getIssue(id), changed: changes !== null };
            });
        } catch (err) {
            throw await this.withCurrent(err, ref, "issue", id);
        }
    }

    async bulkUpdate(actor: Actor, ref: BranchRef, body: Record<string, unknown>) {
        const ids = list(body.ids);
        if (!ids.length || ids.length > 1000) throw badRequest("Send ids as a list of 1–1000 issue ids.");
        const { ids: _ids, ...rest } = body;
        // A revision belongs to one issue, so it can't guard a change to many.
        if (rest.rev !== undefined && rest.rev !== null)
            throw badRequest(
                "rev can't be used with a bulk update: it's one issue's revision. Update issues one at a time to check each one's.",
            );
        const patch = parsePatch(rest);
        if (patch.duplicateOf && ids.includes(patch.duplicateOf))
            throw badRequest(`${patch.duplicateOf} is in the list, so it can't be the original they duplicate.`);
        return this.core.write(actor, async (w) => {
            const view = await this.reports.view(w.tx, ref.project, ref.branch);
            const unknown = ids.filter((id) => !view.review.byId.has(id));
            if (unknown.length) throw notFound(`Unknown issue ids: ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? ", …" : ""}`);
            let changed = 0;
            // The report itself doesn't change here, so it's read once; only the triage is read again.
            const stored = await w.tx.reports.get(ref.project.id, ref.branch);
            for (const id of ids) {
                // Each issue is judged on the latest state, since an earlier one in the list may have changed it.
                const fresh = stored
                    ? await this.reports.viewStored(w.tx, ref.project, stored)
                    : await this.reports.view(w.tx, ref.project, ref.branch);
                if (await this.issueChange(w, ref, fresh, id, patch, actor)) changed++;
            }
            return { matched: ids.length, changed };
        });
    }

    /** Give the caller the most urgent open, unassigned issue that matches, marked in progress for them. */
    async claimNext(actor: Actor, ref: BranchRef, body: Record<string, unknown>) {
        const filters = parseFilters({ ...body, status: "open", assignee: "none", limit: 1, sort: "priority" });
        const assignee = text(body.assignee, 64, "assignee") || actor.name;
        const note = text(body.note, 4000, "note") || undefined;
        return this.core.write(actor, async (w) => {
            const view = await this.reports.view(w.tx, ref.project, ref.branch);
            // Issues flagged for discussion need a person first, so they're never handed out.
            const next = view.filter(filters).find((x) => !view.record("issue", x.id)?.needsDiscussion);
            if (!next) return { issue: null, message: "No open, unassigned issues match." };
            await applyChange(
                w,
                ref.project,
                ref.branch,
                "issue",
                next.id,
                { status: "in_progress", assignee, note, expect: { status: "open", assignee: null } },
                actor,
            );
            return { issue: (await this.reports.view(w.tx, ref.project, ref.branch)).getIssue(next.id) };
        });
    }

    /** Hand a claimed issue back. Only its assignee can, unless `force` is set. */
    async releaseIssue(actor: Actor, ref: BranchRef, id: string, body: Record<string, unknown>) {
        const note = text(body.note, 4000, "note") || undefined;
        const force = body.force === true;
        try {
            return await this.core.write(actor, async (w) => {
                const view = await this.reports.view(w.tx, ref.project, ref.branch);
                const issue = view.getIssue(id);
                if (issue.assignee && issue.assignee.toLowerCase() !== actor.name.toLowerCase() && !force) {
                    throw new StaleError(409, `${id} is assigned to ${issue.assignee}, not you. Send "force": true to release it anyway.`);
                }
                // In progress goes back to open; resolved or won't fix keep their status and just lose the assignee.
                const change: Change = { assignee: null, note, expect: { assignee: issue.assignee, status: issue.status } };
                if (issue.status === "in_progress") change.status = "open";
                const changes = await applyChange(w, ref.project, ref.branch, "issue", id, change, actor);
                return { issue: (await this.reports.view(w.tx, ref.project, ref.branch)).getIssue(id), changed: changes !== null };
            });
        } catch (err) {
            throw await this.withCurrent(err, ref, "issue", id);
        }
    }

    async updateTask(actor: Actor, ref: BranchRef, id: string, body: unknown) {
        const patch = parsePatch(body);
        if (
            patch.severity !== undefined ||
            patch.category !== undefined ||
            patch.duplicateOf !== undefined ||
            patch.needsDiscussion !== undefined
        ) {
            throw badRequest("Tasks only have a status, an assignee and notes; change ratings, duplicates and flags on the issues.");
        }
        try {
            return await this.core.write(actor, async (w) => {
                const view = await this.reports.view(w.tx, ref.project, ref.branch);
                view.getTask(id);
                const change: Change = { status: patch.status, assignee: patch.assignee, note: patch.note };
                if (patch.rev !== undefined) change.expect = { rev: patch.rev };
                const changes = await applyChange(w, ref.project, ref.branch, "task", id, change, actor);
                return { task: (await this.reports.view(w.tx, ref.project, ref.branch)).getTask(id), changed: changes !== null };
            });
        } catch (err) {
            throw await this.withCurrent(err, ref, "task", id);
        }
    }

    /**
     * Edit (text) or delete (text null) a note. People edit and delete their own; those who can
     * moderate may also delete anyone's.
     */
    async changeNote(
        actor: Actor & { canModerate: boolean },
        ref: BranchRef,
        kind: ItemKind,
        id: string,
        noteId: string,
        text: string | null,
    ) {
        const value = text === null ? null : cleanText(text).trim();
        if (value !== null && !value) throw badRequest("A note can't be empty. Delete it instead.");
        if (value && value.length > 4000) throw badRequest("Notes can be at most 4000 characters.");
        return this.core.write(actor, async (w) => {
            const view = await this.reports.view(w.tx, ref.project, ref.branch);
            if (kind === "issue" ? !view.review.byId.has(id) : !view.review.taskById.has(id))
                throw notFound(`No ${kind} ${id} on branch ${ref.branch}.`);
            const record = await w.tx.triage.get(ref.project.id, ref.branch, kind, id);
            const i = record?.notes.findIndex((n) => n.id === noteId) ?? -1;
            if (!record || i === -1) throw notFound(`No note ${noteId} on ${id}.`);
            const before = record.notes[i] as Note;
            const own = before.authorKey === authorKey(actor);
            if (value === null ? !(own || actor.canModerate) : !own) {
                throw forbidden(
                    value === null ? "You can only delete your own notes (admins can delete any)." : "You can only edit your own notes.",
                );
            }
            if (value === before.text) return { note: before, changed: false };
            const after: Note | null = value === null ? null : { ...before, text: value, editedAt: now(), editedBy: actor.name };
            const notes = after ? record.notes.map((n, k) => (k === i ? after : n)) : record.notes.filter((_, k) => k !== i);
            await w.tx.triage.put({ ...record, notes, rev: record.rev + 1, updatedAt: now(), updatedBy: actor.name });
            const changes = after
                ? { noteEdited: { id: noteId, from: before.text, to: value } }
                : { noteDeleted: { id: noteId, by: before.by, text: before.text } };
            await w.activity(
                { workspaceId: ref.project.workspaceId, projectId: ref.project.id, branch: ref.branch, kind, itemId: id, changes },
                ref.project.slug,
            );
            return { note: after, changed: true };
        });
    }

    /** A 409 carries the item as it is now, so the caller can show it and retry. */
    private async withCurrent(err: unknown, ref: BranchRef, kind: ItemKind, id: string): Promise<unknown> {
        if (!(err instanceof StaleError)) return err;
        const view = await this.reports.view(this.core.store, ref.project, ref.branch);
        const current = kind === "issue" ? view.getIssue(id) : view.getTask(id);
        return conflict(err.message, { current });
    }
}
