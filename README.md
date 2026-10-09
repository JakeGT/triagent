# Triagent

Triagent runs [Open Code Review](https://www.npmjs.com/package/@alibaba-group/open-code-review) on your GitHub pull requests and gives people and AI agents one place to triage what it finds.

- **Automatic reviews**: through a GitHub App (or a fine-grained token), every pull request is reviewed, summarised in a comment and reported as a commit status.
- **Triage board**: filter, assign, correct ratings, mark duplicates, add notes and track the reviewer's tasks, per branch.
- **Built for agents**: an MCP server, a REST API with OpenAPI, and Markdown views, so Claude Code, Codex and others can claim and fix findings alongside people.
- **Workspaces**: a personal workspace for everyone, plus organisations, each with its own projects, members, keys and API tokens.
- **Insights**: analytics on reviews (outcomes, time, tokens and cost), the backlog, triage by people and agents, and how the model performed. Model prices come from OpenRouter's catalogue unless you set your own, and an instance admin can lend the instance's model key to chosen workspaces with a monthly token allowance.

> **Status:** early rebuild. Triagent is being rebuilt from a single-organisation prototype into a self-hostable, multi-workspace app. Nothing here is ready to run yet.

## Development

Needs Node 24 or later and pnpm.

```sh
pnpm install
TRIAGENT_ADMIN_USER=me TRIAGENT_ADMIN_PASSWORD='a long password' pnpm --filter @triagent/server dev
# http://localhost:8080 — sign in with POST /auth/login; the API is described at /api/v1/openapi.json

pnpm check        # lint, typecheck and tests
pnpm test:v1      # also run the contract suite against the server in this repository
pnpm format       # apply formatting and safe lint fixes
```

Without `DATABASE_URL` the server keeps everything in memory, which is fine for trying things out. To keep data, point it at Postgres (15 or later); it applies its migrations at start-up, or run them alone with `pnpm --filter @triagent/server migrate`:

```sh
docker run -d --name triagent-dev-pg -e POSTGRES_PASSWORD=dev -p 127.0.0.1:5432:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/postgres TRIAGENT_ADMIN_USER=me TRIAGENT_ADMIN_PASSWORD='a long password' \
  pnpm --filter @triagent/server dev
```

To run the server tests and the contract suite against Postgres too, give them a throwaway database. Each test app and contract server gets a schema of its own, dropped when it's done. Turning off `fsync` makes creating those schemas much faster:

```sh
docker run -d --rm --name triagent-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:5433:5432 postgres:16-alpine -c fsync=off
TRIAGENT_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5433/postgres pnpm test:v1
```

### The web app

The web app (`apps/web`) is a React single-page app. In production the server serves it from `apps/web/dist`; in development, Vite serves it and passes `/api`, `/auth`, `/mcp`, `/llms.txt` and `/healthz` to the server on port 8080.

```sh
# Development: the server, then Vite. PUBLIC_ORIGIN is the address in the browser; the server checks it on every write.
PUBLIC_ORIGIN=http://localhost:5173 TRIAGENT_ADMIN_USER=me TRIAGENT_ADMIN_PASSWORD='a long password' pnpm --filter @triagent/server dev
pnpm --filter @triagent/web dev
# http://localhost:5173

# Production: build once, and the server serves the app on its own port.
pnpm build:web
TRIAGENT_ADMIN_USER=me TRIAGENT_ADMIN_PASSWORD='a long password' pnpm --filter @triagent/server start
# http://localhost:8080

pnpm test:web     # unit tests (Vitest)
pnpm test:e2e     # builds the app and runs Playwright against the real server
                  # (once: pnpm --filter @triagent/web exec playwright install chromium)
```

`WEB_DIST_DIR` serves a build from another folder. Without a build, the server serves the API only.

The server fetches OpenRouter's public model catalogue (model names and prices) when someone opens the model picker, model prices or analytics, and keeps it for an hour. Set `OPENROUTER_CATALOGUE=false` to stop that request; prices can still be set by hand. The tests never reach OpenRouter.

### Reviews: the server and a runner

Reviews run in a separate process, the runner (`apps/runner`), which needs `git` and Open Code Review's `ocr` (`npm install -g @alibaba-group/open-code-review`). It shares a secret with the server and talks to it over HTTP; it has no database. In development, start both:

```sh
export TRIAGENT_RUNNER_SECRET="$(openssl rand -base64 32)"
PUBLIC_ORIGIN=http://localhost:5173 TRIAGENT_ADMIN_USER=me TRIAGENT_ADMIN_PASSWORD='a long password' pnpm --filter @triagent/server dev
TRIAGENT_SERVER_URL=http://localhost:8080 pnpm dev:runner    # in another terminal, with the same secret
```

Then connect a project to GitHub (Project settings → GitHub: the GitHub App, set up under Settings → GitHub App by an instance admin, or a fine-grained token), connect a model provider with its key and choose a model (Settings → Models), and start a review from Runs, Pull requests or Branches & reports. `apps/runner/.env.example` lists the runner's settings; `REVIEW_CONCURRENCY` (default 1) and `REVIEW_CONCURRENCY_PER_WORKSPACE` (default 1) cap reviews on the server. The tests use a fake GitHub and a fake `ocr` (`tests/fakes`), so they need `git` but nothing else.

### Model providers

Reviews can use any of these. Each workspace connects as many as it likes under Settings → Models, keeps a list of favourite models from them, and marks one the default that reviews use (an instance admin chooses one provider and model for the instance key); keys are stored encrypted, per provider, and never shown again. The model list comes from the provider itself, with your key, where it offers one; you can always type any model id. [docs/architecture.md](docs/architecture.md#model-providers) says how each is reached and where each address is documented.

| Provider | Open Code Review protocol | Address | What it needs |
|---|---|---|---|
| Anthropic | `anthropic` | `https://api.anthropic.com` | API key |
| OpenAI | `openai` or `openai-responses` | `https://api.openai.com/v1` | API key; choose Responses for models that need it |
| Google Gemini | `openai` | `https://generativelanguage.googleapis.com/v1beta/openai` | API key |
| Mistral | `openai` | `https://api.mistral.ai/v1` | API key |
| xAI | `openai` | `https://api.x.ai/v1` | API key |
| DeepSeek | `openai` | `https://api.deepseek.com` | API key |
| Cohere | `openai` | `https://api.cohere.ai/compatibility/v1` | API key |
| Moonshot AI (Kimi) | `openai` | `https://api.moonshot.ai/v1` | API key from the global site |
| Alibaba Cloud (Qwen) | `openai` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | API key for the Singapore region |
| Meta | `openai` | `https://api.meta.ai/v1` | API key |
| OpenRouter | `openai` | `https://openrouter.ai/api/v1` | API key |
| Groq | `openai` | `https://api.groq.com/openai/v1` | API key |
| Together AI | `openai` | `https://api.together.ai/v1` | API key |
| Fireworks AI | `openai` | `https://api.fireworks.ai/inference/v1` | API key |
| Amazon Bedrock | `anthropic-bedrock` | the region's `bedrock-runtime` host | AWS region, access key ID and secret access key (Anthropic models) |
| Azure OpenAI | `openai-responses` or `openai` | your resource's endpoint + `/openai/v1` | endpoint, API key; the deployment name is the model |
| Custom | `openai`, `openai-responses` or `anthropic` | the base URL you give | base URL and key (Ollama, LiteLLM, vLLM or a gateway) |

Custom and Azure addresses must use https and resolve only to public addresses, checked when saved and again when each review starts. A self-hosted instance can allow private ones (an Ollama on its own network, plain http included) with `ALLOW_PRIVATE_MODEL_URLS=true` on the server.

### Running it with Docker

One `Dockerfile` builds both images: `--target server` (the API and the web app) and `--target runner` (git and a pinned Open Code Review). [deploy/compose.example.yml](deploy/compose.example.yml) runs the server, a runner and Postgres, with secrets as files and the runner on a private network with outbound access only. Whatever proxy is in front must not pass `/internal/` (the runner API) through.

### Signing in

By default (`AUTH_MODE=local`) people sign in with a username and password. To sign in through an identity provider instead, set `AUTH_MODE=oidc` and the `OIDC_*` settings: see [docs/authentication.md](docs/authentication.md), which includes setting up Authentik. `pnpm test:e2e` covers both, the second against a fake provider.

- [docs/architecture.md](docs/architecture.md): how the server and web app are put together, workspaces and permissions, secrets, reviews and the runner (with the threat model of reviewing untrusted code), and GitHub.
- [docs/authentication.md](docs/authentication.md): signing in with passwords or an identity provider (OpenID Connect, e.g. Authentik), invites, and confirming it's you before changing secrets.
- [tests/contract](tests/contract/README.md): what any Triagent server must do.
- [skills/triagent](skills/triagent/SKILL.md): a skill that teaches agents to work through findings with the MCP tools.

## Licence

Copyright (C) 2026 Jake Talling.

Triagent is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. See [LICENSE](LICENSE). If you run a modified version as a network service, the AGPL requires you to offer its source to that service's users. Third-party software Triagent runs or includes is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
