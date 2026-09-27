---
description: "Execute tasks.md inside the feature's dedicated worktree"
argument-hint: "Optional implementation guidance or task filter"
compatibility: "Requires spec-kit project structure with .specify/ directory"
strategy: "wrap"
metadata:
  author: "beadbits"
  source: ".specify/presets/worktree-isolation/commands/speckit.implement.md"
user-invocable: true
disable-model-invocation: false
---

## Wrapper Layer

This preset wraps `/speckit-implement` (and any inner wrapper the core-flow seam
expands to). It adds exactly one thing: it `cd`s into the feature's dedicated
worktree before any filesystem write performed by the flow below. It does not
change how tasks are executed.

It is deliberately the **outermost** layer on `/speckit-implement`, so the `cd`
happens before any other layer reads or writes a file. See the ordering contract
in the root `README.md`.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

### 0. cd into the feature's worktree (MANDATORY — Principle VII)

Per BeadBits Constitution v2.3.0 Principle VII (Feature-Work Isolation),
/speckit-implement MUST execute with the agent's cwd set to the feature's worktree.
This step runs BEFORE any filesystem write performed by the rest of this
outline.

1. Resolve the current branch with `git rev-parse --abbrev-ref HEAD`. If the
   cwd is not inside a git worktree, ERROR with:
   "Cannot resolve feature: not inside a git worktree.
   Run /speckit-git-feature to create the feature branch and worktree."
   Do NOT proceed.

   Do NOT read `worktree_path` from `.specify/feature.json`. That field no
   longer exists, and no path is ever resolved from that file: it is per-worktree
   state whose `source_issue` is the only key our tooling reads (`feature_directory`
   is written there for core Spec Kit's own resolver). Back when the file was
   tracked, the recorded path named the *previous* feature's worktree in any fresh
   worktree (issue #33).

2. Let `WT` be the worktree whose branch matches the current branch, found via
   `git worktree list --porcelain`. When the cwd is already inside that
   worktree, `WT` is `git rev-parse --show-toplevel`.

3. If no worktree matches the current branch:
   Emit a single-sentence warning:
   "This feature has no dedicated worktree (it is checked out in the main
   working tree). Proceeding in the current cwd; Principle VII isolation is
   not enforced for this invocation."
   Then proceed in the current cwd. Skip steps 4–6.

4. If `WT` is non-null but the directory does NOT exist on disk:
   The recorded path is machine-local (e.g. created in another clone or by
   another author) and is meaningless here. Emit a single-sentence warning:
   "Recorded worktree_path '<WT>' does not exist on disk (likely a path from
   another clone). Proceeding in the current cwd; Principle VII isolation is
   not enforced for this invocation."
   Then proceed in the current cwd. Skip steps 5–6.

5. If `WT` is non-null, exists on disk, and matches the current cwd
   (resolved to absolute path), proceed silently — no cd needed.

6. Otherwise (`WT` is non-null, exists, and differs from cwd):
   Prefix every subsequent shell invocation in this command with
   `cd "<WT>" && ...` so the cd is visible in the session log. All
   filesystem writes performed by the rest of this outline land inside
   the worktree. Do not silently rely on tools that ignore cwd
   (absolute-path file writers) as a substitute — the cd MUST appear
   in the session log for post-hoc isolation auditing.

### End cd-block (Principle VII enforcement complete)

### Core Flow

Everything below runs with the cwd established above. Every shell invocation in
the core flow inherits the `cd "<WT>" && ...` prefix from step 6 when one was
required.

{CORE_TEMPLATE}

## Constitution v2.3.0 Principle VII compliance note

This preset override exists specifically to close the resume-case gap left by PR #21
for `/speckit-implement`. The substantive operational behaviour it adds beyond the stock
`speckit-implement` skill is:

1. Resolving the feature's worktree from `git worktree list` by the current branch.
2. `cd`-ing into that path before any filesystem write performed by the implement outline.
3. Falling back to the current cwd (with a warning) when no worktree matches — e.g. the
   branch is checked out in the main working tree.

Deriving the path from git rather than reading a recorded `worktree_path` is deliberate:
that field was a machine-local absolute path committed to `.specify/feature.json`, so a
fresh clone aborted on a path it could never have, and a fresh worktree inherited the
previous feature's path outright (issue #33).

This override SUPERSEDES the in-skill worktree-resolution block previously added in
commit fee6cf3, which auto-created worktrees from the branch name. A missing worktree
directory degrades to the current cwd rather than erroring, so implementation stays
portable across clones.

The cd-block at `### 0.` is byte-identical across all four feature-scoped command
overrides (`/speckit-clarify`, `/speckit-plan`, `/speckit-tasks`, `/speckit-implement`)
modulo the slash-command substitution; this is enforced by SC-002 in
`specs/022-worktree-isolation-resume/quickstart.md`.
