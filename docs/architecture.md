# Architecture

Triagent is a TypeScript monorepo run directly by Node 24 (type stripping, so the server has no build step).

```text
packages/shared   Vocabulary and the permission table, shared by server, web app and agents
apps/server       The API, MCP endpoint and webhooks (Hono); serves the built web app; queues reviews
apps/runner       Runs Open Code Review for the server: no database, no data volume, one job's credentials at a time
apps/web          The web app: React, TanStack Router and Query, shadcn/ui (built with Vite)
tests/contract    What any Triagent server must do, runnable against any implementation
tests/fakes       A fake GitHub (API, app auth, OAuth, git over HTTP) and a fake `ocr`, for tests
```

## Server layers

```text
http/route.ts      Route declarations: method, path, scope, permission, query and body schemas
http/mount.ts      One wrapper applies authentication, CSRF, workspace isolation, permissions and validation
routes/*.ts        Declared routes, grouped by area; handlers are a few lines each
mcp/*.ts           MCP tools, declared the same way (permission + zod schema) over the same services
services/*.ts      Behaviour: accounts, projects, reports, triage, settings, secrets, webhooks, events
domain/*.ts        Pure logic: parsing reports, a branch's read model, filters, Markdown
store/*.ts         The storage interface, with Postgres and in-memory implementations
db/migrate.ts      Applies the SQL migrations in apps/server/db/migrations
```

Requests flow `route → mount wrapper → handler → service → store`. Services never see HTTP; routes never touch storage directly for writes.

## Workspaces and permissions

Everything belongs to a workspace: a person's personal workspace, or an organisation. Paths carry it: `/api/v1/w/{workspace}/p/{project}/…`.

- A person's access comes from their **role** in that workspace (viewer, editor, admin, owner).
- An API token belongs to **one workspace** and has a **scope** (read, write, upload, full, manage).
- Both map onto one table of **permissions** (`packages/shared/src/permissions.ts`). Every route and MCP tool names the permission it needs; tests fail if one doesn't.
- `secrets`, `members`, `tokens` and `workspace` are **browser-only**: no token scope includes them, so a leaked token can't escalate and secrets never pass through an agent.
- Someone without access to a workspace gets 404 for everything in it, the same as for a workspace that doesn't exist. A test calls every route as an outsider to prove it.

## Writes

Every change runs in one store transaction (`Core.write`): it's applied completely or not at all, it's recorded in the activity log (triage and content) or the audit log (people, tokens, settings, secrets), and live updates go out only after it's saved. Issues and tasks carry a `rev`; a stale one is refused with 409 and the current version. Claims are conditional on the issue still being open and unassigned.

## Storage

Services talk to one interface (`store/types.ts`), implemented twice: `PostgresStore` when `DATABASE_URL` is set, and `MemoryStore` for development and tests. `NODE_ENV=production` refuses to start without a database. The same conformance tests (`apps/server/test/store.test.ts`) run against both, and CI runs every server test and the contract suite once with each.

- **Schema.** Plain SQL migrations in `apps/server/db/migrations`, applied in order at start-up and recorded in `schema_migrations`. Each runs in its own transaction under an advisory lock, so two servers starting together apply it once, and a migration that changed after it was applied stops the server. `node apps/server/src/db/migrate.ts` runs them alone. Everything a workspace owns has a `workspace_id`, or reaches one through `project_id`, with foreign keys that delete it along with its workspace or project. The audit log has no such key, so it outlives what it records. Reports, uploads, triage notes, settings and log changes are `jsonb`.
- **Transactions.** Services read a record, decide, and write it back, relying on nothing changing in between (revision checks, claims, "re-read before saving"). The memory store gets that by running transactions one at a time. Postgres runs them concurrently at `SERIALIZABLE` isolation: a transaction that overlapped another in a way no one-at-a-time order would allow is refused (serialization failure or deadlock, or a unique key two transactions both checked was free) and run again from the start, a few times at most, after a short random wait. Callbacks must therefore be safe to re-run: anything that should happen once a change is saved, such as live updates, is registered with `store.afterCommit` and runs only after the outermost transaction commits. The current transaction travels in `AsyncLocalStorage`, so a transaction started inside another joins it, and a store call made inside a transaction uses it even when it isn't made through `tx`. A write outside any transaction is a transaction of its own.
- **Ordering.** Report versions come from a sequence, so they only go up. Activity and audit rows are listed newest first by an internal sequence number; callers page with the `id` of the last row they saw.
- **More than one process.** With Postgres, live updates (and "close these streams" when someone loses access) also go out through `LISTEN/NOTIFY`, so they reach subscribers on every server process sharing the database.
- **Not yet.** Row-level security, as a backstop to the workspace checks in the services, comes with multi-workspace hardening (Phase 7).

## Signing in

`AUTH_MODE=local` keeps usernames and scrypt-hashed passwords; `AUTH_MODE=oidc` signs people in through an OpenID Connect provider (`services/oidc.ts`, with `openid-client`), matching accounts by the provider's issuer and subject, never by email. With a provider, accounts are created on first sign-in only for invited (verified) addresses, the admin group, or the first account, and instance administrators follow the provider's admin group (`services/invites.ts`, `services/accounts.ts`). Sessions record when the person last authenticated: routes needing `secrets` also need that to be recent (`REAUTH_MINUTES`), checked once in `http/mount.ts`, and otherwise answer 401 `reauth_required`. Details, settings and an Authentik walkthrough are in [authentication.md](authentication.md).

## Secrets

GitHub credentials, webhook secrets and model keys are encrypted with AES-256-GCM under a key that's never stored with the data (`TRIAGENT_SECRETS_KEY_FILE`). Each is bound to its workspace, project and name as authenticated data, so a ciphertext moved elsewhere fails to decrypt. The API only says whether a secret is set, its last four characters, and who set it when.

## Insights: analytics, prices and allowances

- **Review history.** Every finished review is one row in `review_history`: a run on the server (recorded by the run itself, with its queue and run times), or an uploaded report (recorded by `services/reports.ts` in the upload's own transaction, from what the report says about its run: model, tokens, elapsed time, tool calls, retries, file groups it couldn't finish). Uploads by GitHub automation are server runs and aren't recorded twice. Each row also keeps the ids of the findings that review reported first (by severity), so analytics know when a finding first appeared.
- **Analytics** (`GET /api/v1/w/{workspace}/analytics?project=&branch=&days=`, MCP `get_analytics`) reads three things, each with a bound: the history (all branches, so first sightings are known; at most 20,000 rows), the activity log back to the start of the range (at most 50,000 rows), and the current reports of the branches in scope. `domain/analytics.ts` works through each list once. Ranges up to a month are counted by day (UTC), longer ones by week (starting Monday). Medians and 90th percentiles interpolate. A figure no review recorded is "not recorded", never zero. Time to resolve runs from a finding's first sighting in the history; findings first seen before the history began aren't timed.
- **Model prices** are US$ per million tokens (input, output and, optionally, cache reads). A workspace's own price (`configure`) wins over the instance's (instance admins), which wins over OpenRouter's listed price. Costs are worked out when analytics are read, so new prices apply to past reviews. Input tokens are taken to include cache reads, which are charged at the cache-read price (or the input price without one). Models without any price are listed, and their tokens left out of costs.
- **OpenRouter's catalogue** (model ids and prices, for the model picker and default prices) is fetched by the server, never the browser: an 8-second timeout, kept an hour, a failed fetch keeps the older copy and isn't retried for five minutes. `OPENROUTER_CATALOGUE=false` turns it off.
- **The instance model key.** An instance admin stores a key per provider (encrypted, `workspace_id` null) and chooses the instance's provider and model, then grants chosen workspaces a monthly token allowance (`model_grants`). `Models.forRun(workspace)` decides what a review runs with: the workspace's own key for its chosen provider; otherwise, with a grant, the instance key while this calendar month's (UTC) instance-key tokens are under the allowance; otherwise not ready, with the reason (for example, when the allowance resets). The check is made when a review starts, so the review that crosses the line finishes; `RunModel.allowance` says what's left so a run can stop sooner. Grants, keys and prices are audited; keys are never returned.

## Reviews: the queue and the runner

A review is a job in the store (`jobs`, migration 0003): queued, then claimed by a runner, then finished. `services/runs.ts` owns it.

```text
person / token / automation ──▶ POST …/reviews ──▶ jobs (queued)
                                                     │  claim (fair, capped, model ready)
runner ◀── /internal/runner/claim ──────────────────┘   job + this job's GitHub token and model key
runner ──▶ …/heartbeat, …/events (log, progress) ──▶ lease renewed, log redacted and stored (≤ 2 MB)
runner ──▶ …/finish (report) ──▶ one transaction: upload to the branch, review history, activity
                                 then (after commit): the pull request's comment and commit status
```

- **Queueing.** Each job has a key for what it reviews (`pr:12`, `changes:feature:main`, `full:main`). A newer request with the same key replaces a queued one; a request for a commit already queued or running returns that job. Starting a review checks GitHub first (the pull request is open, the branches exist, there's something to review).
- **Scheduling** happens when a runner asks for work, in one transaction: at most `REVIEW_CONCURRENCY` running on the instance (default 1) and `REVIEW_CONCURRENCY_PER_WORKSPACE` in any workspace (default 1). Workspaces take turns: the one whose last review started longest ago goes first, oldest job first within it. A job only starts when `models.forRun(workspace)` is ready; until then it waits, and the Runs page says why. The model (and whose key) is recorded on the job when it starts, and an instance allowance caps the run's `--max-tokens-budget`.
- **Leases.** A claimed job has a 60-second lease, renewed by the runner's heartbeats (every 10 seconds) and log batches. A job whose lease runs out is failed, saying the runner stopped responding; the server checks every 15 seconds and at start-up, so jobs left running by a crashed or restarted runner don't hang. A runner that lost its job gets 409 and stops. Cancelling a queued job ends it at once; cancelling a running one is passed to the runner with its next heartbeat or log batch, and it stops OCR's whole process group.
- **Finishing.** The report is uploaded to the job's branch with `services.reports.upload` as a `via: "github"` actor (so the upload isn't counted again as an uploaded review), with `confirm: true` and scope `diff` for pull requests and branch changes. The run records its own review history (`services/history.ts`, using `domain/review-metrics.ts` for tokens, tool calls and file groups, and the ids of findings it reported first). A run whose report says some file groups didn't finish is `partial`, with the files named. Failed and cancelled runs that started are recorded too, with any tokens they used.
- **Live updates.** Runs announce `run` notices (queued, started, progress at most once a second, finished) to the workspace. The web app refetches only run queries on progress, and fetches a run's log from the last line it has.

### The runner (`apps/runner`)

A separate Node process with no database driver and no data volume. It talks to the server's `/internal/runner/*` API with a shared secret (`TRIAGENT_RUNNER_SECRET`, or `_FILE`, on both sides), which is the only credential those routes accept: it's compared in constant time before the body is read, and sessions and API tokens are refused. **The reverse proxy must not expose `/internal/`**; runners reach the server on a private network.

For each job the runner:

1. fetches into a bare mirror per repository (`RUNNER_CACHE_DIR`, kept between jobs; nothing else is), with the token in an `http.<origin>/.extraHeader` set through `GIT_CONFIG_*` variables: never on a command line or in a stored remote URL. Hooks are off (`core.hooksPath=/dev/null`), submodules aren't fetched, LFS doesn't run, redirects aren't followed and only the clone URL's protocol is allowed;
2. adds a detached worktree of the commit. For a pull request or branch changes, everything that decides what OCR looks at comes from the base commit, not the change: `.opencodereview/` (or none, if the base has none), every `.gitignore` the change adds or edits (root or nested; OCR leaves out files the root one matches), the rule files the base's `rule.json` names (`"rule": "docs/review.md"`), and `.gitattributes` (checked out, and read by every git command OCR runs, with `GIT_ATTR_SOURCE`, so `-diff` or `binary` can't turn changes into "Binary files differ", which OCR skips). That needs git 2.42 or later: the runner checks `git --version` at start-up and won't start with an older one;
3. runs `ocr review --from <merge base> --to <head>` (or `ocr scan`) with an environment built from an allowlist: a throwaway `HOME`, `OCR_CONFIG_PATH` pointing at a file that doesn't exist, `OCR_NO_UPDATE=1`, the model's URL, key and name, and git settings that keep hooks off. Nothing else from the runner's environment, so never telemetry settings (`OCR_ENABLE_TELEMETRY`, `OTEL_*`) or `ANTHROPIC_*`;
4. streams OCR's stderr as log lines and progress (phase, files, file groups, round, tool calls), enforces the project's time limit, and on cancel or timeout kills the process group;
5. deletes the worktree and the job's home directory, and reports the outcome (retrying for a while if the server is briefly away).

`RUNNER_CONCURRENCY` (default 1) is how many jobs one runner works on at once.

### Reviewing untrusted code: the threat model

A pull request's code is untrusted, and an LLM agent reads it. What it could try, and what stops it:

- **Run commands.** OCR's agent has only read-only tools confined to the repository (`file_read`, `file_read_diff`, `file_find`, `code_search` via git grep with traversal checks, `code_comment`, `task_done`): no shell. MCP servers and setup commands come only from OCR's user config, which the runner never provides (throwaway `HOME`, `OCR_CONFIG_PATH` to a missing file). Git hooks, filters, `fsmonitor` and submodules are off in every git command the runner or OCR runs.
- **Hide its own changes.** OCR reads `<repo>/.opencodereview/rule.json` to decide what to include, exclude and focus on (and the files of instructions its rules name), leaves out files the root `.gitignore` matches, and skips files git calls binary, which `.gitattributes` decides. A pull request could add or change any of these to keep what it changes out of the review, so changes under review always get the base commit's: the runner puts them back as the base has them (removing what the base doesn't have, and never writing through a link the change added), and OCR's git reads attributes from the base. The change's own versions of these files are still in the diff, so they're reviewed like anything else. Full scans use the branch's own (they're requested by someone with `operate`, usually of the default branch).
- **Steal credentials.** The runner holds only the job's GitHub token (an installation token narrowed to the one repository with `contents: read`, or the project's fine-grained token) and the model key, in memory, for that job. OCR never sees the GitHub token. The server redacts both (and their encoded forms) from every log line and error before storing or broadcasting it; the runner does the same before sending.
- **Prompt injection.** Findings and their text come from the model and are untrusted: the web app renders them as text or sanitised Markdown, and the pull request comment escapes everything untrusted in it (finding titles, file names, OCR's warnings): every Markdown character is escaped, and mentions, `#12` and `owner/repo#12` references and bare addresses are broken up with a zero-width space, so there are no links but Triagent's own, no mentions and no HTML. A test renders the comment with a CommonMark and GFM renderer to check.
- **Exhaust resources.** Each review has a time limit and an optional token budget; logs are capped at 2 MB per job; reports at 25 MB. The runner container has no inbound access, memory and process limits, and a read-only root (see `deploy/compose.example.yml`).
- **Reach the server.** The runner can only call the four runner routes, and only for jobs it holds.

The separate runner process (and container) remains as defence in depth: it has no database access and nothing to steal beyond the job in hand.

## GitHub

`services/github/` connects a project to its repository in one of two modes, behind one interface (`githubFor(project) → { client, repo, cloneUrl, tokenForJob() }`), with a small fetch-based REST client (no Octokit: a dozen calls don't justify the dependency).

- **The GitHub App (primary).** An instance admin creates it from Instance → GitHub App with GitHub's manifest flow (permissions: contents read, pull requests and commit statuses write; events: pull requests, pushes, branch creation and deletion; "request user authorization during installation" on). Its id, keys, client secret and webhook secret are stored as encrypted instance secrets (`workspace_id` null), and creating or removing it needs a recent sign-in. The server signs RS256 JWTs with `node:crypto` and mints installation tokens, narrowed to the one repository (and, for a review's `git fetch`, to `contents: read`), cached until five minutes before they expire.
- **Installing into a workspace.** A workspace admin (`secrets`) starts the installation with a signed, expiring `state` bound to them and the workspace. On the way back the bare `installation_id` isn't trusted: the state must be genuine and theirs, they must still manage the workspace's secrets, and GitHub must confirm — by exchanging the user authorization code and listing `GET /user/installations` with their own token — that their account can see that installation. An installation already linked to another workspace isn't moved. Installations are kept in `github_installations`; each project then picks a repository from its workspace's installations.
- **One app webhook** (`POST /api/v1/github/app/webhook`), checked against the app's webhook secret, routed by installation (to the workspace that linked it) and repository id (to the projects using that repository). Installation events keep the table current (removed, suspended).
- **A fine-grained token (fallback)**, stored encrypted on the project, with the project's own webhook (`/api/v1/github/webhook/{webhookId}`, its own secret).
- **Automatic reviews** (`services/github/automation.ts`): with automation on, open pull requests are checked on webhook events or every `pollMinutes`, and each new head commit is queued (not drafts, and not a commit whose review failed or was cancelled until someone asks again). Switching automation on sets a baseline: pull requests already open are listed but not reviewed until someone clicks Review now or pushes. Each check records, per pull request, why it was or wasn't queued; the last 50 webhook deliveries per project are kept (`github_deliveries`). A nightly full scan of the default branch runs at `nightlyHourUtc`. With Postgres, one server process polls (an advisory lock held on a connection of its own).
- **Branch sync** lists the repository's branches: reports whose branch has moved on are marked out of date, with "N commits behind" from the compare API (at most 25 compares per sync, cached); branches on GitHub without a report are listed; and with `archiveDeletedBranches`, a branch deleted on GitHub has its report archived (never the default branch).
- **After a review** of a pull request, Triagent keeps one comment on it and sets a commit status named "Triagent": pending while queued and running, then success, failure (with `failOnCritical`, when there are critical findings) or error. The comment is the one Triagent wrote: remembered by id with the project's GitHub state, or else found by the hidden marker it starts with, but only among comments by Triagent's own account (the app's `<slug>[bot]`, or the token's owner from `GET /user`). Anyone can write the marker in a comment of their own; Triagent never edits those.

## Live updates

`GET /api/v1/w/{workspace}/events` is a Server-Sent Events stream of "something changed" notices for that workspace only. Notices about settings, members, tokens and secrets only reach people who manage them. Clients fetch details with their own permissions.

## Web app

`apps/web` is a single-page app built with Vite. The server serves the build (`http/static.ts`): only files that exist in it, fingerprinted assets cached for a year, and `index.html` for the app's own routes (`/w/{workspace}/p/{project}/issues?branch=main`). Without a build the server still serves the API.

```text
src/router.tsx       Every page and its URL; filters and the branch live in the query string
src/lib/api.ts       The one fetch layer: CSRF token on writes, a per-tab client id, typed errors (409 carries `current`)
src/lib/queries.ts   Query keys nested workspace → project → branch, and a query for each read
src/lib/live.ts      One EventSource per workspace; each notice invalidates the keys it touches
src/lib/session.ts   Who's signed in, and what their role allows, from packages/shared's permission table
src/components/reauth-dialog.tsx   "Confirm it's you" before steps that need a recent sign-in; retries the step
src/features/*       Pages: issues, tasks, overview, files, branches, compare, activity, agents, settings
src/components/*     Shared pieces: SecretField, OneTimeReveal, ConfirmAction, notes, Markdown, code diffs
```

- **Server state** is TanStack Query's cache; nothing polls. A live notice from another tab or agent invalidates the queries it affects. Notices carrying this tab's client id are our own changes, already applied.
- **Never clobber input.** A form being edited, or an issue with a note half-typed, holds still when the server's copy changes and shows a "changed elsewhere" banner instead (`lib/drafts.ts`). Writes send the `rev` that was on screen; a 409 shows what the other person changed.
- **Gating** uses the same permission table as the server, so the app hides what someone can't do and shows read-only settings as such. The server enforces it either way.
- **Content Security Policy.** The app runs under the server's policy (`script-src 'self'; style-src 'self'`, no `unsafe-inline`): no inline script (the theme is applied before first paint by `public/theme-init.js`), sonner's stylesheet imported statically instead of injected, Radix's scroll lock given constructed stylesheets (`lib/style-singleton.ts`) instead of `<style>` elements, fonts self-hosted, no component that renders `<style>`, and charts drawn in plain HTML and SVG (`components/charts.tsx`) rather than with a library that injects styles. Each chart has a text summary, a legend for more than one series and a table view. An end-to-end test fails on any violation.
- **Secrets** shown once (new API tokens, webhook secrets, generated passwords) live only in the state of the page that asked for them, never in the query cache, and are dropped on navigation.
