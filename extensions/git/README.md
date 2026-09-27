# Git Branching Workflow Extension

Feature branch creation, numbering (sequential/timestamp), worktree management, cleanup, PR creation, and auto-commit for Spec Kit.

## Overview

This extension provides Git operations as an optional, self-contained module. It manages:

- **Feature branch creation** with sequential (`001-feature-name`) or timestamp (`20260319-143022-feature-name`) numbering
- **Worktree creation and cleanup** for feature isolation
- **PR creation** for completed feature branches (`--draft` for a human-review handoff:
  opens the PR as a draft and leaves the tracking issue open)
- **`commit_exclude`** — repo-tracked generated artifacts that CI rebuilds on the
  default branch. One handler, `scrub-commit-exclude.ts`, restores those paths to
  HEAD — unstaging, discarding tracked edits, dropping untracked output — and is
  called by `create-pr.ts` and `clean.ts`, so the exclusion holds even where
  `auto_commit.default` is `false` (issue #62) and no step improvises its own
  recovery from a background rebuild's churn (issue #55). `auto-commit.ts` does
  not scrub, so a graph rebuild survives across phases; it only holds the paths
  out of its own commit (issue #109). A rebuild in flight is
  waited for rather than raced. `create-pr.ts` additionally resets the paths to
  the base branch, since the working tree says nothing about what already landed
  in the branch's history
- **GitHub issue sync** — when a tracking issue is linked, its body is re-rendered from `spec.md` after every `/speckit-specify` (title untouched) and its `p0`..`p3` / `bug`|`feature` triage labels are kept current; skipped cleanly when there is no linked issue
- **Auto-commit** after core commands (configurable per-command with custom messages).
  Xcode build output and per-user state (`DerivedData/`, `build/`, `.build/`,
  `xcuserdata/`, `*.xcuserstate`, `*.xcresult`, untracked `Pods/`; the list is
  `XCODE_ARTIFACTS` in `git-common.ts`) is always held out of the commit, even when the
  project's `.gitignore` misses it. Paths already committed (a team that commits `Pods/`)
  are left alone. `initialize-repo.ts` writes the same list into a new repo's `.gitignore`
- **Worktree dependency bootstrap**: `install-deps.ts` runs after a worktree is created
  (best effort, always exit 0, `SPECKIT_SKIP_INSTALL=1` skips it). It runs `pod install`
  where the base checkout has `Pods/`, `carthage bootstrap --use-xcframeworks` where it
  has `Carthage/Build/`, `swift package resolve` for a Swift package, and
  `xcodebuild -resolvePackageDependencies` for an app whose `.xcodeproj`/`.xcworkspace`
  tracks a `Package.resolved`. DerivedData is keyed by the checkout path, so a new
  worktree otherwise starts with no resolved packages

## Commands

| Command | Description |
|---------|-------------|
| `speckit.git.feature` | Create a feature branch with sequential or timestamp numbering; `--source-issue N` binds to an existing issue instead of opening a stub |
| `speckit.git.worktree` | Create a worktree under the `${PROJ}.worktrees` collector directory |
| `speckit.git.clean` | Clean up the current feature worktree, branch, issue, and uncommitted changes |
| `speckit.git.issue` | Update the linked GitHub issue's body from `spec.md` (a manual run may also create one when none is linked) |
| `speckit.git.commit` | Auto-commit changes (configurable per-command enable/disable and messages) |
| `speckit.git.pr` | Open a GitHub PR for the current feature branch; `--draft` opens it as a draft and skips the archive-feature pre-step |

## Hooks

| Event | Command | Priority | Optional | Description |
|-------|---------|----------|----------|-------------|
| `before_specify` | `speckit.git.feature` | — | No | Create feature branch before specification |
| `before_clarify` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before clarification |
| `before_plan` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before planning |
| `before_tasks` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before task generation |
| `before_implement` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before implementation |
| `before_checklist` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before checklist |
| `before_analyze` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before analysis |
| `before_taskstoissues` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before issue sync |
| `after_constitution` | `speckit.git.commit` | 10 | Yes | Auto-commit after constitution update |
| `after_specify` | `speckit.git.issue` | 5 | No | Update the linked GitHub issue's body from the rendered spec (no-op when no issue is linked) |
| `after_specify` | `speckit.git.commit` | 10 | Yes | Auto-commit after specification |
| `after_clarify` | `speckit.git.commit` | 10 | Yes | Auto-commit after clarification |
| `after_plan` | `speckit.git.commit` | 10 | Yes | Auto-commit after planning |
| `after_tasks` | `speckit.git.commit` | 10 | Yes | Auto-commit after task generation |
| `after_implement` | `speckit.git.commit` | 10 | Yes | Auto-commit after implementation |
| `after_checklist` | `speckit.git.commit` | 10 | Yes | Auto-commit after checklist |
| `after_analyze` | `speckit.git.commit` | 10 | Yes | Auto-commit after analysis |
| `after_taskstoissues` | `speckit.git.commit` | 10 | Yes | Auto-commit after issue sync |

`after_specify` runs two commands. The intended order is `speckit.git.issue` first — it syncs the tracking issue (and on a manual run may write `source_issue` into `.specify/feature.json`) — then `speckit.git.commit`, which picks up that change along with the new spec. The `priority` values in the manifest record that intent, but the runtime does not guarantee it: the agent-driven hook runner reads `hooks.after_specify` from `.specify/extensions.yml` and iterates the entries as registered, without sorting by priority. The order that actually holds is the manifest's **declaration order**, which is why the `after_specify` block in `extension.yml` must not be reordered.

Issue sync is non-optional in the sense that the agent always runs it, but it is not always a mutation:

- **A tracking issue is linked** (`source_issue` in `.specify/feature.json`) → the issue's **body** is rewritten from the spec. The title is left alone; `speckit.git.feature` owns it. If `gh` is missing, unauthenticated, or the edit fails, the hook errors rather than skipping.
- **No tracking issue is linked** → the hook prints a one-line notice and exits successfully without creating anything. This is the normal state when `speckit.git.feature` bypassed issue creation (`--timestamp`, `--number`, `GIT_BRANCH_NAME`, `--dry-run`) or ran in a repo without `gh`, so `/speckit-specify` keeps working for non-GitHub users.

Creating an issue is the job of `speckit.git.feature`, which owns the numbering contract. Running `/speckit-git-issue` manually *may* create one when none is linked; the automatic hook path never does.

### Triage labels: priority and kind

On both paths, `/speckit-git-issue` also keeps two triage labels current on the tracking issue: a priority (`p0`, `p1`, `p2`, `p3`) and a kind (`bug` or `feature`). They are applied by `scripts/ts/label-issue.ts`, which creates any label the repo is missing and keeps each axis exclusive (setting `p1` removes `p0`/`p2`/`p3`).

This is the input side of autopilot's picker: `/speckit-autopilot-run` orders its eligible backlog by priority, then bugs before features, then age. Without labels every backlog drains oldest-first, which is why a P0 filed today can otherwise sit behind a year-old chore.

The command **asks** the human for a priority when there is one in the loop, leading with the value it would have inferred so accepting takes one keystroke; when nobody is there — the `after_specify` hook during an unattended autopilot run — it infers and says so instead of blocking. An existing priority set by a human is never overwritten or re-asked. Label failures are warnings, never errors: an unlabelled issue is still a working issue.

```bash
.specify/extensions/git/scripts/ts/label-issue.ts 42 --show
.specify/extensions/git/scripts/ts/label-issue.ts 42 --priority p1 --kind bug
```

## Configuration

Configuration is stored in `.specify/extensions/git/git-config.yml`:

```yaml
# Branch numbering strategy: "sequential" or "timestamp"
branch_numbering: sequential

# Auto-commit per command (all disabled by default)
# Example: enable auto-commit after specify
auto_commit:
  default: false
  after_specify:
    enabled: true
    message: "[Spec Kit] Add specification"
```

## Installation

```bash
# Install the bundled git extension (no network required)
specify extension add git
```

## Disabling

```bash
# Disable the git extension (spec creation continues without branching)
specify extension disable git

# Re-enable it
specify extension enable git
```

## Graceful Degradation

When Git is not installed or the directory is not a Git repository:
- Spec directories are still created under `specs/`
- Branch and worktree operations are skipped with a warning
- PR operations are skipped with a warning

## Scripts

The extension bundles cross-platform scripts:

- `scripts/ts/create-new-feature.ts` — implementation
- `scripts/ts/git-common.ts` — Shared Git utilities (Bash)
