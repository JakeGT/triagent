-- Review runs and GitHub: the queue of jobs runners claim (with leases, progress and a capped log), GitHub
-- App installations linked to workspaces, each project's view of GitHub, recent webhook deliveries, and
-- the runners the server has seen.

create table jobs (
    seq              bigint generated always as identity unique,
    id               text primary key,
    workspace_id     text not null references workspaces (id) on delete cascade,
    project_id       text not null references projects (id) on delete cascade,
    kind             text not null check (kind in ('pr', 'changes', 'full')),
    dedupe_key       text not null,
    title            text not null,
    branch           text not null,
    git_ref          text,
    base_ref         text,
    head_sha         text,
    base_sha         text,
    pr               jsonb,
    requested_by     jsonb not null,
    source           text not null check (source in ('person', 'token', 'automation')),
    status           text not null check (status in ('queued', 'running', 'done', 'partial', 'failed', 'cancelled')),
    queued_at        timestamptz not null,
    started_at       timestamptz,
    finished_at      timestamptz,
    runner_id        text,
    lease_expires_at timestamptz,
    cancel_requested jsonb,
    progress         jsonb not null default '{}',
    result           jsonb,
    error            text,
    model            jsonb,
    -- Sealed (services/secrets.ts) and cleared when the job ends: only for redacting the runner's log.
    credentials      text,
    -- Kept by the store as lines are appended.
    log_lines        integer not null default 0,
    log_bytes        bigint not null default 0,
    log_dropped      integer not null default 0
);
create index jobs_active on jobs (queued_at, seq) where status in ('queued', 'running');
create index jobs_workspace on jobs (workspace_id, queued_at desc);
create index jobs_project on jobs (project_id, queued_at desc);

create table job_logs (
    job_id text not null references jobs (id) on delete cascade,
    seq    integer not null,
    at     timestamptz not null,
    line   text not null,
    primary key (job_id, seq)
);

create table github_installations (
    id                   bigint primary key,
    workspace_id         text not null references workspaces (id) on delete cascade,
    account_login        text not null,
    account_type         text not null,
    repository_selection text not null,
    suspended            boolean not null default false,
    linked_by            text not null,
    linked_at            timestamptz not null
);
create index github_installations_workspace on github_installations (workspace_id);

create table github_state (
    project_id text primary key references projects (id) on delete cascade,
    state      jsonb not null
);

-- Instance-level deliveries (to the app's webhook, taken by no project) have neither workspace nor project.
create table github_deliveries (
    seq          bigint generated always as identity primary key,
    workspace_id text references workspaces (id) on delete cascade,
    project_id   text references projects (id) on delete cascade,
    at           timestamptz not null,
    event        text,
    delivery_id  text,
    what         text,
    outcome      text not null check (outcome in ('received', 'ignored', 'refused')),
    detail       text not null
);
create index github_deliveries_project on github_deliveries (project_id, seq desc);

create table runners (
    id           text primary key,
    name         text not null,
    version      text,
    slots        integer not null,
    last_seen_at timestamptz not null
);
