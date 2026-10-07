// Vocabulary shared by the server, the web app and agents.

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = ["security", "bug", "performance", "test", "maintainability", "documentation", "style", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const STATUSES = ["open", "in_progress", "resolved", "wont_fix"] as const;
export type Status = (typeof STATUSES)[number];

/** Statuses that count as dealt with. */
export const DONE_STATUSES: ReadonlySet<Status> = new Set(["resolved", "wont_fix"]);

export const ISSUE_SORTS = ["priority", "path", "severity", "updated", "index"] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

/** What a report covers: the whole codebase, or only a pull request's or branch's changes. */
export const REPORT_SCOPES = ["full", "diff"] as const;
export type ReportScope = (typeof REPORT_SCOPES)[number];

/** How a change was made, shown in activity and audit logs. */
export const VIAS = ["web", "token", "mcp", "link", "github", "system", "cli"] as const;
export type Via = (typeof VIAS)[number];
