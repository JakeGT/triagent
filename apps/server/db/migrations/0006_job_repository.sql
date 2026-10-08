-- The repository a review was queued for (GitHub's id, when known, and owner/name), so a review only ever
-- starts on, and reports to, that repository, even if its project is pointed at another meanwhile.
alter table jobs add column repository jsonb;
