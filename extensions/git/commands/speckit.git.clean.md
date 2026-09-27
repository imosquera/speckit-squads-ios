---
description: "Clean up the current feature worktree, branch, issue, and any uncommitted changes."
---

# Clean Current Feature

Remove a feature worktree that is no longer needed. By default, the command resolves the feature from the current worktree's git branch, then discards uncommitted changes, removes the feature worktree, deletes the feature branch, and closes any linked GitHub issue.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

1. Parse arguments. Support `--force` / `-f`, `--worktree <path>`, `--spec <path>`, and `--issue <number>`. A single positional target is also allowed and may be a worktree path, a spec directory, or an issue number.
2. Resolve the cleanup target in this order:
   - an explicit `--worktree` path or worktree-like positional path
   - an explicit `--spec` path or `specs/<slug>` positional path
   - an explicit `--issue` number or `#<issue>` positional value
   - the current worktree (`git rev-parse --show-toplevel`)
3. Derive `feature_directory` and the feature branch from git in the target worktree, and read `source_issue` from its `.specify/feature.json` when present. The worktree path is never read from a file — doing so is how this command used to be pointed at the *previous* feature's worktree (issue #33).
4. Before **any** destructive step, run `verify-landed.ts <branch>` and refuse on a non-zero exit unless `--force` was passed. Never re-derive this check by hand: this repo squash-merges, and a squash breaks ancestry, so `git branch -d`, `git branch --merged` and `git merge-base --is-ancestor` all report "not merged" for work that is safely on the base. The script answers the question once, tree-wide, against the exclusions `commit_exclude` already declares — a hand-typed path list differs every run and a run that omits a path deletes a branch holding work in it (issue #49). `UNKNOWN` is a refusal, not a pass.
5. If the target worktree has uncommitted changes:
   - abort with a file list unless `--force` was passed
   - when `--force` is passed, discard tracked and untracked changes before removal
6. Close the linked GitHub issue when `source_issue` is present and `gh` is available.
7. Remove the feature worktree with `git worktree remove` when the target is not the primary checkout.
8. Delete the feature branch with `git branch -D` after the worktree is removed.
9. Leave a short status summary describing what was cleaned and what was skipped.

## Execution

- **Bash**: `bun .specify/extensions/git/scripts/ts/clean.ts [--force|-f] [--base <ref>] [--worktree <path>] [--spec <path>] [--issue <number>] [target]`
- **Bash** (the landed check on its own, e.g. before deleting a branch by hand): `bun .specify/extensions/git/scripts/ts/verify-landed.ts <branch> [--base <ref>] [--repo <dir>] [--exclude <path>]... [--json]` — exit 0 `LANDED`, 1 `NOT-LANDED`, 2 `UNKNOWN`

## Graceful Degradation

- If the branch's work is not provably on the base: refuse and print the differing paths. Only `--force` proceeds, and it says out loud that the work is being discarded.
- If Git is not available or the current directory is not a repository: warn and exit.
- If no `specs/<branch>` directory exists for the current branch and no explicit target is provided: refuse and explain how to point the command at a worktree, spec, or issue.
- If `gh` is missing or the issue cannot be resolved: the cleanup still proceeds and prints a notice.
- If the target is the primary checkout, the script will not remove that checkout in place; it will only clean the working tree and report the branch/worktree details so the user can rerun from a different checkout if needed.