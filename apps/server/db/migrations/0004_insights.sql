-- Settings that belong to the instance rather than a workspace: the instance's review model and model
-- prices. (Workspace settings live in `settings`, whose workspace_id can't be null.)
create table instance_settings (
    key   text primary key,
    value jsonb not null
);

-- Workspaces the instance admin lets use the instance's model key, each with a monthly token allowance.
create table model_grants (
    workspace_id   text primary key references workspaces (id) on delete cascade,
    monthly_tokens bigint not null check (monthly_tokens > 0),
    granted_by     text not null,
    granted_at     timestamptz not null
);

-- Allowances sum this month's instance-key tokens per workspace.
create index review_history_key_source on review_history (key_source, at) where key_source is not null;
