# Architecture

Triagent is a TypeScript monorepo run directly by Node 24 (type stripping, so the server has no build step).

```text
packages/shared   Vocabulary and the permission table, shared by server, web app and agents
apps/server       The API, MCP endpoint and webhooks (Hono)
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
- **Not yet.** Row-level security, as a backstop to the workspace checks in the services, comes with multi-workspace hardening (Phase 7). Live updates still reach only the subscribers of the process that made the change.

## Secrets

GitHub credentials, webhook secrets and model keys are encrypted with AES-256-GCM under a key that's never stored with the data (`TRIAGENT_SECRETS_KEY_FILE`). Each is bound to its workspace, project and name as authenticated data, so a ciphertext moved elsewhere fails to decrypt. The API only says whether a secret is set, its last four characters, and who set it when.

## Live updates

`GET /api/v1/w/{workspace}/events` is a Server-Sent Events stream of "something changed" notices for that workspace only. Notices about settings, members, tokens and secrets only reach people who manage them. Clients fetch details with their own permissions.
