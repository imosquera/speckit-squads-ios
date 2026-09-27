---
description: "Open a GitHub PR for the current feature branch, auto-appending Closes #N from .specify/feature.json when source_issue is set, copying the issue's labels onto the PR and stamping the agent session that produced it; --draft opens it as a draft and leaves the issue open"
---

# Create PR for Current Feature

Open a GitHub pull request from the current feature branch into `main` (or another base passed as an argument). If `.specify/feature.json` carries a `source_issue` field — written by `/speckit-git-feature` when it created or was bound to a GitHub issue — the PR body will include a `Closes #N` line so merging the PR automatically closes that issue. `source_issue` is the only field this command reads; every part of the feature's identity — branch, number, spec directory, worktree path — is derived from git at read time, never from that file (issue #33), including the `feature_directory` key core Spec Kit keeps there for its own resolver.

The PR also inherits the tracking issue's **labels** (priority, kind, layer — whatever `/speckit-git-issue` applied), minus `autopilot:*` run-state, and carries an **Agent session** footer naming the Claude Code session that produced the branch so a reviewer can resume it locally. Both are read deterministically by the script — from `gh` and from the environment — and both can be turned off in `git-config.yml`.

Designed to be invoked as the `after_implement` hook (alongside the existing auto-commit hook), or directly via `/speckit-git-pr`.

## Arguments

`/speckit-git-pr [base_branch] [--draft]`

- `base_branch` — defaults to `main`.
- `--draft` — **draft handoff mode**: open the PR as a draft *and* skip the
  `/speckit-archive-feature` pre-step. Use this whenever a human still has to review
  before the work is considered delivered — notably every `/speckit-autopilot-run`.

## Pre-Execution (Mandatory)

Before any PR checks or `gh pr create` execution, run these commands in order:

1. `/speckit-archive-feature` — **skipped when `--draft` is passed.** Archiving closes
   the tracking issue and moves the spec out of the active tree; in draft mode the
   issue must stay open and the spec must stay in place until a human merges the PR
   (issue #28). Archive after the merge instead.
2. `/speckit-git-commit` — always runs, draft or not.

If a command that is supposed to run is unavailable or fails, stop and return an error. Do not continue to PR creation.

## Behavior

1. Run mandatory pre-execution commands:
   - `/speckit-archive-feature` (skipped in `--draft` mode)
   - `/speckit-git-commit`
2. Verify `gh` is installed and the cwd is a git repo on a non-default branch.
3. Resolve the feature:
   - The feature directory is derived from the current branch (`specs/<branch>`, honouring `SPECIFY_FEATURE_DIRECTORY`/`SPECIFY_FEATURE`) → used to derive the PR title from the spec's H1 and to mention spec/plan/tasks paths in the PR body.
   - When a `source_issue` is present the title is prefixed `#N: `, so the PR reads as the delivery of that issue in a list view. A prefix, not a trailing `(#N)` — GitHub appends `(#<pr>)` to the subject itself on a squash merge, and a title carrying both would read as two PR numbers. Double-prefixing is guarded, so a spec H1 that already names the issue is left alone. The squashed commit subject uses the same string, keeping commit and PR titles identical.
   - `source_issue` is read from `.specify/feature.json` — the only field read from it — or recovered from the worktree's sidecar when core Spec Kit's `setup-plan` overwrote the file (issue #78) → if present and numeric, append `Closes #N` to the PR body. If the sidecar says this worktree was linked and the issue cannot be recovered, the command stops rather than opening a PR that closes nothing.
4. If `squash_before_pr: true` in `git-config.yml`, squash every commit between `merge-base(HEAD, <base>)` and `HEAD` into a single commit (title from the spec H1, body listing the original commit subjects). Aborts if the working tree has uncommitted changes.
5. If the branch isn't yet on `origin`, push it (`git push -u origin <branch>`). If it was already pushed and a squash happened, force-push with `--force-with-lease`.
6. If a PR already exists for the branch, print its URL and exit. In `--draft` mode, if that existing PR is *not* a draft, also print a warning naming `gh pr ready <url> --undo` — the script does not mutate a PR it did not create.
7. Otherwise, run `gh pr create --base <base> --head <branch> --title <derived> --body <derived>`, adding `--draft` in draft mode. The draft flag is passed to `gh pr create` directly — never create a mergeable PR and convert it afterwards with `gh pr ready --undo`.
8. Copy the source issue's labels onto the PR with `gh pr edit --add-label` (also on the already-exists path in step 6, so a re-run backfills them). Skipped when there is no `source_issue` or `pr_copy_labels: false`. Never `gh pr create --label`: `gh` rejects the whole create call if any label is unknown to the repo, which would lose the PR over a cosmetic failure — applied afterwards it degrades to a warning, matching `label-issue.ts`'s rule that label failures are warnings, never errors. `autopilot:*` is always filtered out; those labels are picker run-state (`claimed`/`blocked`), not a description of the change, and `autopilot:blocked` on a PR that exists because the work got done would be a lie.

## Agent session footer

When the script runs inside a Claude Code session it appends a `<!-- speckit:agent-session -->` block to the PR body:

```text
**Agent session** — resume this work locally:

    claude --resume <CLAUDE_CODE_SESSION_ID>

- Author: <git user.name> <<git user.email>>
- Web: https://claude.ai/code/<CLAUDE_CODE_BRIDGE_SESSION_ID>
```

Every value is read from the environment or from `git config` by the script. **Do not supply any of it from the agent prompt** — a model reporting its own session id is precisely the kind of value that gets hallucinated, and a wrong resume id is worse than none. `CLAUDE_CODE_SESSION_ID` is the local transcript uuid, and only resolves on the machine holding that transcript; `CLAUDE_CODE_BRIDGE_SESSION_ID` is the claude.ai slug and is absent when the session was never bridged, in which case the `Web:` line is simply omitted. The footer no-ops outside an agent session and with `pr_session_footer: false`.

## Execution

Run the script:

- **Bash**: `bun .specify/extensions/git/scripts/ts/create-pr.ts [base_branch] [--draft]`

Default `base_branch` is `main`. Pass an alternative as the first argument if needed.
`--draft` may appear in either position. The script owns the draft flag on
`gh pr create`; skipping `/speckit-archive-feature` is this command's half of the
contract, since the script never invokes that command itself.

## Graceful Degradation

- If `/speckit-archive-feature` (non-draft mode only) or `/speckit-git-commit` is unavailable or fails: error and stop before PR creation.
- If an unknown option or a second positional argument is passed: error with the usage line and stop.
- In `--draft` mode with a pre-existing non-draft PR: warn with the `gh pr ready --undo` hint and exit successfully; the existing PR is left untouched.
- If `gh` is missing: error with install hint.
- If the current branch equals the base branch: refuse.
- If no `source_issue` is recorded: PR is created without a closing keyword and without the `#N: ` title prefix (still works, just doesn't auto-close an issue).
- If a PR already exists for this branch: prints the existing URL, does not duplicate.
- If the issue's labels cannot be read or applied: warn and continue — the PR is already open and a missing label never fails the command.
- If the session env vars are absent (script run by hand, not from an agent): the footer is omitted; nothing else changes.
- If `squash_before_pr: true` but the merge-base with `<base>` cannot be computed, or the working tree has uncommitted changes: error and stop before pushing.
