# Triagent

Triagent runs [Open Code Review](https://www.npmjs.com/package/@alibaba-group/open-code-review) on your GitHub pull requests and gives people and AI agents one place to triage what it finds.

- **Automatic reviews**: through a GitHub App (or a fine-grained token), every pull request is reviewed, summarised in a comment and reported as a commit status.
- **Triage board**: filter, assign, correct ratings, mark duplicates, add notes and track the reviewer's tasks, per branch.
- **Built for agents**: an MCP server, a REST API with OpenAPI, and Markdown views, so Claude Code, Codex and others can claim and fix findings alongside people.
- **Workspaces**: a personal workspace for everyone, plus organisations, each with its own projects, members, keys and API tokens.

> **Status:** early rebuild. Triagent is being rebuilt from a single-organisation prototype into a self-hostable, multi-workspace app. Nothing here is ready to run yet.

## Development

Needs Node 24 or later and pnpm.

```sh
pnpm install
pnpm check        # lint, typecheck and tests
pnpm format       # apply formatting and safe lint fixes
```

The contract tests in [`tests/contract`](tests/contract/README.md) pin down how the server must behave, and run against any server that implements their `Target` interface.

## Licence

Copyright (C) 2026 Jake Talling.

Triagent is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. See [LICENSE](LICENSE). If you run a modified version as a network service, the AGPL requires you to offer its source to that service's users. Third-party software Triagent runs is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
