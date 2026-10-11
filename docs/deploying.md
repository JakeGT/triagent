# Deploying without interrupting anything

A new version can replace the one that's running while reviews are in progress: nobody's review is cancelled and no request is dropped. This is what makes that so, and what a deployment has to do to use it. [deploy/compose.example.yml](../deploy/compose.example.yml) is a single-server starting point; the steps here are for when you'd rather not wait for a quiet moment.

## The runner: drain, then replace

- **The first stop signal drains.** On `SIGTERM` (or `SIGINT`) a runner stops asking for work, finishes the reviews it has, however long they take, tells the server how they ended, and exits. A runner with nothing in hand exits at once.
- **A second signal cancels**, as stopping always used to: the reviews are stopped and reported as stopped. `RUNNER_STOP=cancel` makes the first signal do that.
- **While draining it says so.** The server counts it as having no room, and Settings → Instance → Reviews and the Runs page show it as finishing its reviews.
- **Start the new runner beside the old one.** It takes whatever is queued at once. Runners can share a cache volume: fetches into one repository's mirror are locked on disk.

Whatever stops the runner must give it the time. `docker stop` kills after ten seconds unless told otherwise, so give the runner a long `stop_grace_period` in Compose (or `docker stop -t`), longer than your longest review.

## The server: two, one after the other

- **Run the new server beside the old one**, on the same database, and move traffic over once its `/healthz` answers. A reverse proxy with health-checked upstreams (Caddy, say) does the switch; live-update streams reconnect by themselves.
- **Background work doesn't double up.** Polling GitHub, scheduled scans and the sweep for abandoned reviews take a lock in the database, so two servers running for a few seconds do them once.
- **Start-up grace.** For one lease period (a minute) after it starts, a server doesn't give up a review whose runner it hasn't heard from: the runner may only have been unable to reach it during the switch.
- **An old runner can finish against a new server.** The server keeps understanding the previous release's runner messages (a test replays them), so the runner being drained needn't be on the new version.

## Migrations that overlap safely

Both servers run for a few seconds, the old one on the new one's schema. So a migration must leave the previous release working:

- **Add first, remove later.** New tables, new columns with a default (or nullable), new indexes: fine. Dropping or renaming a column, or tightening a constraint the old version breaks: in a later release, once nothing running uses it.
- CI checks this ("Previous release on the new schema"): when a pull request changes the migrations, the base branch's server tests run against the pull request's schema.

Migrations are forward-only. Back the database up before a release that has one; rolling back past it means restoring that backup.

## In short

1. Build the new images. Back up the database if the release has a migration.
2. Start the new server; wait for its health check; send traffic to it; stop the old one.
3. Start the new runner; send the old one `SIGTERM` and let it finish.

To roll back, do the same with the previous images (unless a migration was applied: then see above).
