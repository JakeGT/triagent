-- Where findings came from: for each finding on a branch, the commit that last changed its lines (Git
-- blame, asked of GitHub at the report's commit; services/origins.ts), with who wrote it, when, and the
-- pull request it came in by. Only kept for workspaces that turned this on.
--
-- An author is a name as Git has it and, where GitHub knows the account, a login. Email addresses are
-- used to match an author to a member of the workspace and are never stored.
create table finding_origins (
    workspace_id text not null references workspaces (id) on delete cascade,
    project_id   text not null references projects (id) on delete cascade,
    branch       text not null,
    finding_id   text not null,
    commit_sha   text not null,
    headline     text not null default '',
    authored_at  timestamptz not null,
    author_name  text not null,
    author_login text,
    -- The member of the workspace the author is, when one matches.
    member_id    text,
    pr_number    integer,
    pr_title     text,
    primary key (project_id, branch, finding_id)
);

-- For forgetting a workspace's when it turns this off.
create index finding_origins_workspace on finding_origins (workspace_id);

-- The last time each branch's findings were traced: how it went, and how many lines of the files
-- looked at each author last changed (so findings can be set against how much someone wrote).
create table origin_scans (
    workspace_id text not null references workspaces (id) on delete cascade,
    project_id   text not null references projects (id) on delete cascade,
    branch       text not null,
    commit_sha   text,
    status       text not null check (status in ('running', 'done', 'failed')),
    started_at   timestamptz not null,
    finished_at  timestamptz,
    files        integer not null default 0,
    traced       integer not null default 0,
    skipped      integer not null default 0,
    error        text,
    lines        jsonb not null default '{}',
    authors      jsonb not null default '{}',
    primary key (project_id, branch)
);
