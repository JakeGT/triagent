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

When a project reviews pull requests automatically, Triagent reviews every new commit pushed to a pull request that's ready for review, and skips drafts. A review takes time and model tokens, and one that's running is never stopped, so a push during a review means the same change is reviewed twice. So:

1. Open the pull request as a **draft** (`gh pr create --draft`).
2. Push as often as you need: get the work finished and CI passing. Nothing is reviewed.
3. Mark it ready (`gh pr ready <number>`). Triagent reviews it once. `list_pull_requests` shows whether it was queued and why not if it wasn't; `list_runs` and `wait_for_run` show how it's going.
4. Don't push while its review is queued or running.
5. The findings are on the pull request's branch: pass that branch to `list_issues`, `claim_next_issue` and the rest, and work through them as in "Fix findings".
6. Before pushing fixes, make it a draft again (`gh pr ready <number> --undo`), and push them together. Mark it ready again only if the fixes are big enough to want another review.

A pull request that was already open when automatic reviews were switched on isn't reviewed until its next push: make sure that push is the one you want reviewed.

## Upload a report

After running `ocr scan` or `ocr review`, upload the JSON it wrote without pasting it into the conversation:

1. `create_upload_link` with the `branch` and `commit` (from `git rev-parse HEAD`).
2. Run the `curl` command it returns. The link works once and expires after 15 minutes.

If the branch's current report still has unresolved issues, the upload is refused unless you pass `confirm: true`; ask before replacing it.
