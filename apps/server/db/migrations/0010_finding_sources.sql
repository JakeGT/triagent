-- Which model found which finding, kept apart from the reports. A branch's report only says who found
-- what in its latest review, and goes when the branch does; these rows stay, so a model's findings (and
-- how many of them were fixed, or dismissed) can be counted over time.
--
-- One row for each model that reported a finding on a branch, written when a review is saved. `outcome`
-- follows the finding's triage: accepted when it's resolved, rejected when it's marked won't fix (other
-- than as a duplicate), empty while it's open. Like review_history, rows outlive their project unless its
-- analytics are cleared with it (no foreign key on project_id).
create table finding_sources (
    workspace_id  text not null references workspaces (id) on delete cascade,
    project_id    text not null,
    branch        text not null,
    finding_id    text not null,
    -- The provider's model id, and the provider ('' when a report didn't say).
    model         text not null,
    provider      text not null default '',
    -- What people called it in that review.
    label         text not null,
    -- The review that first reported it with this model (a job id, or an upload's id), and how many models
    -- that review ran: a finding only one of several found is "unique" to it.
    scan_id       text,
    scan_models   integer not null default 1,
    severity      text not null,
    first_seen_at timestamptz not null,
    outcome       text check (outcome in ('accepted', 'rejected')),
    decided_at    timestamptz,
    primary key (project_id, branch, finding_id, model, provider)
);

create index finding_sources_workspace on finding_sources (workspace_id, first_seen_at desc);
