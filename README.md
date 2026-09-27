# speckit-squads-ios

[Spec Kit](https://github.com/github/spec-kit) extensions and presets that drive iOS/Swift app projects from issue to reviewed PR.

This is the iOS/Swift fork of [speckit-squads](https://github.com/imosquera/speckit-squads-ios). Only a subset of the
original items was ported, and the ones that touch code were adapted to Swift, SwiftUI, Xcode and the Swift
package ecosystems. Everything installs locally through `specify ... add --dev`.

**The target project is Swift/iOS; this repo's own helper scripts are not.** Every script shipped here
(installers, checkers, gates, hooks) stays TypeScript run by [bun](https://bun.sh), in the consumer as well as
in this checkout. Swift only ever appears as the code those scripts inspect, test or build.

## Catalog

Items marked **(iOS)** were adapted for Swift/iOS; the rest are language-agnostic and unchanged from upstream.

```
extensions/   # Spec Kit extensions (commands + hooks)
  archive/            Archive completed feature folders, close linked GitHub issues
  autopilot/          (iOS) Highest-priority eligible issue → reviewed draft PR, unattended (+ launchd scheduler);
                      gates on xcodebuild (or swift) build/test on an iOS Simulator; needs full Xcode + a simulator runtime
  git/                (iOS) Feature branch + worktree + linked GitHub issue, clean, PR, auto-commit hooks;
                      worktree deps via SPM/CocoaPods/Carthage; Xcode build output and xcuserdata never auto-committed
  review/             (iOS) Multi-agent code review of a branch, working tree or PR (/speckit-review-run [--pr N]),
                      with Swift review checklists; Xcode churn (.pbxproj, xcassets, xcuserdata) set aside (2.2.0)
  stale-tasks-guard/  before_implement hook that halts /speckit-implement when spec.md is newer than tasks.md

presets/      # Spec Kit presets (template + command overrides)
  button-design/                (iOS) SwiftUI specify + plan wrappers: one .borderedProminent per screen, roles, 44×44pt hit targets, Dynamic Type; checked deterministically
  claude-ask-questions/         Interactive clarify/checklist for Claude
  diff-minimal/                 Minimum-diff mandate: re-derive the issue against main, specify the smallest change, hold the plan to it
  explicit-task-dependencies/   tasks-template with explicit dependency edges; implement fans each wave out to subagents
  library-research/             (iOS) plan wrapper: Apple frameworks → apple/swift-* → Swift Package Index before hand-rolling; writes research.md
  parse-dont-validate/          (iOS) constitution + plan + implement overrides for "parse, don't validate", gated by a bun-only Swift lexer (PDV001–005: Any, stray decoding, Bool validators, as!, try!)
  ponytail-plan/                plan wrapper applying the ponytail ladder (YAGNI → reuse → stdlib → … → new code), mandatory ## Ladder table
  portfolio-audit/              Portfolio-wide /speckit-analyze override
  spec-minimal/                 Artifact minimalism: strips spec sections, keeps the feature tree to spec/plan/tasks
  tdd/                          (iOS) implement wrapper: Red-Green-Refactor per scenario; swift test / xcodebuild test on a Simulator, Swift/ObjC/Metal changes need tests
  worktree-isolation/           Forces /speckit-implement to run inside the feature worktree
```

Each item is a self-contained directory with its own `extension.yml` or `preset.yml` manifest, conforming to Spec Kit's schema:

- Extensions: <https://github.com/github/spec-kit/blob/main/extensions/EXTENSION-DEVELOPMENT-GUIDE.md>
- Presets: <https://github.com/github/spec-kit/blob/main/presets/README.md>

**Jev assist (optional).** `tdd`, `git`, `autopilot`, `review`, `stale-tasks-guard`,
`button-design` and `library-research` ask TypeSafe's Jev the bounded yes/no and
pick-one questions they used to pause on (Red reason, duplicate issue,
priority/kind/layer, fast path, finding triage, wording-only spec edit, whether a
layer applies). It is on whenever `TYPESAFE_API_KEY` is set or a key file exists at
`~/.config/typesafe/key` or `~/.typesafe_key`; `SPECKIT_JEV=off` turns it off.
Anything short of a confident answer falls back to the behaviour without Jev.
Verdicts that would drop work (a Red call, a duplicate merge, a false-positive
finding) stay in shadow mode until listed in `SPECKIT_JEV_AUTOMATE`. Details in
`CLAUDE.md` under *Jev*; `bun scripts/selftest-jev.ts` is the check.

## Prerequisites

- **Spec Kit CLI.** Install it once with `uv`, pinned to a release tag:

  ```bash
  uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@vX.Y.Z
  ```

  This puts `specify` on your PATH (`~/.local/bin`). Check the [latest release](https://github.com/github/spec-kit/releases/latest) for the newest tag; verify with `specify --version`.
- **bun**, wherever these items run (this checkout and the consumer project). Run `bun install` once in the checkout.
- **Xcode** with its command-line tools and an iOS Simulator runtime, for the items that build or test the app (`tdd`, `autopilot`, `review`).

## Install into a project

From inside this checkout, point the installer at a Spec Kit project (one with a `.specify/` directory):

```bash
./install.ts /path/to/your/ios-app
./install.ts --force /path/to/your/ios-app   # refresh after any change here
./uninstall.ts /path/to/your/ios-app
```

`install.ts` auto-discovers every manifest under `extensions/` and `presets/`, installs each with the
priority the ordering contract below requires, and runs any item's `post-install.ts`. `--dev` records this
checkout as the install source but does **not** symlink: `specify` copies each directory into the project,
so edits here are only picked up after `./install.ts --force <project>`.

Before installing, `install.ts` runs `check-cli-usage.ts`, which aborts on invented paths: every
`specify <verb>` a command file tells an agent to run must exist in the installed CLI, and every script path
a command file names must exist, be declared under its manifest's `provides.scripts:`, and never point into
core Spec Kit's flat `.specify/scripts/bash/`. It also rejects a bare `$CLAUDE_PROJECT_DIR` in a bash block
(empty in an interactive session, issue #59); each block resolves the root itself with
`PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"`. The pre-flight also runs
`bun run typecheck` when `node_modules` is present.

After installing, `scripts/gen-agent-index.ts` writes the command→script mapping into the consumer as
`.specify/extensions/AGENTS.md` (plus a breadcrumb at `.specify/scripts/bash/README.md`), since command
names do not predict script names. `uninstall.ts` removes both.

If you install by hand instead (`specify extension add --dev <dir>` / `specify preset add --dev <dir>`),
pass the same `--priority` values `install.ts` does, or preset composition silently degrades.

## Working with an agent on this repo

**Always hand back the PR link.** Any time an agent opens, updates, merges into, or
otherwise works on a pull request here, the reply must include the PR URL — not just
the number, and not just a description of what changed.

## Authoring

Edit the manifest (`extension.yml` / `preset.yml`) and the files under `commands/`, `templates/`, or `scripts/` in place, then re-run `./install.ts --force <project>` in any consuming project — installs are copies, so this applies to command text and scripts too, not just manifests. New scripts are TypeScript run by bun (`#!/usr/bin/env bun`), even when what they check is Swift.

### Preset composition: `wrap` vs `replace`

A preset's command template declares `strategy: "wrap"` (composes with other presets on the same command, via a `{CORE_TEMPLATE}` seam that expands to the next inner layer) or `strategy: "replace"` (fully owns the command body). **`replace` is the default when `strategy` is omitted** — that default is what silently disabled several `/speckit-implement` presets at once (issue #25), so declare it explicitly either way.

There is no `replaces:` key. It is not in the preset schema and `PresetManifest._validate()` never reads it, so it looks like it declares intent and does nothing. Use `strategy:`.

`specify` sorts installed presets by **(priority ASC, id ASC)** — lower number = higher precedence. Composition works like this:

- The **base** is the nearest `replace` layer scanning from highest precedence downward. Only layers *above* the base compose at all; anything below it is dead.
- If the highest-precedence layer is itself a `replace`, it short-circuits and wins outright — every other layer is dropped.
- Core templates are always appended as a final `replace` layer, so a stack of pure wrappers still composes over the stock command.
- Wrappers are applied bottom-up, so the **lowest priority number ends up outermost**: its pre-seam text runs first and its post-seam text runs last.

Presets also can't declare lifecycle hooks (`before_*`/`after_*`); only extensions can. So behaviour that must survive being clobbered by a `replace`-strategy sibling ships as an extension with lifecycle hooks — `stale-tasks-guard` is a standalone extension for exactly this reason.

### The `/speckit-implement` ordering contract

Four presets target `speckit.implement`, so their install priorities are **load-bearing**. `install.ts` passes `--priority` for each; the map is `PRIORITY` there and must stay in sync with this table:

| Priority | Preset | Strategy | Role |
|---|---|---|---|
| 5 | `worktree-isolation` | wrap | outermost — the `cd` must precede every write |
| 9 | `parse-dont-validate` | wrap | discipline + scan gate hug the implementation |
| 11 | `tdd` | wrap | Red-Green-Refactor cycle per scenario; green-suite + tests-accompany gate |
| 20 | `explicit-task-dependencies` | **replace** | the executor base, innermost |

Resulting execution order: worktree `cd` → parse-don't-validate discipline → TDD cycle → **implement** (wave DAG, or the stock loop when `explicit-task-dependencies` isn't installed) → TDD gate → scan gate.

`explicit-task-dependencies` stays `replace` because it genuinely substitutes wave-DAG subagent fan-out for the stock serial loop — wrapping it would execute every task twice. It sorts last so it becomes the base rather than swallowing the wrappers.

`ponytail-plan` installs at priority 8 so it wraps `/speckit-plan` outside `parse-dont-validate` (9) and every default-10 plan layer. Everything else installs at the default 10.

### The `/speckit-constitution` wrapper

`parse-dont-validate` wraps `/speckit-constitution` to inject its governance section into `.specify/memory/constitution.md`. Any preset that injects a constitution section must stay stackable with it (issue #37):

- **Idempotency matches on the section title, not its roman numeral** — so a section stays recognized after renumbering.
- **Every layer renumbers all numbered principle sections sequentially** in document order after inserting. The numeral in a preset's canonical text is a placeholder; the outermost layer runs last and leaves the document consistently numbered.
- **Every layer repeats the core flow's bookkeeping if it changed anything.** The core flow does its version bump, Sync Impact Report, validation, and user summary *before* any wrapper runs, so a section injected afterwards is invisible to all of it. Each layer re-derives the version (added principle = `MINOR`, body-only edit = `PATCH`), amends the Sync Impact Report, and corrects the reported version — **bumping at most once per run**.
