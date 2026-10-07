-- The first schema: one table per record in src/store/types.ts.
--
-- Everything a workspace owns either has a workspace_id or reaches one through project_id, and goes when
-- its workspace or project is deleted. The audit log has no foreign key, so it outlives what it describes.
-- Timestamps the app shows are timestamptz; session and upload-link times are epoch milliseconds, as the
-- app keeps them. Row-level security comes later (multi-workspace hardening).

create table users (
    id                   text primary key,
    username             text,
    display_name         text not null,
    email                text,
    password_hash        text,
    must_change_password boolean not null default false,
    is_instance_admin    boolean not null default false,
    issuer               text,
    subject              text,
    notify               jsonb not null,
    created_at           timestamptz not null,
    last_login_at        timestamptz
);
-- Usernames are looked up ignoring case, and two accounts can't differ only in case.
create unique index users_username on users (lower(username));
create unique index users_identity on users (issuer, subject) where issuer is not null;

create table workspaces (
    id         text primary key,
    slug       text not null unique,
    name       text not null,
    kind       text not null check (kind in ('personal', 'org')),
    created_at timestamptz not null
);

create table memberships (
    workspace_id text not null references workspaces (id) on delete cascade,
    user_id      text not null references users (id) on delete cascade,
    role         text not null check (role in ('viewer', 'editor', 'admin', 'owner')),
    created_at   timestamptz not null,
    primary key (workspace_id, user_id)
);
create index memberships_user on memberships (user_id);

create table sessions (
    id_hash      text primary key,
    user_id      text not null references users (id) on delete cascade,
    csrf         text not null,
    credential   text,
    created_at   bigint not null,
    last_seen_at bigint not null
);
create index sessions_user on sessions (user_id);
create index sessions_last_seen on sessions (last_seen_at);
create index sessions_created on sessions (created_at);

create table api_tokens (
    id            text primary key,
    workspace_id  text not null references workspaces (id) on delete cascade,
    -- A token never outlives the person it acts for.
    owner_user_id text references users (id) on delete cascade,
    name          text not null,
    scope         text not null check (scope in ('read', 'write', 'upload', 'full', 'manage')),
    hash          text not null unique,
    prefix        text not null,
    created_at    timestamptz not null,
    created_by    text not null,
    expires_at    timestamptz,
    last_used_at  timestamptz
);
create index api_tokens_workspace on api_tokens (workspace_id);
create index api_tokens_owner on api_tokens (owner_user_id);

create table projects (
    id             text primary key,
    workspace_id   text not null references workspaces (id) on delete cascade,
    slug           text not null,
    name           text not null,
    repo_url       text,
    default_branch text not null,
    webhook_id     text not null unique,
    created_at     timestamptz not null,
    unique (workspace_id, slug)
);

-- Every write takes the next value, so a branch's version only goes up, even across deletes.
create sequence report_versions;

create table reports (
    project_id text not null references projects (id) on delete cascade,
    branch     text not null,
    report     jsonb not null,
    upload     jsonb not null,
    version    bigint not null default nextval('report_versions'),
    primary key (project_id, branch)
);

create table report_archive (
    seq         bigint generated always as identity primary key,
    project_id  text not null references projects (id) on delete cascade,
    branch      text not null,
    report      jsonb not null,
    upload      jsonb not null,
    archived_at timestamptz not null,
    reason      text not null check (reason in ('replaced', 'deleted')),
    triage      jsonb
);
create index report_archive_branch on report_archive (project_id, branch, archived_at desc, seq desc);

create table triage (
    project_id       text not null references projects (id) on delete cascade,
    branch           text not null,
    kind             text not null check (kind in ('issue', 'task')),
    item_id          text not null,
    status           text not null check (status in ('open', 'in_progress', 'resolved', 'wont_fix')),
    assignee         text,
    severity         text,
    category         text,
    duplicate_of     text,
    needs_discussion boolean not null default false,
    notes            jsonb not null default '[]',
    rev              integer not null,
    updated_at       timestamptz,
    updated_by       text,
    primary key (project_id, branch, kind, item_id)
);

-- Logs are listed newest first by seq; `id` is the cursor callers page with.
create table activity (
    seq           bigint generated always as identity primary key,
    id            text not null unique,
    workspace_id  text not null references workspaces (id) on delete cascade,
    -- No foreign key: a deleted project's history stays in its workspace's log.
    project_id    text,
    branch        text,
    at            timestamptz not null,
    actor         text not null,
    actor_user_id text,
    via           text not null,
    kind          text not null,
    item_id       text not null,
    changes       jsonb not null
);
create index activity_workspace on activity (workspace_id, seq desc);
create index activity_project on activity (project_id, seq desc);
create index activity_branch on activity (project_id, branch, seq desc);

create table audit (
    seq           bigint generated always as identity primary key,
    id            text not null unique,
    workspace_id  text,
    at            timestamptz not null,
    actor         text not null,
    actor_user_id text,
    via           text not null,
    kind          text not null,
    target        text not null,
    changes       jsonb not null,
    ip            text
);
create index audit_workspace on audit (workspace_id, seq desc);

create table upload_links (
    hash       text primary key,
    project_id text not null references projects (id) on delete cascade,
    params     jsonb not null,
    expires_at bigint not null
);
create index upload_links_project on upload_links (project_id);
create index upload_links_expiry on upload_links (expires_at);

-- Instance-wide secrets have no workspace, workspace-wide ones no project.
create table secrets (
    workspace_id text references workspaces (id) on delete cascade,
    project_id   text references projects (id) on delete cascade,
    name         text not null,
    sealed       text not null,
    hint         text not null,
    set_by       text not null,
    set_at       timestamptz not null,
    unique nulls not distinct (workspace_id, project_id, name)
);
create index secrets_project on secrets (project_id);

create table settings (
    workspace_id text not null references workspaces (id) on delete cascade,
    project_id   text references projects (id) on delete cascade,
    key          text not null,
    value        jsonb not null,
    unique nulls not distinct (workspace_id, project_id, key)
);
create index settings_project on settings (project_id);
