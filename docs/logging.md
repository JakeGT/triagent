# Logs and error reporting

What Triagent writes to its logs, and how to have its errors reported to [Sentry](https://sentry.io). Reporting is off unless you turn it on: without `SENTRY_DSN`, nothing described under "Reporting to Sentry" runs, and nothing leaves your instance.

## Logs

The server and the runner write one line for each thing worth knowing, to standard output (errors and warnings to standard error), so `docker logs` or whatever collects your containers' output has them.

```
2026-10-11T08:00:36.667Z INFO  Request request=Vy4fNFxQvJR9 method=POST route="/api/v1/w/{workspace}/p/{project}/reports" user=1HH17UrYok4y workspace=acme project=app path=/api/v1/w/acme/p/app/reports status=200 ms=2
2026-10-11T08:00:41.102Z INFO  Review started run=job-8f2c project=app runner=runner-1 models=3 waited=4
2026-10-11T08:02:10.554Z WARN  Couldn't read a project's open pull requests from GitHub: GitHub answered 502 project=app
2026-10-11T08:03:00.010Z ERROR Request failed: x is not a function request=EzDkHlbkPFmN method=GET route=/api/v1/me
    at …
```

A line is the time, a level, a message that is always the same for the same event, and named fields with what varies. So `grep "Review finished"` finds every review that ended, and `grep request=EzDkHlbkPFmN` everything that happened while answering one request.

| Setting | Default | |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`: the least serious lines to print. |
| `LOG_FORMAT` | `text` | `text` (as above), or `json` for one JSON object a line, for a log collector. |

Both apply to the server and to the runner.

**Levels.** `error` is something that shouldn't happen and that someone should look at: it's printed with its stack. `warn` is something that went wrong but is expected now and then, usually because another service was away or said no (GitHub, the identity provider, a model provider), or a sign-in was refused. `info` is the ordinary course of things. `debug` adds what is asked for every few seconds: health checks, runners asking for work, the web app's files.

**What's logged.**

- Every request: its method, path, status, how long it took, and whose it was (the account's id). Each has an id, sent back as `X-Request-Id`; when a request fails on the server, the id is also in the answer (`requestId`) and the web app shows it as a reference to quote.
- A review's life: queued, started (and on which runner), each model's Open Code Review process starting and ending on the runner, finished (and how), cancelled, abandoned because its runner stopped answering.
- Runners connecting, and being refused for a wrong secret.
- Signing in and out, and refused sign-ins.
- What Triagent does on GitHub's behalf, and every time GitHub or a model provider can't be reached.
- Starting and stopping, and anything wrong with the configuration.

**What never is.** A finding's text, a diff, a file's contents, a review's own log (that is kept with the review, for the people who may see it), request and response bodies, passwords, tokens, keys and cookies. On top of that, every line is cleaned before it's printed: credentials of known shapes (GitHub tokens, `Authorization` headers, URLs with a token in them) are replaced with `[redacted]` wherever they turn up, and a field named for a credential is never printed, whatever is in it. A failed sign-in is logged with the address it came from but not the username typed, since people type their password into that box often enough.

## Reporting to Sentry

Set `SENTRY_DSN` on the server to a Sentry project's DSN (Project settings → Client Keys). Then:

- **Errors** (every `error` line) become issues, with the stack, the request they belong to and the account's id.
- **Log lines** at `info` and above are sent as logs, with their fields, so they can be searched next to the issues.
- **The runner** reports through the server: it passes its own log lines (never a review's) to the server with the runner secret, and the server sends them on. The runner has no DSN and needs no way out to Sentry.
- **The web app** reports faults in the browser (an exception nothing caught, a page that failed to render). It sends them to its own server (`POST /api/v1/telemetry`), which passes them on, so the Content Security Policy stays as strict as it was (`connect-src 'self'`). The app's reporting code is only downloaded when reporting is on.
- **Traces**, if you ask for them (`SENTRY_TRACES_SAMPLE_RATE`): how long requests took and what they waited on (the database, GitHub, a model provider).

| Setting (server) | Default | |
|---|---|---|
| `SENTRY_DSN` (or `SENTRY_DSN_FILE`) | none | The project the server and the runners report to. Unset: no reporting at all. |
| `SENTRY_BROWSER_DSN` | the same as `SENTRY_DSN` | A project of its own for the web app, if you'd rather keep browser faults apart. |
| `SENTRY_BROWSER` | `true` | `false` leaves the web app out. |
| `SENTRY_LOGS` | `true` | `false` sends errors only, not log lines. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | The share of requests to trace, from `0` to `1`. `0.1` is plenty for a small instance. |
| `SENTRY_ENVIRONMENT` | `production` or `development`, from `NODE_ENV` | |
| `TRIAGENT_VERSION` | set in the images when built with `--build-arg TRIAGENT_VERSION=…` | The release named on everything reported. |

| Setting (runner) | Default | |
|---|---|---|
| `RUNNER_RELAY_LOGS` | `true` | `false` keeps the runner's lines on the runner. (They're only passed on anyway when the server has a DSN.) |

The server must be started with its `instrument.ts` loaded first, as the image does: `node --import ./apps/server/src/instrument.ts apps/server/src/main.ts` (`pnpm --filter @triagent/server start`). Started without it, the server works but reports nothing.

### What is sent, and what isn't

Sent: the error and its stack, with a few lines of **Triagent's own source** around each frame; the method and path of the request; the account's id; workspace and project slugs, review ids, repository names and branch names where a log line carries them; the names of database tables and the shape of queries in traces. From the browser, also which browser it was and the paths of the requests leading up to the fault.

Never sent: cookies, headers, request and response bodies, query strings (where search text and sign-in codes travel), the values in a database query, the variables on the stack, anyone's name, email address, username or IP address, what was clicked, or any recording of the page. Everything that is sent goes through the same cleaning as the logs, and once more on its way out.

Since a log line never holds the code under review or what a model said about it, neither does anything sent to Sentry. If that ever turns out not to be so, it's a bug: please report it (see [SECURITY.md](../SECURITY.md)).

In Sentry itself, it's worth turning on "Prevent Storing of IP Addresses" (Project settings → Security & Privacy): Sentry otherwise records the address a report arrived from, which for the web app's reports is your server's.

### Source maps for the web app

The built web app is minified, so a browser fault's stack is hard to read without its source maps. To have them, give the image build somewhere to send them:

```sh
docker build --target server -t triagent-server:1f0f033 \
    --build-arg TRIAGENT_VERSION=1f0f033 \
    --build-arg SENTRY_ORG=your-org --build-arg SENTRY_PROJECT=your-web-project \
    --secret id=sentry_auth_token,src=secrets/sentry_auth_token .
```

The token is an organisation auth token from Sentry (Settings → Auth Tokens), given as a build secret so it isn't kept in the image. The maps are uploaded and then deleted from the build: they're never served. Without the three settings the build makes no source maps at all, as before.

### When an error repeats

An outage repeats the same error for as long as it lasts. Each is still a log line, but the same error becomes an issue event at most once a minute, so a bad hour doesn't use up a month's quota.
