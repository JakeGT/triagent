-- A runner that is finishing the reviews it has before it stops (a deploy replacing it) says so, so that
-- it isn't counted as having room, and the Runs page can show it. Added with a default: a server from
-- before this, running beside a new one for the moments a deploy overlaps, never mentions the column.
alter table runners add column draining boolean not null default false;
