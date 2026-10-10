---
name: triagent
description: Work through Open Code Review findings tracked in Triagent. Use when asked to fix code review findings, triage issues, claim the next issue, upload an OCR report, open a pull request that Triagent will review, or check what's left to fix in this repository.
---

# Triagent

Triagent tracks Open Code Review (OCR) findings per project and branch, shared by people and agents. You reach it through the `triagent` MCP server, with an API token that belongs to one workspace.

## Find the project

1. Run `git remote get-url origin` and `git branch --show-current`.
2. Call `list_projects` and pick the project whose repository matches the remote. Pass its id as `project`, and the current branch as `branch`, to every other tool.
3. If no project matches, say so and stop. Don't guess.

## Fix findings

1. `claim_next_issue` (optionally with `severity`, `path` or `task` filters). It gives you the most urgent open, unassigned issue and marks it in progress for you; other agents won't get it.
2. Read the finding, its code and notes in the result. Use `get_issue` for anything else.
3. Fix it in the code. Run the project's tests.
4. `update_issue` with `status: "resolved"`, the `rev` you were given, and a `note` saying what you changed and in which commit.
5. If you can't or shouldn't fix it, `release_issue` with a note explaining why, or `update_issue` with `status: "wont_fix"` and the reason, if it's a false positive.

Rules:

- Never fix an issue flagged `needsDiscussion`; a person decides those first.
- If `update_issue` says someone else changed the issue, read the current version it returns before trying again.
- If the reviewer's rating is wrong, correct it with `severity` or `category` and a note; the original is kept.
- Several findings fixed by one commit: `bulk_update_issues`.
- Reviews run with several models say which found each finding ("found by"). To start with the ones they agree on, pass `foundBy: 2` to `claim_next_issue` or `list_issues`.

## Get a pull request reviewed

When a project reviews pull requests automatically, Triagent reviews each pull request **once by itself**: when it's ready for review (not a draft) and the checks on its head commit have passed. Pushes after that are **not reviewed until someone asks**. A review takes time and model tokens, and one that's running is never stopped.

1. Open the pull request and get its checks passing. A draft is never reviewed by itself, so open it as a draft (`gh pr create --draft`) if you want to choose the moment, and mark it ready (`gh pr ready <number>`) when the work is finished.
2. The first review starts by itself once it's ready and its checks are green. `list_pull_requests` shows where it is and why ("waiting for 2 of 4 checks", "checks failed", "skipped: opened by a bot"); `list_runs` and `wait_for_run` show how the review is going.
3. The findings are on the pull request's branch: pass that branch to `list_issues`, `claim_next_issue` and the rest, and work through them as in "Fix findings".
4. Push your fixes as often as you like. They aren't reviewed, and `list_pull_requests` says how many commits there have been since the review.
5. When the fixes are big enough to want another review, ask for one, in any of these ways:
   - `start_review` with `kind: "pr"` and the pull request's number;
   - a comment on the pull request whose first line starts with `/review` (from someone with write access to the repository);
   - the label `review` on the pull request (Triagent takes it off once the review is queued).

Asking works at any time: for a draft, with checks still running or failed, and for pull requests Triagent skips by itself (opened by a bot, labelled `skip-review`, touching only files the project doesn't review, or already open when automatic reviews were switched on).

Don't ask while a review of the same pull request is queued or running unless you want another: the new one waits for it and then runs as well. A rebase or a merge from the base that leaves the same changes isn't reviewed again, and needn't be asked for.

## Upload a report

After running `ocr scan` or `ocr review`, upload the JSON it wrote without pasting it into the conversation:

1. `create_upload_link` with the `branch` and `commit` (from `git rev-parse HEAD`).
2. Run the `curl` command it returns. The link works once and expires after 15 minutes.

If the branch's current report still has unresolved issues, the upload is refused unless you pass `confirm: true`; ask before replacing it.

## Choose a review's models

`start_review` runs with the project's models for that kind of review (pull request, branch changes, full scan), which fall back to the project's models, then the workspace's default. To use others for one review, pass `models`: up to five ids from `list_models`, in order (they review at the same time; the first one's wording leads when findings are merged). `get_run` shows each model's own progress while it runs (`progress.models`) and how each ended (`result.models`, with `reason` `stalled`, `timeLimit` or `overBudget` for one that was stopped). `list_models` lists the workspace's favourite models, which is the default and whether each is ready, and with `project` what each kind of review of it uses. Only choose models when asked to: each one spends its own tokens.

## Options for reviews with several models

A review with two or more models can be given `options` in `start_review`. Each is off unless you pass it, and without `options` at all the project's own apply; a review with one model takes none. Only use them when asked to.

- `agreement: { failAt: 2 }`: the pull request's check fails only for critical findings at least that many of the models found (2 up to the number of models). Every finding is still listed.
- `agreement: { markSingles: true }`: findings only one model found are marked `lowerConfidence` and listed after the others of their severity. Pass `lowerConfidence: false` to `list_issues` or `claim_next_issue` to leave them for later, or `true` to see only them.
- `retryFailed: true`: a model that fails or goes quiet is run once more by itself, and its findings are added to the report.

To do that by hand after a review, `get_run` lists the models that didn't finish (`rerunnable`) and `rerun_model` with the run's `id` and the model's label runs one again. Triage already done on the branch is kept. It's refused once the branch has a newer report.
