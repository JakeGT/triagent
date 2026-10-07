# Contract tests

These tests describe what a Triagent server must do: who may do what, how reports are uploaded and compared, how triage carries over and reopens, how claims and revisions keep agents from colliding, and how webhooks and MCP behave. They're written against operations (`upload`, `claimNext`, `updateIssue`…) rather than URLs, through the `Target` interface in [`harness/types.ts`](harness/types.ts), so the same tests run against:

| Target | What it is |
|---|---|
| `legacy` | The prototype Triagent is being rebuilt from. It isn't in this repository. |
| *(to come)* | The rebuilt server, once its API exists. |

Each test file starts its own server on a free port with a throwaway data folder, and nothing reaches GitHub, the GitHub CLI or an LLM.

## Running

```sh
# Against the prototype (point LEGACY_APP_DIR at the folder that has its server.mjs):
LEGACY_APP_DIR=../path/to/prototype pnpm test:legacy

# Without a target, the suites report as skipped (this is what CI does for now):
pnpm test
```

## Known gaps

A test the prototype is known to fail is marked with `knownGap("legacy", reason)`. It still runs there and is reported as **todo**, and it must pass on every other target.

| Test | Gap in the prototype |
|---|---|
| A finding can be added by hand to a branch with no report yet | The route looks the branch up first and answers 404 |

## Adding a target

Implement `Target` (one method per operation, returning `{ status, body }`), register it in `TARGETS` in [`harness/index.ts`](harness/index.ts), and run with `TRIAGENT_CONTRACT_TARGET=<name>`.
