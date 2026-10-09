-- 1. Tutorial example projects that were removed before removing one also cleared its analytics: forget
--    their review history and activity, so the made-up people and reviews leave Analytics.
--
--    Neither table has a foreign key to projects, so a removed project's rows are found by what its
--    activity says. A project counts as a removed example only when all of this holds:
--      - no project with that id exists any more (ids are random, so a later project never reuses one);
--      - its workspace is a personal one (the example is never made anywhere else);
--      - the log has its creation, as the tutorial writes it: kind 'project', the name "Example: Acme Shop"
--        and the id "example-acme-shop" (or "example-acme-shop-2", -3, … when that id was taken);
--      - and the log has, for the same project, something done by one of the example's made-up people
--        (never a real account: actor_user_id is null). The tutorial writes these in the same transaction
--        as the creation, so every example has them, and a real project that someone happened to give the
--        example's name and id doesn't.
--    Everything recorded for such a project goes: the example's own rows, and anything a person did in it
--    while trying things out (which is what removing an example does from now on). Rows of projects that
--    still exist, of other removed projects, and rows with no project (a workspace's own log, "project
--    deleted" included) are never matched.
with gone as (
    select distinct a.workspace_id, a.project_id
    from activity a
    join workspaces w on w.id = a.workspace_id
    where w.kind = 'personal'
      and a.project_id is not null
      and a.kind = 'project'
      and a.item_id ~ '^example-acme-shop(-[0-9]+)?$'
      and a.changes -> 'created' ->> 'name' = 'Example: Acme Shop'
      and not exists (select 1 from projects p where p.id = a.project_id)
      and exists (
          select 1 from activity e
          where e.workspace_id = a.workspace_id
            and e.project_id = a.project_id
            and e.actor_user_id is null
            and e.actor in ('Sam Lee (example)', 'Priya Shah (example)', 'CI uploads (example)', 'Open Code Review (example)')
      )
),
history as (
    delete from review_history r using gone
    where r.workspace_id = gone.workspace_id and r.project_id = gone.project_id
)
delete from activity a using gone
where a.workspace_id = gone.workspace_id and a.project_id = gone.project_id;

-- 2. Reviews have no time limit unless a project sets one. Projects whose saved automation settings still
--    hold the old defaults (45 minutes for a review and 120 for a full scan, exactly) move to no limit;
--    settings saved with any other numbers are someone's choice and stay as they are.
update settings
set value = value || '{"reviewTimeoutMinutes": null, "fullScanTimeoutMinutes": null}'::jsonb
where key = 'automation'
  and project_id is not null
  and value -> 'reviewTimeoutMinutes' = '45'::jsonb
  and value -> 'fullScanTimeoutMinutes' = '120'::jsonb;
