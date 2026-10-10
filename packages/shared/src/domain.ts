// Vocabulary shared by the server, the web app and agents.

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = ["security", "bug", "performance", "test", "maintainability", "documentation", "style", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const STATUSES = ["open", "in_progress", "resolved", "wont_fix"] as const;
export type Status = (typeof STATUSES)[number];

/** Statuses that count as dealt with. */
export const DONE_STATUSES: ReadonlySet<Status> = new Set(["resolved", "wont_fix"]);

/**
 * The longest issue, task or section id accepted. Task ids come from the summary's headings
 * ("cross-cutting-concerns-3"), so they can be long; shortening them would detach existing triage.
 */
export const MAX_ID = 300;

/** "agreement": found by the most models first (reviews run with several), then by priority. */
export const ISSUE_SORTS = ["priority", "path", "severity", "updated", "index", "agreement"] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

/** What a report covers: the whole codebase, or only a pull request's or branch's changes. */
export const REPORT_SCOPES = ["full", "diff"] as const;
export type ReportScope = (typeof REPORT_SCOPES)[number];

/** How a change was made, shown in activity and audit logs. */
export const VIAS = ["web", "token", "mcp", "link", "github", "system", "cli"] as const;
export type Via = (typeof VIAS)[number];

/** How many patterns for files that don't need a review a project can have, and how long each can be. */
export const MAX_SKIP_PATHS = 50;
export const MAX_SKIP_PATH_LENGTH = 200;
