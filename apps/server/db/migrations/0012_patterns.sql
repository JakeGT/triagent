-- Common issues: the kinds of problem reviews keep finding in a project, each with what goes wrong and
-- how to avoid it, so that people and agents can check them before writing code (services/patterns.ts).
-- A model groups a branch's open findings under existing or new ones; people edit, hide, merge and add them.
create table patterns (
    id           text primary key,
    workspace_id text not null references workspaces (id) on delete cascade,
    project_id   text not null references projects (id) on delete cascade,
    title        text not null,
    -- What goes wrong, and how to avoid it.
    summary      text not null default '',
    guidance     text not null default '',
    category     text,
    -- Left out of what agents are told and of the page's list, but kept with its findings.
    hidden       boolean not null default false,
    -- Who made it: a model (by the name it was asked under) or a person.
    source       text not null check (source in ('model', 'person')),
    created_by   text not null,
    created_at   timestamptz not null,
    updated_by   text,
    updated_at   timestamptz not null
);

create index patterns_project on patterns (project_id);

-- The findings under each. A finding on a branch is under one at most. What it said is kept with it, so
-- a common issue still shows what it was made of once a later review no longer reports the finding.
create table pattern_findings (
    pattern_id text not null references patterns (id) on delete cascade,
    project_id text not null,
    branch     text not null,
    finding_id text not null,
    path       text not null,
    title      text not null,
    severity   text not null,
    added_at   timestamptz not null,
    primary key (project_id, branch, finding_id)
);

create index pattern_findings_pattern on pattern_findings (pattern_id);
