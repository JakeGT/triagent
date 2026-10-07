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

## Web app

`apps/web` is a single-page app built with Vite. The server serves the build (`http/static.ts`): only files that exist in it, fingerprinted assets cached for a year, and `index.html` for the app's own routes (`/w/{workspace}/p/{project}/issues?branch=main`). Without a build the server still serves the API.

```text
src/router.tsx       Every page and its URL; filters and the branch live in the query string
src/lib/api.ts       The one fetch layer: CSRF token on writes, a per-tab client id, typed errors (409 carries `current`)
src/lib/queries.ts   Query keys nested workspace → project → branch, and a query for each read
src/lib/live.ts      One EventSource per workspace; each notice invalidates the keys it touches
src/lib/session.ts   Who's signed in, and what their role allows, from packages/shared's permission table
src/features/*       Pages: issues, tasks, overview, files, branches, compare, activity, agents, settings
src/components/*     Shared pieces: SecretField, OneTimeReveal, ConfirmAction, notes, Markdown, code diffs
```

- **Server state** is TanStack Query's cache; nothing polls. A live notice from another tab or agent invalidates the queries it affects. Notices carrying this tab's client id are our own changes, already applied.
- **Never clobber input.** A form being edited, or an issue with a note half-typed, holds still when the server's copy changes and shows a "changed elsewhere" banner instead (`lib/drafts.ts`). Writes send the `rev` that was on screen; a 409 shows what the other person changed.
- **Gating** uses the same permission table as the server, so the app hides what someone can't do and shows read-only settings as such. The server enforces it either way.
- **Content Security Policy.** The app runs under the server's policy (`script-src 'self'; style-src 'self'`, no `unsafe-inline`): no inline script (the theme is applied before first paint by `public/theme-init.js`), sonner's stylesheet imported statically instead of injected, Radix's scroll lock given constructed stylesheets (`lib/style-singleton.ts`) instead of `<style>` elements, fonts self-hosted, and no component that renders `<style>`. An end-to-end test fails on any violation.
- **Secrets** shown once (new API tokens, webhook secrets, generated passwords) live only in the state of the page that asked for them, never in the query cache, and are dropped on navigation.
