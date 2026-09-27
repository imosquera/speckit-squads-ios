---
description: Portfolio-wide audit mode for /speckit-analyze across worktrees
---

## Preset Routing (runs BEFORE the stock command body)

This preset is *prepended* to the core `/speckit-analyze` command. Evaluate the routing rules below first; only fall through to the stock command body when neither portfolio mode nor the worktree fallback applies.

### Mode A — Portfolio Audit

**Trigger** — activate portfolio mode if **either** is true:

1. `$ARGUMENTS` contains the token `portfolio` (case-insensitive), or
2. The current branch is **not** a feature branch (e.g. user invoked `/speckit-analyze` from `main`). Detect this by running `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks` from repo root: if it errors with "Not on a feature branch" (or equivalent), do **not** abort — switch to this mode instead.

When portfolio mode is active, **skip the entire stock command body** (Steps 1–8 of the per-feature flow) and execute the audit below. The `before_analyze` and `after_analyze` extension-hook scans defined by the stock command still run, bracketing this audit.

#### Portfolio Audit — Behavior (strictly read-only)

1. **Enumerate worktrees.** Run `git worktree list --porcelain` from the primary checkout. Record `(path, branch, head)` for each entry. Treat `<repo>.worktrees/<slug>/` as the canonical worktree layout (per project memory `feedback_worktree_location.md`); also include any worktree paths the user has manually created elsewhere.
2. **Enumerate spec slugs across all worktrees.**
   - For each worktree path, list `specs/*/` excluding the literal `archive` directory.
   - Union by slug (the directory name). A slug may legitimately appear in multiple worktrees; record every location.
3. **Locate the most complete copy of each spec.** For each `(slug, location)`:
   - Check for `spec.md`, `plan.md`, `tasks.md`, `.specify/feature.json`.
   - Prefer the copy in the worktree whose branch name matches the slug; otherwise compute the union of present artifacts across all locations.
   - Record which artifacts are missing and where each present artifact lives.
4. **Enumerate GitHub issues — open AND closed.**
   - Run `gh issue list --state all --limit 300 --json number,title,labels,state`.
   - Closed issues are intentionally included so cleanup gaps are visible.
5. **Match issues → specs**, in priority order:
   1. `source_issue` field in the worktree's `.specify/feature.json` (most authoritative). The file is gitignored per-worktree state, so it is present only in a live worktree for that slug — never under `specs/<slug>/`.
   2. `Closes #N`, `Fixes #N`, or bare `#N` references inside `spec.md` or `plan.md`.
   3. Fuzzy title match as a last resort — flag as **loose** in the report so the user can backfill metadata.
6. **Detect orphans and dead artifacts.**
   - Spec directories containing `tasks.md` but no `spec.md` (e.g. abandoned scaffolds).
   - Worktree branches with no matching `specs/<slug>/` directory anywhere (dead branches).
   - Duplicate spec directories across multiple worktrees.

#### Portfolio Audit — Report (no file writes)

Emit the following Markdown report. Do not write it to disk.

##### Portfolio Audit Report

**Table A — Open issues without any spec**

| Issue | Title | Labels |

**Table B — Closed issues without any spec**

| Issue | Title |

(These are likely missed cleanup.)

**Table C — Specs missing `plan.md` or `tasks.md`**

| Spec slug | Location(s) | spec.md | plan.md | tasks.md |

(Location is the worktree path containing the most complete copy; mark `Y`/`N` for each artifact.)

**Table D — Orphaned / dead artifacts**

| Item | Kind | Notes |

Kinds include: `tasks-only-scaffold`, `dead-worktree-branch`, `duplicate-worktree-copy`.

**Table E — Loose issue↔spec matches**

| Issue | Matched spec | Match reason |

(Matches found only by fuzzy title — add `Closes #N` to `spec.md` to firm these up; `feature.json` is gitignored and cannot be backfilled durably.)

**Metrics**

- Total open issues
- Total closed issues
- Total spec slugs
- Issues without any spec (open + closed)
- Specs missing plan or tasks
- Orphaned / dead artifacts
- Loose matches

#### Portfolio Audit — Next Actions

Suggest concrete follow-ups per table:

- Table A → `/speckit-specify --issue <n>` (or in-worktree if the branch already exists).
- Table B → reopen the issue or create the missing spec if the closure was premature.
- Table C → `/speckit-plan` or `/speckit-tasks` inside the worktree that contains the most complete copy.
- Table D → investigate dead worktree branches manually (`git worktree remove`) or clean up duplicate/stale worktree copies.
- Table E → add `Closes #N` to `spec.md`/`plan.md` (the durable home; `feature.json` is gitignored per-worktree state).

After emitting the report, ask the user: **"Want me to drill into any of these (e.g. start a `/speckit-specify` for an unspec'd issue)?"** Do not apply any changes automatically.

### Mode B — Per-Feature Worktree Fallback (modifies stock Step 1)

If portfolio mode did **not** activate but the prerequisite check is on a feature branch and one or more of `spec.md`/`plan.md`/`tasks.md` is missing in the current checkout, attempt the fallback below **before** aborting:

1. Look up the matching worktree at `<repo>.worktrees/<slug>/specs/<slug>/` (where `<slug>` is the current feature branch).
2. For each artifact missing locally, use the worktree copy if it exists. **Use it even if the worktree copy is stale relative to the current checkout** (e.g. older HEAD).
3. If the worktree copy is older than the local copy of any sibling artifact (compare `git log -1 --format=%ct` of the file paths), record a finding `WORKTREE-STALE` with severity **MEDIUM** in Section 4 of the stock report. The analysis still proceeds.
4. If no worktree copy exists either, fall back to the stock command's abort behavior with the original error message.

This fallback is a pure extension of Step 1 of the stock command. All other stock steps (Load Artifacts → Build Semantic Models → Detection Passes → Severity Assignment → Report → Next Actions → Offer Remediation) run unchanged using whichever artifact paths the fallback resolved.

### Mode C — Stock Per-Feature Analysis (no preset behavior)

If portfolio mode is not active AND no worktree fallback was needed (all artifacts present locally), continue with the stock `/speckit-analyze` command body below as-is.

---

{CORE_TEMPLATE}
