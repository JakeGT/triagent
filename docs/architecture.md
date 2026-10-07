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
store/*.ts         The storage interface, and an in-memory implementation (Postgres next)
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

## Secrets

GitHub credentials, webhook secrets and model keys are encrypted with AES-256-GCM under a key that's never stored with the data (`TRIAGENT_SECRETS_KEY_FILE`). Each is bound to its workspace, project and name as authenticated data, so a ciphertext moved elsewhere fails to decrypt. The API only says whether a secret is set, its last four characters, and who set it when.

## Live updates

`GET /api/v1/w/{workspace}/events` is a Server-Sent Events stream of "something changed" notices for that workspace only. Notices about settings, members, tokens and secrets only reach people who manage them. Clients fetch details with their own permissions.
