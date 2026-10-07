// Activity rows in plain English. `changes` records what each write did (see apps/server/src/services:
// triage.ts applyChange and changeNote, reports.ts uploads, branches and added findings, projects.ts).

import { CATEGORIES, type Category, SEVERITIES, type Severity, STATUSES, type Status } from "@triagent/shared";
import { CATEGORY_LABEL, SEVERITY_LABEL, STATUS_LABEL } from "@/lib/format";
import type { ActivityRow } from "@/lib/types";

type Change = { from?: unknown; to?: unknown };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const isOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

function status(v: unknown): string {
    return isOf(STATUSES, v) ? STATUS_LABEL[v as Status].toLowerCase() : String(v);
}

/** What the item is called: "issue ocr-12ab34cd", "task top-issues-1". */
export function itemLabel(row: ActivityRow): string {
    if (row.kind === "issue" || row.kind === "task") return `${row.kind} ${row.itemId}`;
    if (row.kind === "report") return `report ${row.itemId}`;
    if (row.kind === "branch") return `branch ${row.itemId}`;
    if (row.kind === "project") return `project ${row.itemId}`;
    return row.itemId;
}

function triage(row: ActivityRow): string[] {
    const c = row.changes;
    const what = row.kind === "task" ? "the task" : "the issue";
    const parts: string[] = [];
    const added = obj(c.added);
    if (c.added) {
        const sev = isOf(SEVERITIES, added.severity) ? SEVERITY_LABEL[added.severity as Severity].toLowerCase() : "";
        parts.push(`added a ${sev ? `${sev} ` : ""}finding in ${String(added.path ?? "a file")}`);
    }
    if (c.status) parts.push(`set the status to ${status((c.status as Change).to)}`);
    if (c.assignee) {
        const to = (c.assignee as Change).to;
        parts.push(to ? `assigned it to ${String(to)}` : "unassigned it");
    }
    if (c.severity) {
        const to = (c.severity as Change).to;
        parts.push(isOf(SEVERITIES, to) ? `rated it ${SEVERITY_LABEL[to as Severity].toLowerCase()}` : "restored the reviewer's severity");
    }
    if (c.category) {
        const to = (c.category as Change).to;
        parts.push(
            isOf(CATEGORIES, to) ? `filed it under ${CATEGORY_LABEL[to as Category].toLowerCase()}` : "restored the reviewer's category",
        );
    }
    if (c.duplicateOf) {
        const to = (c.duplicateOf as Change).to;
        parts.push(to ? `marked it a duplicate of ${String(to)}` : "unmarked it as a duplicate");
    }
    if (c.needsDiscussion) parts.push((c.needsDiscussion as Change).to ? "flagged it for discussion" : "cleared the discussion flag");
    if (c.reopened) parts.push(`reopened it: ${String(c.reopened)}`);
    if (c.note) parts.push(`added a note to ${what}`);
    if (c.noteEdited) parts.push(`edited a note on ${what}`);
    if (c.noteDeleted) parts.push(`deleted ${String(obj(c.noteDeleted).by ?? "a")}'s note on ${what}`);
    return parts;
}

/** "set the status to resolved and added a note", without the actor. */
export function describeActivity(row: ActivityRow): string {
    const c = row.changes;
    let parts: string[] = [];
    if (row.kind === "issue" || row.kind === "task") parts = triage(row);
    else if (row.kind === "report" && c.uploaded) {
        const u = obj(c.uploaded);
        const extra = [
            u.added ? `${u.added} new` : "",
            u.removed ? `${u.removed} gone` : "",
            u.reopened ? `${u.reopened} reopened` : "",
        ].filter(Boolean);
        parts.push(`uploaded ${row.itemId} with ${String(u.issues ?? 0)} findings${extra.length ? ` (${extra.join(", ")})` : ""}`);
    } else if (row.kind === "branch" && c.moved) {
        const m = obj(c.moved);
        parts.push(`moved branch ${String(m.from)} to ${String(m.to)}`);
    } else if (row.kind === "branch" && c.deleted) {
        const d = obj(c.deleted);
        parts.push(`deleted branch ${row.itemId}${d.unresolved ? ` with ${String(d.unresolved)} unresolved issues` : ""}`);
    } else if (row.kind === "project") {
        if (c.created) parts.push(`created the project ${String(obj(c.created).name ?? row.itemId)}`);
        else if (c.deleted) parts.push(`deleted the project ${row.itemId}`);
        else {
            if (c.name) parts.push(`renamed the project to ${String((c.name as Change).to)}`);
            if (c.repoUrl)
                parts.push(
                    (c.repoUrl as Change).to ? `set the repository to ${String((c.repoUrl as Change).to)}` : "removed the repository",
                );
            if (c.defaultBranch) parts.push(`made ${String((c.defaultBranch as Change).to)} the default branch`);
        }
    }
    if (!parts.length) parts.push(`changed ${itemLabel(row)}`);
    return parts.join(" and ");
}
