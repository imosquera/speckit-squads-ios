# speckit-squads — agent guide

This repo is the source of truth for a personal set of Spec Kit extensions and presets. Consumer projects (e.g. `~/Code/beadbits`) install from here via `specify ... add --dev`.

## Layout

```
extensions/<id>/   extension.yml + commands/ + scripts/
presets/<id>/      preset.yml    + commands/ + templates/
install.ts         install every extension+preset into a Spec Kit project
uninstall.ts       remove every extension+preset from a Spec Kit project
check-cli-usage.ts validate `specify <verb>` calls AND every script path in command files
scripts/           gen-agent-index.ts (the consumer-side command->script index, run by install.ts) + check-script-paths.ts + jev.ts (the canonical Jev helper, see *Jev*)
```

**Installed layout is not the same shape.** In a consumer project, `specify` copies each
extension whole into `.specify/extensions/<id>/`, preserving its internal structure. It
never merges extension scripts into the core tree, so a consumer has **two** script trees:

```
.specify/scripts/bash/                    core Spec Kit scripts — FLAT, no per-extension subdirs
    check-prerequisites.sh  common.sh  create-new-feature.ts  setup-plan.sh  setup-tasks.sh
.specify/extensions/<id>/scripts/bash/    one tree per extension
.specify/presets/<id>/
```

There is no `.specify/scripts/bash/<extension-id>/`. Never guess a script path from the
command name: **command names and script names do not correspond.** `/speckit-git-feature`
runs `create-new-feature.ts` (not `feature.ts`), and that filename also collides with the
unrelated core `scripts/bash/create-new-feature.sh`. The authoritative path for every
extension command is the `- **Bash**:` line in its own `commands/*.md`; `ls` the extension
tree before invoking anything.

## No PowerShell

**Everything here is TypeScript run by bun. Never add a `.ps1`, a `scripts/powershell/` tree, or a
`ps:` line pointing at a script this repo owns.** Nothing that consumes these
extensions runs on Windows, so a PowerShell twin is never exercised — it is a
second copy of logic whose only job is to stay identical to the first, and it
drifts silently because no one runs it. The git and review extensions each
carried one, and each was deleted the moment a fix had to be written twice. The
`commit_exclude` handler is the case in point: a single handler that a second
uninstrumented commit path bypasses is not a single handler at all.

The three `ps:` lines still in `presets/*/commands/` point at **core Spec Kit's**
`scripts/powershell/check-prerequisites.ps1`, not at anything we ship. They are
inherited from upstream templates and are left alone; the rule is about scripts
this repo owns.

## Runtime: bun + TypeScript 7

**Our own JavaScript tooling is TypeScript run by bun** — shebang
`#!/usr/bin/env bun`, never `node`/`npm`/`npx` — and it is typechecked by
TypeScript 7 (the native compiler) via `bun run typecheck` against the root
`package.json`/`tsconfig.json`. Run `bun install` once per checkout;
`check-cli-usage.ts` runs the typecheck as part of install pre-flight when bun
and `node_modules` are present, and warns and skips otherwise. The
`parse-dont-validate` scanner needs no `typescript` at all: it parses with
`oxc-parser` pinned at 0.151.0, taken from the machine cache
`~/.cache/speckit-squads/pdv` (filled by `bun add` on first use, never
`.specify/`) or this checkout's own copy — never from the consumer (issue #115,
superseding #113's TS 5.x workaround). Consumer-side package managers stay polyglot —
`install-deps.ts` reads each consumer's lockfile and must keep doing so.

**There is no Python and no bash.** Every script this repo ships is TypeScript
under an item's `scripts/ts/` (or `hooks/`, the repo root, or the root `scripts/`),
started with `bun <path>.ts`. Command files call them that way, and frontmatter keeps
the `sh:` key Spec Kit selects by name with a `bun scripts/ts/<name>.ts` value.
`check-cli-usage.ts` fails on any reference to a `scripts/bash/*.sh` of ours; core
Spec Kit's own `scripts/bash/` stays allowed. Bun is therefore required wherever these
items run — `install.ts` refuses to start without it. The bash port kept each
script's CLI, output and exit codes, proved by running the old bash tests against the
new scripts; the few intended differences are listed in its PR. The Python ports were held byte-for-byte to the Python they
replaced (side-by-side diffs, every `--selftest` carried over), which is why a few
helpers — autopilot's `py.ts`, diff-minimal's `scope-common.ts` — reproduce
Python's whitespace, JSON and `repr` rules. The PDV driver scans Python *source*
with its own tokenizer now, not `ast`: identical on a 2,300-finding corpus, but a
file with an indentation-only syntax error is scanned rather than rejected.

## Install / uninstall

Both scripts auto-discover every directory under `extensions/` and `presets/` that contains a manifest — there is **no hardcoded list to maintain**.

Both require a `<project-dir>` argument — there is no implicit `$PWD` default, so you can't accidentally install into the wrong place.

```bash
./install.ts /path/to/spec-kit-project
./uninstall.ts /path/to/spec-kit-project
```

Every install uses `specify ... add --dev <repo-path>`. **`--dev` records this repo as the install source; it does not symlink.** Verified in the installed specify-cli:

- `PresetManager.install_from_directory()` (`specify_cli/presets/__init__.py`) ends in `shutil.copytree(source_dir, dest_dir)` — there are no symlink calls anywhere in the preset module.
- `ExtensionManager.install_from_directory()` (`specify_cli/extensions/__init__.py`) likewise does `shutil.copytree(source_dir, dest_dir, ignore=ignore_fn)`. The only `os.symlink` in that module is for rendered *agent skill* files in dev mode, not for the extension tree itself.
- On disk, both `.specify/presets/<id>/` and `.specify/extensions/<id>/` in a consumer (checked: `~/Code/adkit`) are plain directories timestamped at last install, not symlinks.

**Consequence: edits made in this repo are NOT picked up live.** Any change — command markdown, scripts, templates, or the manifest — requires a refresh in the consumer:

```bash
./install.ts --force /path/to/spec-kit-project
```

Plain `./install.ts <project>` treats "already installed" as a no-op success, so it will **not** propagate edits. Use `--force` whenever you have changed anything here.

Note on capabilities (verified empirically): **only extensions can declare `hooks:` and register brand-new standalone commands**; a `hooks:` block or a new command in a `preset.yml` is silently dropped by `specify`. **Only presets can `wrap`/`replaces` an existing command body**; extensions add new commands and hooks but never rewrite a core command. When a feature needs both (e.g. `progress-report` wraps cycle commands *and* needs `before_*` hooks), ship it as a preset + companion extension pair.

Note on composition (issue #25): a preset command template's `strategy` defaults
to **`replace`** when omitted, and a `replace` layer kills every layer below it —
that default silently disabled five `/speckit-implement` presets at once. Always
declare `strategy:` explicitly. There is no `replaces:` key; it is not in the
schema and is silently dropped. Presets are ordered by `(priority ASC, id ASC)`,
lowest number outermost, and priority is an **install-time** argument, not a
manifest field — so `install.ts`'s `preset_priority()` map is load-bearing
wherever more than one preset targets a command. The `/speckit-implement`
ordering contract is tabulated in `README.md`; keep the two in sync.

`install.ts` runs `check-cli-usage.ts` as a pre-flight and aborts on failure: every
`specify <verb> [<subverb>]` inside a fenced bash block in `*/commands/*.md` is checked
against `specify --help`, so a command file can't ship instructions to run CLI surface
that doesn't exist. Prose outside code fences is ignored. Run it standalone any time.

A command file's bash blocks must never use a bare `$CLAUDE_PROJECT_DIR`: it is empty in
an ordinary interactive session, so the path starts at `/` and the call dies with
`exit 127` — six sessions over 50 days paid that tax before it was caught (issue #59).
Each block resolves the root itself with
`PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"`, per block because
each bash call is its own shell. `check-cli-usage.ts` fails the install on a bare use.

Anything that must reach *outside* `specify` — the Claude Code harness
(`.claude/settings.json`) or the project's `CLAUDE.md` — ships as
`scripts/ts/post-install.ts <project-dir>` inside the extension or preset that
owns it. `install.ts` runs every executable one it finds after registration, and
`uninstall.ts` runs the matching `scripts/ts/pre-uninstall.ts` before
de-registering. Both are auto-discovered; both must be idempotent, since
`--force` re-runs them.

`uninstall.ts` only de-registers items from the target project; it never touches the source files in this repo.

## Feature identity: `.specify/feature.json`

The file is **gitignored per-worktree state**. It carries `source_issue` — the only part
of a feature's identity that cannot be derived from git — plus `feature_directory`,
written once at creation by `create-new-feature.ts` **solely for core Spec Kit's own
`get_feature_paths()`**, which hard-errors without it and takes `setup-plan.sh` down with
it. Our tooling never reads `feature_directory`: branch, feature number, worktree path,
and spec directory are resolved at read time by `spec_kit_resolve_feature()` in
`extensions/git/scripts/ts/git-common.ts`.

**Our writers merge; core's does not, so `source_issue` is mirrored to a sidecar.**
`spec_kit_write_feature_json()` is the only writer here and it preserves the keys it
was not given. Core's `_persist_feature_json` (core `common.sh`, reached from
`setup-plan` and every `get_feature_paths()` call) writes `feature_directory` with a
plain `>` redirect, dropping `source_issue` mid-pipeline — the PR then opened with no
`Closes #N` and the tracking issue stayed open after the merge (issue #78). Since core's
writer is not ours to fix, the linkage is mirrored to
`<worktree git dir>/speckit-source-issue`: private to the worktree, never shared, never
committed, unreachable by core. `spec_kit_feature_source_issue()` recovers from it,
heals the file, and warns on stderr; `auto-commit.ts` reads through that helper on every
`after_*` phase, so the heal lands before the readers that still inline the `sed`
(archive, session-title). `create-pr.ts` refuses to open a PR when the sidecar says the
worktree was linked but the issue cannot be recovered. `./test-feature-json.ts` is the
check.

Never reintroduce `branch_name`, `feature_num`, or `worktree_path` into that file, and
never read a feature's paths out of it. Because the file used to be
tracked, every new worktree inherited the *previous* feature's copy from the base branch,
which pointed `/speckit-git-pr` at the wrong issue and `/speckit-git-clean` at the wrong
worktree (issue #33). `/speckit-git-feature` gitignores the file and `git rm --cached`s it
on first run in a project that still tracks it, so the migration is automatic.

## Currently shipped

<!-- AGENT: keep this list in sync with the directories under extensions/ and presets/. Regenerate by running:
  ls -1 extensions/*/extension.yml presets/*/preset.yml | sed 's|/[^/]*\.yml$||'
-->

**Extensions**
- `archive` — archive a completed feature folder, close linked GitHub issues
- `autopilot` — `/speckit-autopilot-run`: take the **highest-ranked** eligible open issue (or a given issue number) from backlog to a reviewed **draft PR** by driving the whole pipeline unattended (specify → clarify auto-answered → plan → tasks → implement → review), binding the worktree to the existing issue and posting progress comments at every stage.
  A hard, non-recoverable stop writes a durable `autopilot:blocked` label plus an
  `AUTOPILOT-BLOCKED:`-tagged comment, which `preflight-issues.ts` skips on and reads
  the reason back out of — without it, removing the transient `autopilot:claimed`
  label left no durable state and one issue was re-picked in 10 consecutive runs
  (issue #32); only a human clears `autopilot:blocked`.
  **A run is bound to one repo and one checkout in both directions.** Input and
  schedule always were (`gh issue list` with no `--repo`; one launchd plist per repo
  root). Output was not: nothing checked where the *fix* had to land, so an issue
  whose target resolved into a different repo got worked and delivered there while
  staying open behind it (issue #34). `check-target-repo.ts` is the guard — Step 1.5
  hands it every path the issue names, and a `FOREIGN`/`OUTSIDE` verdict is a durable
  stop. It keys on the git **common dir**, never `--show-toplevel`: autopilot always
  runs in a worktree, so comparing toplevels would flag every in-repo file as foreign.
  **Step 1.5 runs before the claim, not after it.** It used to sit after Step 1's
  `autopilot:claimed` write, so a run that found the target undeliverable had already
  claimed an issue in a shared backlog and had to unwind it — the recovery was right,
  the claim should never have existed (issue #48). The guard is read-only and
  deterministic; the claim is a write other runs can see, so the cheap check goes
  first. The wider unclaimed window that buys is closed **after** the write rather
  than by ordering, because `gh issue edit --add-label` is not a compare-and-swap:
  adding a label that is already present emits no `labeled` timeline event, so the
  claim block reads the newest such event before and after its own edit and yields
  (leaving the label alone — it is the winner's) when the two match. Unreadable
  timeline means proceed, since a missing extra layer is not worse than the state
  before it existed. Under it, the wrapper's single-flight lock and Step 2.0's
  re-check still cover the rest.
  **An existing branch or worktree is reported with evidence, not as a bare
  verdict.** `SKIP: #N in-progress:<branch>` gave an operator who had just created
  that worktree himself nothing to act on, and staleness had to be judged by hand in
  seven sessions over fifty days (issue #60). `liveness()` reads the tip commit's age
  and sha, whether the tree is dirty, how far `tasks.md` got, and whether a PR is
  open; `classify()` — pure, so `--selftest` can drive it without a repo — turns those
  into **LIVE** (dirty, a commit inside `SPECKIT_AUTOPILOT_LIVE_WINDOW_MIN`, default
  120, or an open PR) or **STALE**. **Every unknown votes LIVE**: reaping a running
  sibling's worktree is unrecoverable, while refusing a dead one costs a human the one
  command the STALE output now prints. STALE downgrades the verdict on exactly one
  path — an *attended* explicit-issue run, which gets `RESUME:`/`CLEAN:` lines to
  choose between. Auto-pick and the explicit path under
  `SPECKIT_AUTOPILOT_UNATTENDED=1` (exported by `autopilot-run.ts`) keep the hard
  SKIP; that variable is the only seam between a human and a scheduled tick, since
  both reach the script as the same `preflight-issues.ts <file> <N>` call. Autopilot
  still never resumes or deletes work by itself.
  **Age means the age of the work, never of the commit it started from.** A worktree
  created seconds ago off a months-old base commit inherits that commit's date, is
  clean, and has no PR yet — enough for STALE, so the attended path offered to delete
  a sibling's checkout before it made its first edit. `worktree_touched()` supplies
  the missing creation/heartbeat stamp (the checkout's own git dir mtime plus the
  branch ref's newest reflog entry) and `classify()` takes the **most recent** of the
  two ages, so only a worktree that is both old *and* untouched is called stale.
  `has_open_pr()` is tri-state for the same reason: a `gh pr list` that failed on
  auth or network returns `None`, not `False` — collapsing it would have let a
  worktree with an open PR be offered for deletion, and every unknown votes LIVE.
  **A bare issue number is not a reference to it.** GitHub's search tokenizes the
  number, so `has_open_pr(401)` matched every open PR that discussed an HTTP 401
  and refused that issue forever, with no tree state to clean up (issue #102). A
  local `#N\b` regex over title and body decides now; the search only narrows, and
  a result set that reaches the `--limit` cap answers `TRUNCATED`, which votes
  LIVE like `None` but is reported as a truncated search rather than a failed
  one (issue #104). `locate()` anchors its globs to the start of a `/`-delimited
  segment for the same class of reason, and reads branch names from
  `git branch --no-column --sort=refname --format='%(refname:short)'` rather than from the
  output meant for people, whose `* `/`+ ` markers, colour codes and columns
  each broke the parse. The `+ ` git prints for a branch checked out in another
  worktree meant no worktree-backed branch could ever be reported STALE.
  `preflight-issues.ts --cross-repo` (passed by both the skill and the wrapper) is the
  cleanup net for deliveries that already exist — it scans an issue's own thread for
  PR links, resolves them with `gh pr view --repo`, and skips an issue already
  delivered elsewhere. It never *sources* work from another repo; a finding can only
  cause a skip. Merged beats open, closed-unmerged never counts, and the script stays
  read-only: it emits `DELIVERED: <n> <url> (<state>)` after the verdict and the
  caller parks via `park-issue.ts` — the single writer of `autopilot:blocked` and the
  `AUTOPILOT-BLOCKED:` sentinel, shared by the skill and the wrapper. Both must park:
  the wrapper exits on `SKIP:` before the skill ever launches, and a delivered issue
  doesn't stop the scan, so a run can `PICK:` a later issue while an earlier delivered
  one still needs parking.
  **`optional:` hooks are run, not skipped.** With no phase policy the coordinator
  read "optional" as "skip when unattended" and silently dropped the `after_specify`
  graphify / agent-context refreshes, leaving later phases on stale context (issue
  #14). The Operating contract now states the opposite default — run every enabled
  `before_*`/`after_*` hook for the phase, answer its `prompt:` yes, and skip only for
  a stated reason (tool missing/unauthed, or plainly inapplicable) recorded in the
  phase's issue comment. Step 3 enumerates the `after_specify` slot explicitly, and
  Steps 5–7 name their own; Step 8 *is* the `after_implement` review hook, so it
  isn't run twice.
  **And nothing runs them for you — `auto_execute_hooks` is not a runtime.** There is
  no hook executor in the `specify` CLI; the dispatcher is the core `/speckit-specify`
  command *body*, which emits an `EXECUTE_COMMAND:` block for a **mandatory** hook and
  merely ``To execute: `/{command}` `` for an **optional** one. So the two hooks the
  bullet above exists to protect — the graphify and agent-context refreshes, both
  `optional: true` — are exactly the two that never fire on their own, and Step 3 used
  to claim the opposite. Told to run a hook with no verb to run it with, the
  coordinator invented `specify hook run speckit.agent-context.update`; `hook` is not a
  command in v0.15.1 (`hooks` isn't either, and `specify event run` is the
  native-harness bridge, not this), so both hooks were silent no-ops across five
  features in `imosquera/enroute` while the run reported success (issue #45). A hook's
  registered command id **is** its slash command — `speckit.agent-context.update` →
  `/speckit-agent-context-update` — and a non-zero exit is a failure, not noise.
  `check-cli-usage.ts` already fails the install on a `specify hook` line inside a
  fenced bash block; the runtime invention is what the prose has to prevent.
  **The per-repo log is timestamped and attributed from the stream, not from the
  decoder.** `stream-decode.ts` used to stamp `datetime.now()` at decode time, so a
  buffered burst of turns minutes apart all printed on one wall-clock second and in
  an order that implied a history that never happened — the tail once read
  "reviews still running" as the last line of a pass that had already opened a draft
  PR. It now stamps each line with the event's own `timestamp` (falling back to
  now(), marked `~HH:MM:SS`, only for `result`/`system` frames that carry none), tags
  every line with the subagent that produced it (from `parent_tool_use_id`; the main
  session is untagged) using a `tool_use_id` -> label map built from
  `system/task_started`, and renders `task_started`/`task_notification` so a
  subagent's start and finish are visible. `autopilot-run.ts` tees the raw
  stream-json to `<slug>.raw.jsonl` beside the decoded log so a finished pass can be
  re-decoded after a decoder fix without re-running it. Deliberately NOT per-run log
  files: passes are already single-flight under the wrapper's lock, so what was
  missing was per-line attribution, not per-file separation.
  **The pick is ranked, not oldest-first.** `preflight-issues.ts`'s `auto_pick`
  sorts the eligible pool by (priority label, bug-before-feature, age) instead of
  taking the first row of an oldest-first fetch, so a `p0` filed today no longer
  waits behind a year-old chore. `p0`/`P1`/`priority: p2`/`priority/p3` spellings
  and the severity words (`critical`/`urgent`→p0, `high`→p1, `medium`/`normal`→p2,
  `low`→p3) all read the same, lowest rank on the issue wins, and **an unlabelled
  issue ranks `p2` — mid-pack, not last**, so an explicitly deprioritized `p3`
  chore can't outrank every untriaged bug. Below the kind term sits the **layer** term —
  `frontend` before `backend` before `integration`, unlabelled level with
  `backend` — which is what makes the mock-first split's frontend child win
  without relying on creation order (issue #56). Age stays the final tiebreak,
  so an unlabelled backlog behaves exactly as before. The `PICK:` line carries
  the winning rank (`[p0, bug, frontend]`); the explicit-issue path prints no rank because a
  typed number is already a choice. `--cross-repo` now runs per candidate in rank
  order until one is not already delivered, instead of only against the oldest.
  The writer of this vocabulary is the git extension's `label-issue.ts` — keep
  `PRIORITY_RE`/`PRIORITY_WORDS`/`BUG_LABELS`/`LAYER_RANKS` in sync with it.
  Eligibility also honours **dependencies**: an issue whose body says
  `Blocked by: #N` is skipped while any named issue is still open
  (`blocked_by()`, checked against the fetched open-issue list, so it costs no
  `gh` calls). This is what keeps autopilot off the wire-up child of a
  `/speckit-git-issue` layer split until its frontend and backend siblings land.
  **A wrapped `Blocked by:` is one line** — same rule as `diff-minimal`'s folded
  logical lines, duplicated because that fix lives in another installable item's
  script tree. Matching the physical line lost every ref after the first, so
  `Blocked by: #43,\n#44` read as unblocked the moment #43 closed (issue #76).
  A blank line, a bullet, or a new `key:` ends the marker; folding one line too
  many only over-blocks, which is the safe direction.
  `preflight-issues.ts --selftest` is the check.
  **Ceremony is proportional to the change.** Step 2.5 is the fast path: a change
  that touches one behaviour in ~1–3 files with nothing structural and no real
  ambiguity skips Steps 3–6 entirely — no `spec.md`, `plan.md`, or `tasks.md` — and
  implements directly. Four documents for a three-line diff cost more than the work
  and bury the diff in review. It is safe to skip the spec because `create-pr.ts`
  falls back to the branch name for the PR title when there is none. Review, the
  commit, and the draft PR are **not** skippable on that path — they are the only
  gates left — and the moment the edit spreads past those bounds the run bails back
  to `/speckit-specify` and Steps 3–7.
  Plus `/speckit-autopilot-schedule` to put `.run` on a recurring launchd timer (default every 2h, configurable; opt-in, macOS-only)
- `git` — feature branches + worktree + linked GitHub issue (numbered to match the spec), issue sync via `speckit.git.issue` on the `after_specify` hook, clean, PR, auto-commit hooks across all phases.
  `/speckit-git-issue` also owns **triage labels**, the input side of autopilot's
  ranked picker: `label-issue.ts` is the single writer of `p0`..`p3`,
  `bug`/`feature` and `frontend`/`backend`/`integration`, plus the `mock-first`
  and `epic` markers — creating any label the repo lacks and keeping each axis
  exclusive (`--priority p1` removes the other three; `--layer backend` removes
  the other two). Markers are independent and only ever touch themselves.
  **The spec→body render is a script, not prose.** `sync-issue-body.ts` is the
  single renderer and the single `gh issue edit --body` on the sync path: the
  command file used to describe the render in prose, so every run re-derived it
  in a fresh heredoc and four unattended runs in one 24-hour window each invented
  a different, incompatible scheme for the human report the sync overwrites
  (issue #63; the policy half is #61). The `<!-- speckit:original-report -->`
  sentinel is what makes a re-sync idempotent — the first sync files the existing
  body verbatim below it (a `/speckit-git-feature` stub is recognised and not
  preserved as a report), every later sync rewrites only the region above it and
  carries that region across byte for byte. Nothing wraps the preserved text, so
  the next run reads back exactly what the last one wrote. It also carries the
  `<!-- speckit:work-breakdown -->` block through and re-emits it last, which
  makes the "sync before the split" ordering belt-and-braces instead of the only
  thing preventing duplicate children — a hand-rolled `gh issue edit --body` still
  erases it. It **refuses** rather than repairs: exit 2 leaves the issue
  untouched when the composed body would drop either region. `--render-only` is
  the create path (nothing to preserve yet), `--body-file` lets a caller own the
  prose while keeping the surgery, and `./test-sync-issue-body.ts` is the check.
  **A manual `/speckit-git-issue` with no linked issue checks for a duplicate
  before it creates anything.** `find-duplicate-issues.ts` is the scan: it
  reduces the prospective title to its distinctive tokens and searches each one
  **separately**, because GitHub ANDs the terms of a single query and a
  full-sentence search returns nothing; candidates score one point per distinct
  token hit plus one per token that also lands in *their* title, and closed
  issues are in scope on purpose ("already fixed" and "already declined" are
  both answers). The score only ranks — the agent reads the candidates and the
  human decides, via `AskUserQuestion`, between merging into `#N`, filing
  cross-linked, and stopping. Two rules keep the merge honest: it runs **before**
  the clarify pass (nothing to clarify on an issue you are about to merge away),
  and adopting `#N` means folding that issue's own report into `spec.md` first —
  the body is regenerated from the spec on every later sync, so a reporter's
  repro steps left only on the issue are erased by the next `after_specify` run.
  Unattended it never merges and never files: it prints the candidates and
  leaves the feature unlinked, since silently rewriting a stranger's issue body
  is worse than an unlinked feature. `--no-dupe-check` skips it; `--dupe-check`
  forces it on the update path.
  **A manual `/speckit-git-issue` with no linked issue clarifies before it
  creates.** It runs `/speckit-clarify` first when the spec still carries
  `[NEEDS CLARIFICATION]` markers or no `## Clarifications` session, then asks the
  issue-shaped gaps clarify does not cover (definition of done, reproduction, what
  is out of scope, the layer when the split is ambiguous) in **one**
  `AskUserQuestion` call batched with the priority/kind question. Delegating to
  clarify is not stylistic: the body is regenerated from `spec.md` on every later
  sync, so an answer captured only in the issue body is erased by the next
  `after_specify` run — every answer must land in `spec.md`, and the spec must be
  re-read after clarify returns or you publish the pre-clarification copy. Never on
  the `after_specify` hook path (it fires seconds after `/speckit-specify`, and
  clarify is the operator's own next step) and never unattended; `--no-clarify` /
  `--clarify` override.
  The command asks the human
  for a priority — leading with the value it would infer, marked recommended — and
  falls back to inferring **only** when nobody is in the loop (the `after_specify`
  hook under autopilot), saying so when it does; an existing human-set priority is
  never re-asked or overwritten. Label failures are warnings, never errors.
  **A full-stack feature is filed as three issues, not one, and the frontend one
  is always a mock.** `split-issue.ts` turns the tracking issue into a parent with
  `frontend(mock): T`, `backend: T`, and `wire-up: T` children. The frontend child
  is `mock-first`: built against static in-repo fixtures with **no network calls at
  all**, so it starts immediately, is reviewable on its own, and freezes the data
  shape the backend child then implements; the wire-up child retires the fixtures.
  Three pieces of the mechanism are load-bearing and easy to break:
  the **layer term** in `preflight-issues.ts`'s `rank_key`, which ranks
  `frontend` < `backend` < `integration` (and an unlabelled issue level with
  `backend`) between the bug/feature term and the age tiebreak — that is the
  implementation of "mock first". It used to fall out of `split-issue.ts`'s
  creation order via the age tiebreak, which silently inverted the moment
  anyone raised the backend child's priority, titled it `fix: …`, or let
  `upsert` adopt an older backend issue (issue #56); the wire-up child's body carries
  `Blocked by: #fe, #be`, which `preflight-issues.ts`'s new `blocked_by()` resolves
  against the open-issue list it already fetched (no extra `gh` calls, and a
  dependency absent from that list counts as closed); and the parent is labelled
  `epic`, already a member of the picker's `BLOCK` set, so autopilot works the
  children instead of re-implementing all three from the parent in one pass.
  The split is idempotent — the parent's `<!-- speckit:work-breakdown -->` block is
  the registry of children, so a re-spec **edits** the existing three rather than
  opening a second set — which means the parent body sync must run **before** the
  split, never after, or the block is erased and the next run duplicates. Each
  breakdown line must **lead with its layer word** (`- [ ] integration — wire-up…`);
  the parser anchors there, and a line reading `- [ ] wire-up …` made the
  integration child invisible to re-runs. A child is never split again: it carries a
  layer label and a `Parent: #N` line. Single-layer specs get the layer label and no
  split — and a frontend feature against an API that already exists is `frontend`
  but **not** `mock-first`. `seed-graph.ts` builds the worktree's knowledge graph at creation
  (from both `worktree-add.ts` and `create-new-feature.ts`, best-effort, skippable
  with `SPECKIT_SKIP_GRAPH=1`) — graph-first navigation was switching itself off in
  exactly the checkout where feature work starts. It passes the worktree path
  explicitly, because a bare `graphify update` rebuilds whichever project the CWD
  resolves to. Version control follows the repo's own choice: an **untracked**
  `graphify-out/` goes in `info/exclude` so a rebuild is never committed by
  accident, while a **tracked** one is left tracked and visible (no exclude, no
  `skip-worktree`, and an earlier run that hid it is healed) — a repo that commits
  its graph so every checkout and CI runner shares one is making a deliberate
  choice. `./test-graph-tracking.ts` is the check.
  `install-deps.ts` is its sibling on the same two creation sites (same
  best-effort contract, skippable with `SPECKIT_SKIP_INSTALL=1`): a linked
  worktree gets the tracked files and nothing else, so six autopilot runs in
  three days each rediscovered the empty `node_modules` **mid-implement**,
  through a `tsx: not found` after the code was already written (issue #51).
  The install was never the cost — the interrupt and the diagnosis were.
  **The base checkout is the oracle, not a hard-coded list:** a directory is
  installed only when the same directory in the main worktree already carries
  the ecosystem's installed marker (`node_modules/`, `.venv/`), which is what
  makes one script right for a three-workspace monorepo *and* a silent no-op
  for a docs repo without a config schema. Manifests come from `git ls-files`
  (so vendored trees are never walked), the package manager is read off the
  lockfile rather than assumed to be npm (`bun`/`pnpm`/`yarn`/`npm ci`, plus
  `uv sync`/`poetry install`), the installs run concurrently, and every path
  exits 0 — a worktree without dependencies is a worse worktree, a worktree
  that failed to be created is no worktree at all.
  **A workspace child is installed by its root, never on its own.** A pnpm/npm
  workspace keeps one lockfile at the top, so a child package matched the
  no-lockfile fallback and got `npm install` — running concurrently with the
  root's `pnpm install`, writing a `package-lock.json` into a tree pnpm was
  mid-install on. Each node manifest now resolves to the nearest ancestor
  carrying a lockfile and the plan is deduplicated by that directory. The base
  checkout's path is likewise read whole out of `git worktree list --porcelain`
  rather than as an awk field: split on the space, `~/My Code/repo` resolved to
  `~/My` and every install was silently skipped for that repo.
  `./test-worktree-deps.ts` is the check.
  **`/speckit-git-clean` never re-derives its own safety check.** Every
  destructive step — the `--force` reset, the issue close, the worktree removal,
  the `branch -D` — sits behind `verify-landed.ts <branch>`, and a non-zero exit
  refuses unless `--force` is passed. It exists because this repo squash-merges
  and a squash breaks ancestry: `git branch -d`, `git branch --merged` and
  `git merge-base --is-ancestor` all report "not merged" for work that is safely
  on main, so fifteen-plus cleanup turns replaced them with a hand-typed path
  list — `functions web infra` one run, `functions web specs .github` the next —
  and a run that omits a path deletes a branch holding work in it (issue #49).
  The path list is the defect, so the script takes none: it compares **the
  branch's own touched paths, derived from its commit history**, minus only the
  exclusions `commit_exclude` already declares. The *history*, not the endpoint
  tree diff against the fork point — that diff forgets a path the branch changed
  and later changed back, so a branch squash-merged and then given a commit
  reverting one file to its fork-point content read as LANDED off the paths that
  still differed, and cleanup would have deleted the unmerged revert. Not the two
  whole trees either — that
  flags every unrelated commit the base has taken on since, and a gate that
  cries wolf on a moving `main` is one nobody reads. Ancestry is still tried
  first (a true merge answers cheaply); content equivalence is the squash and
  rebase case. The base is resolved **remote-tracking ref first**, local branch
  only as a fallback: a GitHub squash merge moves `origin/main` and leaves the
  local `main` where it was, so preferring the local branch compares a landed
  feature against a base that predates its own merge and forces the operator onto
  `--force`. **`UNKNOWN` is a refusal, never a pass**: an unresolvable base or
  an unknown branch exits 2 and the branch stays — and so is an *unrunnable*
  check. `clean.ts` fails closed rather than skipping: a detached HEAD (no branch
  name) is verified by its commit sha, and no resolvable HEAD or a missing /
  non-executable `verify-landed.ts` refuses unless `--force`. A condition that
  silently skips on those turns exactly the unverifiable cases into an unverified
  delete. `./test-verify-landed.ts` is the check.
  `create-new-feature.ts --source-issue N` binds a worktree to an **already existing** issue: it skips `gh issue create`, numbers from `N` unless `GIT_BRANCH_NAME`/`--number`/`--timestamp` fixes the name, writes the `source_issue` linkage into `.specify/feature.json` itself, and leaves the pre-existing issue title alone (only stubs it created get the `NNN: ` prefix). Without it, `GIT_BRANCH_NAME` alone leaves the worktree unlinked and every such caller had to post-patch `feature.json` in a second step (issue #44). `/speckit-git-pr --draft` is the human-review handoff mode: it passes `--draft` to `gh pr create` directly (no create-then-`gh pr ready --undo`) **and** skips the `/speckit-archive-feature` pre-step, so the tracking issue stays open and the spec stays unarchived until a human merges — autopilot's Step 9 uses it (issue #28). Every PR it opens is titled `#N: <spec H1>` — a prefix, never a trailing `(#N)`, since GitHub appends `(#<pr>)` itself on a squash merge and a title with both reads as two PR numbers; the squash commit subject uses the same string. It also inherits the tracking issue's **labels** (`pr_copy_labels`, default on) and carries an **agent-session footer** (`pr_session_footer`, default on) — the `claude --resume` id, the git author, and the claude.ai link. Both are read by `create-pr.ts` from `gh`, `git config`, and `CLAUDE_CODE_SESSION_ID`/`CLAUDE_CODE_BRIDGE_SESSION_ID` in the environment — **never passed in from the agent prompt**, because a model reporting its own session id hallucinates it and a wrong resume id is worse than none. Labels go on with `gh pr edit` *after* the PR exists, not `gh pr create --label`, which fails the whole create on one unknown label; `autopilot:*` is filtered out as run-state. `commit_exclude:` in `git-config.yml` lists repo-tracked generated artifacts whose canonical copy CI rebuilds on the default branch (`graphify-out/`), and **`scrub-commit-exclude.ts` is the single handler for them** — it unstages those paths, restores tracked edits to HEAD, drops untracked output, and reports every line it discarded. The untracked list is re-read **after** the unstage, never before: `git restore --staged` turns a staged *addition* into an untracked file, so the one reading taken up front is stale in exactly the case this exists for — a freshly generated dated snapshot swept up by the flow's own `git add -A` — and the scrub reported success while leaving `?? graphify-out/` for the next `git add` to commit. `create-pr.ts` and `clean.ts` call it, since those are where stray output could reach a branch (issue #62). `auto-commit.ts` does **not**: scrubbing at every phase boundary discarded each graph rebuild before the next phase could use it; it only holds the paths out of its commit with a `:(exclude)` pathspec and unstages any already staged (issue #109). One handler also replaces the six improvisations each phase had for a background graph rebuild dirtying the tree on its own, which blocked the squash, the pull, and the cleanup step in three different ways; a rebuild **in flight** is waited for on a bounded timeout rather than raced, and `--require-clean` exits 2 when anything outside the excluded paths is dirty, since that is real work and the caller should still refuse (issue #55). `create-pr.ts` additionally resets them to the base before opening the PR: the working tree is the handler's job, but a divergence already **committed** on the branch is invisible to it. The reset removes the path from the index *before* restoring the base's copy, because `git checkout <base> -- <dir>` leaves branch-added files behind and a dated snapshot dir is entirely branch-added. `./test-commit-exclude.ts` is the check. The extension ships **one implementation only** (see *No PowerShell* above) — the twin was deleted rather than taught the same rules, since a second copy of a handler whose whole point is being the single one is a second place for it to drift. Empty by default (issue #22)
- `progress` — companion to the `progress-report` preset: `before_tasks`/`before_implement` lifecycle hooks that mark those two phases active on the dashboard card. Exists because presets can't declare hooks and the preset's `wrap` is clobbered whenever another preset **replaces** the same command body; a hook fires regardless. Since #25 the `before_implement` half is belt-and-braces — `/speckit-implement` now composes properly — but `explicit-task-dependencies` still **replaces** `speckit.tasks`, so the `before_tasks` hook remains the only thing covering that phase. Owns no writer — resolves the preset's `progress_report.ts` and no-ops if absent. Install alongside the preset.
- `review` — multi-agent code review, **one engine for every scope**: `/speckit-review-run`
  reviews the feature branch (Mode A), the working directory (Mode B), or a GitHub PR
  (`--pr N`, Mode C) with the same agents (code — incl. security/performance — arch,
  comments, tests, errors, types, simplify). `/speckit-review-pr` was deleted in 2.0.0:
  it was a second, weaker engine (four inline passes, no scope contract, no hang
  recovery) that drifted from the first and competed for the same triggers.
  **Mode C resolves where the PR can be read, not just what changed.** Files come from
  `gh pr diff`, `diff_base` is the merge-base of `origin/<base>` and the head sha
  (fetched if absent; unobtainable is exit 1, never an empty review). If a local
  worktree has the head branch checked out, `repo_root` is that worktree
  (`checkout: worktree`) and the coordinator verifies its HEAD **sha**, not the branch
  name — a local branch behind the PR reviews a stale copy that reads exactly like the
  PR. Otherwise `checkout: none`: reviewers read only through git objects
  (`git show <head>:<path>`), and the report says it was read-only. Worktree paths are
  read whole from `git worktree list --porcelain` (they contain spaces), and a fork
  PR's branch name never binds a same-named local worktree. `--comment` posts the
  final report with `gh pr comment --body-file`.
  **The coordinator applies ponytail cuts; reviewers never edit.** `simplify` runs
  `ponytail:ponytail-review` on the change and `ponytail:ponytail-audit` on the touched
  files **whole** — never the repo, which would break `diff-minimal`'s scope — only when
  listed as available skills, and does both passes by hand otherwise. Step 8 applies
  the behaviour-preserving ones after every reviewer returns (an earlier edit races the
  reviewers), snapshots files first and restores from the snapshot rather than git
  (Modes A/B hold uncommitted work), reverts any cut that breaks a gate that passed at
  baseline, and reports `net: -N lines`. Never in Mode C `checkout: none`; `--no-fix`
  opts out. `progress-report`'s `SUBSTEPS` carries `arch`; keep it in sync with the
  aspect list, since an unknown substep key is a hard exit there.
  **The coordinator hands each reviewer its scope; it never lets one infer it.** A
  subagent inherits the session cwd — regularly the main checkout on `main`, not the
  feature worktree — so a reviewer once produced confident findings about an unrelated
  working tree, and a review of the wrong tree reads exactly like a review that passed
  (issue #52). `detect-changed-files.ts` therefore emits `repo_root` (absolute) and
  `diff_base` (the merge-base, empty in Mode B) alongside the file list, and
  step 6a of `run.md` requires both verbatim in every reviewer prompt, with a
  `SCOPE ERROR:` refusal — not a review of whatever was lying around — when the branch
  or the range doesn't check out. Two turn-burners are named in the same step: 6b
  forbids status-only turns after dispatch (the model already knows not to poll and
  polls anyway — eleven consecutive no-op turns in one run), and 6c gives the hang its
  recovery (no output and no elapsed-time movement for 10 min → `TaskStop`, run that
  aspect inline, and report it as `degraded`, never as a clean pass).
  **A base, not a `base...HEAD` range, and the file list — not the diff — is the
  authoritative scope.** Three-dot compares two commits, so it drops the staged and
  unstaged work the detector lists in the same breath; and no diff of any shape shows
  an untracked file, in either mode. A reviewer handed only a commit range silently
  reviews the committed half of the change and calls it a pass. The PowerShell twin
  was deleted rather than kept in sync: nothing here runs on Windows, and a second
  copy of this logic is a second place for it to drift.
  `./test-review-scope.ts` is the check
- `stale-tasks-guard` — `before_implement` lifecycle hook that halts `/speckit-implement` when `spec.md` was modified more recently than `tasks.md` (the signal that a late `/speckit-clarify`/`/speckit-specify` edit invalidated the task plan), directing the operator to re-run `/speckit-tasks`; `--force` bypasses with a logged acknowledgement. Shipped as an extension rather than a preset wrap/replace so it fires regardless of which preset owns the `/speckit-implement` command body.

**Presets**
- `claude-ask-questions` — interactive clarify/checklist for Claude
- `explicit-task-dependencies` — `tasks-template` with explicit dependency edges + Execution Wave DAG; overrides `/speckit-implement` to fan each wave's `[P]` tasks out to subagents in parallel
- `functional-constitution` — `/speckit-constitution` **wrapper** that injects and normalizes a mandatory functional-programming governance section. Stacks with `parse-dont-validate`'s constitution layer: both match their section by title (not roman numeral) and renumber all principle sections sequentially, so neither clobbers the other (issue #37)
- `spec-minimal` — one job: artifact minimalism. Wraps `/speckit-specify` to strip `## Assumptions`, `### Key Entities`, and `## Success Criteria` from `spec.md`; wraps `/speckit-plan` to hold the feature tree to `spec.md`, `plan.md`, `tasks.md`, `checklists/`, and optional `quickstart.md`/`research.md` — only `data-model.md` and `contracts/` are forbidden. `checklists/requirements.md` is written by core's own `/speckit-specify` and `research.md` by the stacked `library-research` preset, so forbidding either made the enforcer delete a file another shipped item had just written; the allow-list is `ALLOWED` in `enforce-minimal-tree.ts` and this line has been wrong often enough to get the same bug filed three times (#27, #31, #46). Enforced by a mandatory prompt rule plus the self-healing `scripts/ts/enforce-minimal-tree.ts`, which folds any forbidden artifact into `plan.md` under a sentinel block and deletes it; unknown top-level entries only warn, so stacking is safe
- `diff-minimal` — sibling to `spec-minimal`, and the distinction is the whole
  point: that one makes the **spec** shorter, this one makes the **change**
  smaller. A spec that faithfully restates an issue's seven-file wish list yields
  a seven-file diff because nothing ever asks whether the change needs those
  files (seasonpass#182: a composite index for a query the database already
  served, and a rules edit nothing evaluates — two of seven, both removable).
  Wraps `/speckit-specify` with a minimum-diff mandate (re-derive every path and
  precondition the issue asserts against current `main`; extend before adding;
  every file the issue names is a hypothesis; no drive-by refactors) and makes
  two sections mandatory: `## Corrections to the issue as filed`, which reaches
  the tracking issue for free because `/speckit-git-issue` renders whatever
  sections `spec.md` contains, and `## Scope discipline`, whose
  `**MUST NOT touch:**` backticked-glob list is the machine-checkable half.
  `check-scope-sections.ts` asserts both exist and are populated after specify —
  `None.` is an accepted answer for either, since a spec with no corrections
  should say so rather than invent one — and the `/speckit-plan` wrap runs
  `check-plan-scope.ts`, which fails with `file:line` when `plan.md`/`tasks.md`
  plan work in a forbidden path. It reads the **artifacts, not the diff**: at
  plan time there is no diff, and the plan is the cheap moment to catch it.
  Two exemptions keep it from crying wolf (a checker that does gets disabled
  within a day): lines whose own text negates (`MUST NOT`, `out of scope`, …)
  and everything under a heading matching scope/non-goals/corrections/constraints.
  Both checkers read **folded logical lines**, never physical ones
  (`scope-common.ts`'s `logical_lines()`, which reports the line the block
  started on). These artifacts are prose and every editor wraps prose: matching
  physical lines ended a `MUST NOT touch:` list at its first continuation —
  nine paths silently became one and the gate passed — and stripped the
  negation off a wrapped restatement in a plan, flagging it as a violation
  (issue #68). A wrapped bullet is one bullet.
  **Only a bullet or a `**marker:**` line accepts a continuation; prose never
  folds**, and that asymmetry is load-bearing rather than lazy. Folding
  consecutive prose lines makes two sentences of one paragraph a single logical
  line, so a negation in the first silently exempts a violation in the second —
  a wrongly-exempted violation is a worse failure than the truncation being
  fixed. Both defects #68 reports were wrapped *bullets*; prose never needed it.
  **It mandates the smallest change, not small changes** — a migration or a
  rename is legitimately wide, and the escape hatch is an explicit
  `**Scope justification:**` line. A sibling preset rather than an extension of
  `spec-minimal` because that one is a pure deterministic post-processor and this
  adds a prompt layer; both sit at the default priority 10 and compose as `wrap`
  layers in id order, and the stripper never touches either new section
- `spec-ui-preview` — adds a GitHub-safe inline HTML UI preview to UI-touching specs (split out of `spec-minimal`)
- `button-design` — `wrap` layers on `speckit.specify` and `speckit.plan` that hold
  every UI-touching feature to button-design rules. The spec gets a mandatory
  `## Actions & Buttons` table (screen, label, `button`/`link`, primary/secondary/
  tertiary, destructive safeguard) or an explicit `None — no user-facing UI.`; the
  plan gets `## Button System` with five populated markers (Component, Color roles,
  States, Touch targets, Placement). `check-buttons.ts spec|plan` is the gate and
  checks only what is mechanical: at most one primary per screen, links take no
  role, 1–3 word non-generic button labels, destructive labels name their object and
  carry a confirm/type/undo safeguard, no touch target under 44×44. Jargon,
  "match the moment", and placement quality stay prompt-only, because a checker
  that guesses at prose cries wolf. A screen with buttons and no primary is a
  note, not a failure: a toolbar has none. `selftest-button-design.ts` is the check
- `tdd` — `wrap` layer on `speckit.implement` that runs every behaviour-changing
  task through Red-Green-Refactor: list the scenarios, then per scenario write one
  test, run the whole suite and see it fail **for the expected reason** (a syntax
  error or broken harness is not Red; a test that passes at once is flawed or the
  behaviour exists, never Red), write the simplest code that passes, refactor test
  and production code with the suite green, commit, repeat. The cycle block is
  copied verbatim into every subagent prompt, and with `explicit-task-dependencies`
  a story's test tasks are the Red wave, confirmed failing before the
  implementation wave starts. **Priority 11**, inside `parse-dont-validate` (9),
  outside `explicit-task-dependencies` (20). Gated on a green suite and
  `check-tests-accompany.ts` (exit 1 when production source changed since the
  merge-base with no test file changed; 4 on an empty change set, which is not a
  pass). Red-before-green itself is recorded per scenario in the report, not
  checked mechanically. That same release made tests mandatory in
  `explicit-task-dependencies`' tasks template.
  **Jev assist (issue #116)** is optional: the shared `jev.ts` (see *Jev* below)
  answers the four bounded judgment calls (`red-reason`, `baseline`, `covers`,
  `exempt`), and every call's `record` goes into the per-scenario record.
  `red-reason` is gated: shadow mode until `SPECKIT_JEV_AUTOMATE=red-reason`
  (or the legacy `TDD_JEV_AUTOMATE_RED=1`). `selftest-tdd.ts` checks the gate;
  `scripts/selftest-jev.ts` checks the cases
- `library-research` — `/speckit-plan` wrapper (chainable via `{CORE_TEMPLATE}`) that, after the plan is written, uses live web search to check whether existing libraries can replace hand-rolled build-it-yourself surface area (auth, parsing, queues, retries, etc.); writes findings + a recommendation per unknown to `research.md` and revises `plan.md` in place when a library is a clear win. No-ops when the plan has no such surface area.
- `ponytail-plan` — `wrap` layer on `speckit.plan` that applies the ponytail ladder
  (YAGNI → reuse → stdlib → native → installed dep → one line → new code) at the
  phase where new files, abstractions, dependencies and config knobs get committed
  to — the implement prelude can only shrink what the plan already chose, and
  `library-research` pushes the other way. Every proposed addition is climbed; a
  rung-1 item is cut and a rung-2–6 item is rewritten in `plan.md`, not merely
  noted. The record is a mandatory `## Ladder` table (`Item | Kind | Rung | Reason`)
  or `None — extends existing code only.`; a new dependency (rung 7) needs a
  `**Dependency justification:**` line. `check-ladder.ts` checks only the mechanical
  half. **Priority 8**, so it wraps outside `parse-dont-validate` (9) and every
  default-10 plan layer and judges what they wrote; sharing 8 with
  `implement-prelude-skills` is harmless since that one targets implement only. The
  ladder is embedded, so the plugin is optional. `selftest-ponytail-plan.ts` is the
  check
- `portfolio-audit` — portfolio-wide `/speckit-analyze` override
- `worktree-isolation` — forces `/speckit-implement` to run inside the feature worktree
- `implement-prelude-skills` — `/speckit-implement` override that invokes the `ponytail:ponytail` skill (when available) as a mandatory prelude before implementation begins. Implementation-discipline skills only: a prose-register skill compresses the very audit trail an unattended `/speckit-autopilot-run` depends on, so it does not belong in the prelude (issue #72)
- `parse-dont-validate` — overrides `/speckit-constitution` (injects a canonical "Parse, Don't Validate" governance section), `/speckit-plan` (requires a "Parse Boundaries" design section: trust boundaries + branded domain types + parsers; chainable via `{CORE_TEMPLATE}`), and `/speckit-implement` (applies the discipline while writing TypeScript/Python, then gates completion on a deterministic scanner — Python via its own tokenizer (it no longer runs Python), TypeScript via a bun-run helper on a pinned `oxc-parser` from the machine cache, so no TS install is needed — flagging `any`/`Any`, stray `JSON.parse`/`json.loads`, boolean validators, and narrowing casts outside parser modules). **The gate scans TypeScript only for now**: Python files are skipped, not flagged, unless `PDV_PYTHON=1` — the Python scanner and its tests stay, so turning it back on is that one variable.
  **The gate is one invocation: `parse_dont_validate.ts scan --new-only`.** The two
  deterministic steps around it used to be driven by hand every run (issue #66) and
  both had exactly one right answer: change-set detection now anchors at the git
  worktree root instead of the cwd — `git diff --name-only` reports root-relative
  paths while `git ls-files --others` is limited to the cwd subtree, so a scan
  started from `functions/` collapsed to the untracked files below it and a
  one-file scan reads exactly like a clean gate — and `--new-only` re-scans the
  base ref's copy of the same files and subtracts what reproduces there, replacing
  the hand-diff against `main`. Findings are matched by (file, rule, source text),
  never line number, so shifted code stays pre-existing.
  **A scan that examined zero files never exits like a clean pass** (issue #50).
  Every path that ends in "nothing was examined" now has its own loud exit: an
  unknown option or a `--base` with no ref is `2`, paths that resolve to no file
  or a cwd outside any git worktree is `3`, and an empty change set is `4` — the
  one non-zero the implement gate may proceed past, and only for a run that truly
  wrote no TypeScript or Python. They all used to print
  `no TypeScript/Python files to scan` and exit `0`, so a typo in the flag was
  indistinguishable from a passing gate. The bun helper is the same defect one
  layer down: it reads a JSON job on **stdin** and ignores file arguments, and a
  direct call with filenames printed `{"findings":[]}` — it now refuses file
  arguments, empty/malformed stdin and a zero-file job, and an unreadable source
  is an error rather than a silent skip. It never resolves anything from the
  project, so a monorepo package scans the same as the root while the driver
  stays anchored at the repo root for git paths. `./test-pdv-changeset.ts`
  is the check
- `progress-report` — wraps the five cycle commands (specify/plan/tasks/implement/review) to keep a per-branch status card current in an agent-os dashboard repo (default `~/Code/agent-os`, configurable via `AGENT_OS_DASHBOARD`); rewrites `<dashboard>/branches/<slug>.md` with per-phase status + review substeps on each transition, no-op when the dashboard is absent. The `wrap` on tasks/implement is dropped when another preset **replaces** those bodies, so pair it with the `progress` **extension** (above), whose lifecycle hooks cover those two phases clobber-immune.

`spec-minimal` 2.0.0 is a breaking split: UI preview → `spec-ui-preview`, issue sync → the `git` extension. See the migration note in `README.md`.

## Jev: bounded judgment calls

`scripts/jev.ts` asks TypeSafe's Jev (through `@typesafe-ai/sdk`) the yes/no and
pick-one questions the pipeline used to pause on, and is the **canonical copy**:
every item that asks Jev ships a byte-identical `scripts/ts/jev.ts`, because
items install into a consumer independently. `check-script-paths.ts` fails the
install on a drifted copy — edit `scripts/jev.ts`, then `cp` it over every copy.

| Case | Asked by | Acts on its own |
|---|---|---|
| `red-reason`, `baseline`, `covers`, `exempt` | `tdd` | all but `red-reason` (gated) |
| `duplicate` | `git` duplicate scan | `distinct` drops a candidate; `duplicate` is gated (a recommendation until automated) |
| `priority`, `kind`, `layer` | `git` `/speckit-git-issue` | yes — the recommended answer when a human is asked |
| `fast-path` | `autopilot` Step 2.5 | yes; never over the hard rules (`epic`, spreading past bounds) |
| `finding`, `same-finding` | `review` coordinator | yes, except dropping a `false_positive` (gated) |
| `spec-change` | `stale-tasks-guard` | only `wording` (p ≤ 0.15), which skips the halt |
| `applies-ui`, `applies-library` | `button-design`, `spec-ui-preview`, `library-research` | only `skip` |

The contract is the same everywhere: exit 0 acts on `decision`; exit 3 means
decide **exactly as before Jev** (no `TYPESAFE_API_KEY`, `SPECKIT_JEV=off`, no
SDK, any API error, confidence under 0.85, `none_of_these`, or a gated verdict
in shadow mode); every call prints a `record` that goes into the caller's
report. Questions stay bounded: one-sentence criteria, and every Choice carries
`none_of_these`. A gated verdict decides only once its case is in
`SPECKIT_JEV_AUTOMATE` (comma list or `all`), which is lifted only after
`jev.ts measure --case C --records F` has replayed past records. The key comes
from `TYPESAFE_API_KEY`, else the user's key file (`$XDG_CONFIG_HOME/typesafe/key`,
then `~/.typesafe_key`) — so Jev is on wherever that file exists, including
launchd runs that never source a shell profile — and never from an argument, a
log line, or a file in the repo. The SDK is resolved from the
project, then beside the script, then `~/.cache/speckit-squads/jev`, which the
first use fills with `bun add` — never `.specify/` (consumers commit it) or the
project's dependencies. `scripts/selftest-jev.ts` drives every case through the
real SDK against a fake server and checks the copies.

## When you add a new extension or preset

1. Drop the new directory under `extensions/<id>/` or `presets/<id>/` with a valid manifest. The install/uninstall scripts will pick it up automatically — do **not** edit them.
1a. **Declare every script under `provides.scripts:`** with `file:` and, when one command owns it, `command:`. This is not decoration — `check-cli-usage.ts` fails the install when a command file references a script that is undeclared or missing, and `scripts/gen-agent-index.ts` builds the consumer's command→script table from these entries. An undeclared script is invisible to agents working in a consumer project.
1b. If the item needs harness-level wiring (a `.claude/settings.json` hook, a
    `CLAUDE.md` rule), ship it as `scripts/ts/post-install.ts` plus a
    `scripts/ts/pre-uninstall.ts` that reverses it exactly. Declare both under
    `provides.scripts:`.
2. Update the **Currently shipped** list above with one bullet: `` `<id>` — one-line description ``.
3. Update the matching list in `README.md` so the user-facing doc stays in sync.
4. If a consumer project should pick it up, run `./install.ts --force <project>` from there.

## When you remove an extension or preset

1. `rm -rf extensions/<id>` or `presets/<id>`.
2. Delete its bullet from **Currently shipped** above and from `README.md`.
3. Run `./uninstall.ts <project>` in any consumer that still has it registered, or `specify {extension,preset} remove <id>` ad-hoc.

## Manifest references

- Extension dev guide: <https://github.com/github/spec-kit/blob/main/extensions/EXTENSION-DEVELOPMENT-GUIDE.md>
- Extension API: <https://github.com/github/spec-kit/blob/main/extensions/EXTENSION-API-REFERENCE.md>
- Preset architecture: <https://github.com/github/spec-kit/blob/main/presets/ARCHITECTURE.md>
- Preset README: <https://github.com/github/spec-kit/blob/main/presets/README.md>
