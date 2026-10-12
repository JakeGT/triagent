-- What a model was asked to write about findings and reviews (services/analyst.ts): a comparison of a
-- review's models, a summary of what a review changed, an answer to a question about the analytics.
-- One row for each time it was asked, kept with the tokens it took, so the page can show the latest
-- and analytics can count what the asking cost.
--
-- `subject` is what it's about within its kind: the run a comparison or summary is of; empty for a
-- question. `input` is what was asked (a question and its scope), `result` what came back.
create table analyses (
    id            text primary key,
    workspace_id  text not null references workspaces (id) on delete cascade,
    -- Null: about the workspace as a whole (a question across projects).
    project_id    text references projects (id) on delete cascade,
    branch        text,
    kind          text not null,
    subject       text not null default '',
    status        text not null check (status in ('running', 'done', 'failed')),
    requested_by  jsonb not null,
    model         jsonb,
    tokens        jsonb,
    input         jsonb,
    result        jsonb,
    error         text,
    created_at    timestamptz not null,
    finished_at   timestamptz
);

create index analyses_latest on analyses (workspace_id, kind, subject, created_at desc);
create index analyses_workspace on analyses (workspace_id, created_at desc);
