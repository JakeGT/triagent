# Architecture

Triagent is a TypeScript monorepo run directly by Node 24 (type stripping, so the server has no build step).

```text
packages/shared   Vocabulary and the permission table, shared by server, web app and agents
apps/server       The API, MCP endpoint and webhooks (Hono); serves the built web app
apps/web          The web app: React, TanStack Router and Query, shadcn/ui (built with Vite)
tests/contract    What any Triagent server must do, runnable against any implementation
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
