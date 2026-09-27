# speckit-squads

A collection of [Spec Kit](https://github.com/github/spec-kit) extensions and presets, packaged for local-dev installation via `specify`.

## Layout

```
extensions/   # Spec Kit extensions (commands + hooks)
  archive/         Archive completed feature folders, close linked GH issues
  autopilot/       Highest-priority eligible issue (p0..p3, bugs first, oldest last; issues with an unclosed
                   "Blocked by: #N" dependency are skipped) → draft PR,
                   driving the whole pipeline unattended (+ launchd scheduler);
                   parks hard-blocked issues with a durable autopilot:blocked label so they aren't re-picked forever;
                   bound to one repo + checkout in both directions — a fix target in another repo is a durable stop,
                   checked before the claim rather than after it, and --cross-repo preflight skips issues already
                   delivered by a PR elsewhere;
                   an existing branch/worktree for an issue is reported with evidence (dirty tree, how recently the
                   checkout itself was touched, tip-commit age, tasks done, open PR) as LIVE or STALE — a STALE one
                   offers resume-or-clean when a human named the issue, and keeps the hard skip unattended, with
                   every unknown resolving to LIVE;
                   the claim label is verified read-after-write against the issue's labeled timeline event, so a run
                   that only re-added a claim another run already holds yields instead of colliding;
                   the per-repo log stamps each line with the event's own timestamp and tags it with the
                   subagent that produced it, and the raw stream-json is tee'd to <slug>.raw.jsonl for re-decoding;
                   a small, unambiguous change skips spec/clarify/plan/tasks and goes straight to implementation
                   (Step 2.5), keeping review + draft PR as the gates
  git/             Feature-branch + worktree (graph seeded at creation via seed-graph.ts, dependencies installed via install-deps.ts) + linked GitHub issue (incl. issue sync and p0..p3 / bug|feature triage labels), clean, PR (+ --draft), auto-commit hooks;
                   a PR is titled "#N: <spec H1>" and inherits the tracking issue's labels (pr_copy_labels) and carries an agent-session
                   footer with the `claude --resume` id, author and claude.ai link (pr_session_footer),
                   both read by the script from gh/git/env, never supplied by the agent;
                   a manual /speckit-git-issue with no linked issue first searches the existing issues (open and
                   closed) for one that already covers the work and asks how to proceed — merge into it, file
                   cross-linked, or stop (--no-dupe-check skips; unattended it never merges, it just declines to file);
                   then runs /speckit-clarify and asks the
                   issue-shaped gaps (done-condition, repro, out-of-scope, layer) before creating — answers land
                   in spec.md, since the body is re-rendered from it on every sync (--no-clarify skips);
                   the spec->body render is sync-issue-body.ts, not model-authored string surgery: it keeps the
                   human's original report verbatim below a <!-- speckit:original-report --> sentinel, carries the
                   work-breakdown block through, and refuses to write a body that would lose either;
                   a full-stack tracking issue is split into frontend(mock) / backend / wire-up children — the frontend one
                   is always mock-first (static fixtures, no network) and outranks its backend sibling in autopilot's picker,
                   while the wire-up child carries Blocked by: #fe, #be and the parent is labelled epic;
                   commit_exclude keeps CI-rebuilt artifacts (graphify-out/) off feature branches — one handler,
                   scrub-commit-exclude.ts, called by create-pr/clean; auto-commit only holds them out of its commit (#109);
                   --source-issue N binds a worktree to an existing issue in one call (no post-patching feature.json);
                   /speckit-git-clean refuses every destructive step until verify-landed.ts proves the branch's work is
                   on the base — a squash merge leaves no ancestry, so the branch's own touched paths (from its commit
                   history, minus commit_exclude) are compared against the fetched origin/<base> instead of a hand-typed
                   path list that differed every run (issue #49); UNKNOWN, or a check that cannot run at all, is a refusal
  progress/        before_tasks/before_implement hooks for the progress-report preset (covers the two phases a replace-strategy preset clobbers)
  review/          Multi-agent code review, one engine for every scope: /speckit-review-run covers the feature branch, working
                   directory, or a GitHub PR (--pr N, optional --comment). Agents: code (incl. security & performance), arch,
                   comments, tests, errors, types, simplify (ponytail review + audit; cuts applied unless --no-fix).
                   2.0.0 removes /speckit-review-pr — use /speckit-review-run --pr N
  stale-tasks-guard/  before_implement hook that halts /speckit-implement when spec.md is newer than tasks.md (--force bypasses)

presets/      # Spec Kit presets (template + command overrides)
  claude-ask-questions/         Interactive clarify/checklist for Claude
  explicit-task-dependencies/   tasks-template with explicit dependency edges
  functional-constitution/      constitution override that enforces FP governance
  spec-minimal/                 Artifact minimalism: strips spec sections, keeps the feature tree to spec/plan/tasks
  diff-minimal/                 Minimum-diff mandate: re-derive the issue against main, then specify the smallest change; adds a mandatory Corrections + machine-checkable Scope discipline section and holds the plan to it
  spec-ui-preview/              GitHub-safe inline HTML UI preview for UI-touching specs
  button-design/                specify + plan wrappers holding UI features to button-design rules: one primary per screen, buttons vs links, specific labels, guarded destructive actions, a reusable button system; checked deterministically
  tdd/                          implement wrapper: Red-Green-Refactor per scenario (failing test first, simplest green, refactor on green); gated on a green suite and tests accompanying every production change
  library-research/             plan wrapper that web-searches for libraries to replace build-it-yourself surface area, writes research.md
  ponytail-plan/                plan wrapper applying the ponytail ladder (YAGNI → reuse → stdlib → native → installed dep → one line → new code): cuts or rewrites proposed files/abstractions/deps in plan.md, mandatory ## Ladder table, checked deterministically
  portfolio-audit/              Portfolio-wide analyze override
  worktree-isolation/           Forces /speckit-implement to run inside feature worktree
  implement-prelude-skills/     Invokes the ponytail:ponytail skill before /speckit-implement starts
  parse-dont-validate/          constitution + plan + implement overrides enforcing "parse, don't validate" across TypeScript + Python, with a deterministic AST scan gate (oxc-parser; TypeScript only for now, Python behind `PDV_PYTHON=1`); the gate is one command, `scan --new-only`, and a scan that examined zero files exits 2/3/4 rather than looking clean
  progress-report/           wraps the 5 cycle commands to keep a per-branch status card in ~/Code/agent-os current (pair with the progress extension for tasks/implement)
```

Each item is a self-contained directory with its own `extension.yml` or `preset.yml` manifest, conforming to Spec Kit's schema:

- Extensions: <https://github.com/github/spec-kit/blob/main/extensions/EXTENSION-DEVELOPMENT-GUIDE.md>
- Presets: <https://github.com/github/spec-kit/blob/main/presets/README.md>

**Jev assist (optional).** `tdd`, `git`, `autopilot`, `review`, `stale-tasks-guard`,
`button-design`, `spec-ui-preview` and `library-research` ask TypeSafe's Jev the
bounded yes/no and pick-one questions they used to pause on (Red reason, duplicate
issue, priority/kind/layer, fast path, finding triage, wording-only spec edit,
whether a layer applies). It is on whenever `TYPESAFE_API_KEY` is set or a key file
exists at `~/.config/typesafe/key` or `~/.typesafe_key`; `SPECKIT_JEV=off` turns it
off. Anything short of a confident answer falls back to the behaviour without Jev.
Verdicts that would drop work (a Red call, a duplicate merge, a false-positive
finding) stay in shadow mode until listed in `SPECKIT_JEV_AUTOMATE`. Details in
`CLAUDE.md` under *Jev*; `bun scripts/selftest-jev.ts` is the check.

## Prerequisite: the Spec Kit CLI

Everything here installs through Spec Kit's `specify` CLI. Install it once with `uv`, pinned to a release tag:

```bash
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@vX.Y.Z
# e.g. the current release:
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v0.12.4
```

This puts `specify` on your PATH (`~/.local/bin`). Check the [latest release](https://github.com/github/spec-kit/releases/latest) for the newest `vX.Y.Z`, and re-run the same command to upgrade. Verify with `specify --version`.

## Install into a project

Set `SQUADS` to wherever you checked out this repo, then run the commands from any Spec Kit project:

```bash
export SQUADS=/path/to/your/speckit-squads   # adjust to your checkout

# extensions
specify extension add --dev "$SQUADS/extensions/archive"
specify extension add --dev "$SQUADS/extensions/autopilot"
specify extension add --dev "$SQUADS/extensions/git"
specify extension add --dev "$SQUADS/extensions/progress"
specify extension add --dev "$SQUADS/extensions/review"
specify extension add --dev "$SQUADS/extensions/stale-tasks-guard"

# presets
specify preset add --dev "$SQUADS/presets/claude-ask-questions"
specify preset add --dev "$SQUADS/presets/explicit-task-dependencies"
specify preset add --dev "$SQUADS/presets/functional-constitution"
specify preset add --dev "$SQUADS/presets/spec-minimal"
specify preset add --dev "$SQUADS/presets/diff-minimal"
specify preset add --dev "$SQUADS/presets/spec-ui-preview"
specify preset add --dev "$SQUADS/presets/button-design"
specify preset add --dev "$SQUADS/presets/tdd" --priority 11
specify preset add --dev "$SQUADS/presets/library-research"
specify preset add --dev "$SQUADS/presets/ponytail-plan" --priority 8
specify preset add --dev "$SQUADS/presets/portfolio-audit"
specify preset add --dev "$SQUADS/presets/worktree-isolation"
specify preset add --dev "$SQUADS/presets/implement-prelude-skills"
specify preset add --dev "$SQUADS/presets/parse-dont-validate"
specify preset add --dev "$SQUADS/presets/progress-report"
```

Or use the bundled script from inside the checkout:

```bash
./install.ts /path/to/your/spec-kit-project
./install.ts --force /path/to/your/spec-kit-project   # reinstall everything
```

`--dev` records this checkout as the install source, but it does **not** symlink: `specify` copies the
directory into the project (`shutil.copytree`) for both presets and extensions. Edits made here are
therefore **not** picked up live — re-run `./install.ts --force <project>` to refresh a consumer.

The repo's own JavaScript tooling is TypeScript run by [bun](https://bun.sh) and typechecked by
TypeScript 7: run `bun install` once in the checkout, then `bun run typecheck`. The install pre-flight
runs the typecheck when bun and `node_modules` are present. The `parse-dont-validate` TypeScript scan
needs only `bun` on PATH: it parses with a pinned `oxc-parser` from `~/.cache/speckit-squads/pdv`, so
the consumer needs no `typescript` install (TS 7, TS 5 or none).

`install.ts` first runs `check-cli-usage.ts`, which aborts the install on two classes of
invented path. It verifies every `specify <verb>` a command file tells an agent to execute
against the installed CLI's actual verbs, and it resolves every **script path** a command
file names: each must exist on disk, be declared under its manifest's `provides.scripts:`,
and never point into `.specify/scripts/bash/<subdir>/` — that tree is core Spec Kit's and
is flat. It also rejects a bare `$CLAUDE_PROJECT_DIR` in a bash block: the variable is
empty in an ordinary interactive session, so the path starts at `/` and the call dies with
`exit 127` (issue #59). Each block resolves the root itself with
`PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"` — per block,
because each bash call is its own shell.

After installing, `install.ts` runs `scripts/gen-agent-index.ts`, which writes the command→script
mapping into the consumer as `.specify/extensions/AGENTS.md` plus a breadcrumb at
`.specify/scripts/bash/README.md`. Extension scripts install to
`.specify/extensions/<id>/scripts/…`, never into the flat core tree, and command names do
not predict script names (`/speckit-git-feature` runs `create-new-feature.ts`) — so the
mapping has to travel with the install rather than live only in this repo's docs.
`uninstall.ts` removes both generated files.

`install.ts` and `uninstall.ts` auto-discover every `extensions/*/extension.yml`, so new commands are included automatically once their manifest exists.

**Migrating from `spec-minimal` 1.x:** 2.0.0 is breaking — `spec-minimal` now only strips spec sections and holds the plan tree. The UI preview moved to the separate `spec-ui-preview` preset, and issue sync moved into the `git` extension. Install both to keep the 1.x behavior.

## Working with an agent on this repo

**Always hand back the PR link.** Any time an agent opens, updates, merges into, or
otherwise works on a pull request here, the reply must include the PR URL — not just
the number, and not just a description of what changed. The link is how the human
gets from the agent's summary to the actual diff; a reply without it costs a round
trip every single time.

## Authoring

Edit the manifest (`extension.yml` / `preset.yml`) and the files under `commands/`, `templates/`, or `scripts/` in place. Because installs are copies rather than symlinks, re-run `./install.ts --force <project>` (or the matching `specify ... add --dev`) in any consuming project after *any* change — command text and scripts included, not just manifests.

### Preset composition: `wrap` vs `replace`

A preset's command template declares `strategy: "wrap"` (composes with other presets on the same command, via a `{CORE_TEMPLATE}` seam that expands to the next inner layer) or `strategy: "replace"` (fully owns the command body). **`replace` is the default when `strategy` is omitted** — that default is what made five `/speckit-implement` presets silently inert (issue #25), so declare it explicitly either way.

There is no `replaces:` key. It is not in the preset schema and `PresetManifest._validate()` never reads it, so it looks like it declares intent and does nothing. Use `strategy:`.

`specify` sorts installed presets by **(priority ASC, id ASC)** — lower number = higher precedence. Composition works like this:

- The **base** is the nearest `replace` layer scanning from highest precedence downward. Only layers *above* the base compose at all; anything below it is dead.
- If the highest-precedence layer is itself a `replace`, it short-circuits and wins outright — every other layer is dropped.
- Core templates are always appended as a final `replace` layer, so a stack of pure wrappers still composes over the stock command.
- Wrappers are applied bottom-up, so the **lowest priority number ends up outermost**: its pre-seam text runs first and its post-seam text runs last.

Presets also can't declare lifecycle hooks (`before_*`/`after_*`); only extensions can. So a preset that needs to survive being clobbered by a `replace`-strategy sibling ships a companion extension with lifecycle hooks as a fallback path (see `progress` next to `progress-report`, and `stale-tasks-guard`, which is a standalone extension for exactly this reason).

### The `/speckit-implement` ordering contract

Six presets target `speckit.implement`, so their install priorities are **load-bearing**. `install.ts` passes `--priority` for each; the map lives in `preset_priority()` there and must stay in sync with this table:

| Priority | Preset | Strategy | Role |
|---|---|---|---|
| 5 | `worktree-isolation` | wrap | outermost — the `cd` must precede every write |
| 7 | `progress-report` | wrap | dashboard card |
| 8 | `implement-prelude-skills` | wrap | prelude runs just before implementation |
| 9 | `parse-dont-validate` | wrap | discipline + AST gate hug the implementation |
| 11 | `tdd` | wrap | Red-Green-Refactor cycle per scenario; green-suite + tests-accompany gate |
| 20 | `explicit-task-dependencies` | **replace** | the executor base, innermost |

Resulting execution order: worktree `cd` → progress card → prelude skills → parse-don't-validate discipline → TDD cycle → **implement** (wave DAG, or the stock loop when `explicit-task-dependencies` isn't installed) → TDD gate → AST scan gate → progress card.

`explicit-task-dependencies` stays `replace` because it genuinely substitutes wave-DAG subagent fan-out for the stock serial loop — wrapping it would execute every task twice. It sorts last so it becomes the base rather than swallowing the wrappers.

If you install presets by hand rather than via `install.ts`, pass the same `--priority` values or the composition silently degrades.

### The `/speckit-constitution` stack

Two presets inject a governance section into `.specify/memory/constitution.md`, and both are `wrap` (issue #37 — they were both `replace`, so one silently won and the other's section never reached the constitution):

| Priority | Preset | Section |
|---|---|---|
| 9 | `parse-dont-validate` | Parse, Don't Validate |
| 10 | `functional-constitution` | Functional Programming Paradigms |

Each layer runs the core flow, then edits the written constitution in place to enforce its own section. Two rules keep them from fighting:

- **Idempotency matches on the section title, not its roman numeral** — so a section stays recognized after renumbering.
- **Every layer renumbers all numbered principle sections sequentially** in document order after inserting. The numeral in a preset's canonical text is a placeholder; the outermost layer runs last and leaves the document consistently numbered.
- **Every layer repeats the core flow's bookkeeping if it changed anything.** The core flow does its version bump, Sync Impact Report, validation, and user summary *before* any wrapper runs, so a section injected afterwards is invisible to all of it. Each layer re-derives the version (added principle = `MINOR`, body-only edit = `PATCH`), amends the Sync Impact Report, and corrects the reported version — **bumping at most once per run**, so two presets each adding a principle produce one `MINOR` bump, not two.

A new preset that injects a constitution section should follow the same three rules.
