-- The first-run tutorial: how far each person has got through it, and the slug of their example project
-- (in their personal workspace). It's new, so everyone starts it once, accounts made before it included.
alter table users add column tutorial jsonb not null default '{"status": "pending", "step": 0, "exampleProject": null}';
