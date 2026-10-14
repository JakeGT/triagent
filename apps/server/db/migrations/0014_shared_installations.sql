-- A GitHub App installation can be linked to several workspaces (each by an owner of the GitHub account
-- it's on): one row per installation and workspace. Rows already here stay as they are.
alter table github_installations drop constraint github_installations_pkey;
alter table github_installations add primary key (id, workspace_id);
