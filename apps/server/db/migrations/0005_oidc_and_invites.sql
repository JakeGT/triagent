-- Signing in through an identity provider (AUTH_MODE=oidc): when each session last proved who it is, for
-- steps that need a recent sign-in, and the provider's ID token, used only as the hint when signing out.
alter table sessions add column auth_at bigint;
update sessions set auth_at = created_at;
alter table sessions alter column auth_at set not null;
alter table sessions add column id_token text;

-- Invitations by email address: an instance invite lets someone create an account by signing in; a
-- workspace invite also adds them to that workspace with a role. created_by and accepted_by have no
-- foreign key, so an invite's history outlives the people in it.
create table invites (
    id           text primary key,
    email        text not null check (email = lower(email)),
    workspace_id text references workspaces (id) on delete cascade,
    role         text check (role in ('viewer', 'editor', 'admin', 'owner')),
    created_by   text,
    created_at   timestamptz not null,
    expires_at   timestamptz not null,
    accepted_at  timestamptz,
    accepted_by  text,
    check ((workspace_id is null) = (role is null))
);
-- At most one open invite per address and workspace (or for the instance).
create unique index invites_open on invites (email, workspace_id) nulls not distinct where accepted_at is null;
create index invites_workspace on invites (workspace_id, created_at desc);
