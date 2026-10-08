-- One row per finished review (a run on the server, or an uploaded report), for analytics and for
-- counting model tokens against allowances. Listed newest first by seq.
create table review_history (
    seq          bigint generated always as identity primary key,
    id           text not null unique,
    workspace_id text not null references workspaces (id) on delete cascade,
    -- No foreign key: analytics keep a deleted project's history.
    project_id   text,
    branch       text not null,
    at           timestamptz not null,
    source       text not null check (source in ('run', 'upload')),
    kind         text not null check (kind in ('pr', 'changes', 'full', 'upload')),
    status       text not null check (status in ('done', 'partial', 'failed', 'cancelled')),
    model        text,
    provider     text,
    key_source   text check (key_source in ('workspace', 'instance')),
    tokens       jsonb,
    -- Total model tokens, kept as a column so allowances can be summed quickly.
    tokens_total bigint not null default 0,
    details      jsonb not null
);
create index review_history_workspace on review_history (workspace_id, at desc);
create index review_history_project on review_history (project_id, at desc);
