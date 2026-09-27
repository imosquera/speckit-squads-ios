---
description: "Composable wrapper for /speckit-implement that drives every task through Red-Green-Refactor and gates completion on a green suite with tests accompanying every production change."
strategy: "wrap"
---

## Wrapper Layer

This preset wraps `/speckit-implement` (and any inner wrapper the core-flow seam
expands to). It changes **how** each task's code gets written: test first, one
scenario at a time. It does not change which tasks run or in what order.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

### Before the first task — find the test command (MANDATORY)

Read `plan.md` and the project's layout (`Package.swift`, `*.xcodeproj`,
`*.xcworkspace`, `*.xctestplan`, `Makefile`, `project.yml`/`Project.swift`, …)
and settle on the **one command that runs the whole suite**:

- **Swift package** (a `Package.swift` with test targets under `Tests/`):
  `swift test`.
- **App project** (Xcode project or workspace): list the schemes with
  `xcodebuild -list`, pick an installed simulator with
  `xcrun simctl list devices available`, then:

  ```bash
  xcodebuild test -scheme <Scheme> \
    -destination 'platform=iOS Simulator,name=<device>'
  ```

  Add `-workspace <X>.xcworkspace` (or `-project <X>.xcodeproj`) when the
  directory holds more than one, and `-testPlan <plan>` when the scheme uses
  test plans. Pipe through `xcbeautify` if the project already uses it, but
  keep the raw log: the failure lines are what Red is judged on.

Run it once now and record the baseline: how many tests, and which ones (if
any) already fail. Save the full output to a file outside the repo; Jev
assist's `baseline` check reads it. A test failing at baseline is not yours to
fix and must not be mistaken for your Red later.

Tests are written with **Swift Testing** (`import Testing`, `@Test`,
`#expect`, `#require`) or **XCTest** (`XCTestCase`, `func test…()`,
`XCTAssert…`). Use whichever the target already uses; new targets default to
Swift Testing. UI flows go in the `<App>UITests` target with `XCUIApplication`.

To iterate on one test during Red and Green, narrow the run, then still run
the whole suite before calling the step done (steps 3 and 5 below):

- `swift test --filter <TestTarget>.<Suite>/<test>` (a regex over the test id).
- `xcodebuild test … -only-testing:<TestTarget>/<Class>/<testMethod>` for
  XCTest, or `-only-testing:<TestTarget>/<Suite>/<function>()` for Swift
  Testing (the parentheses are part of the identifier).

If the project has no test target, adding the smallest one is the first piece
of work: a `.testTarget` in `Package.swift`, or a Unit Testing Bundle target
in the Xcode project that hosts the app. A change that is genuinely
untestable (asset catalogs, storyboards, `Info.plist`, entitlements, other
pure configuration, a generated file) is exempt — say which files and why in
the completion report. Prefer moving logic out of views and view controllers
into types a unit test can reach over claiming an exemption for it.

### The cycle (MANDATORY for every task that changes behaviour)

**The TDD Cycle** — this block is copied verbatim into every subagent prompt
the core flow dispatches (see *Subagents* below):

> 1. **List the scenarios.** Before any code, write down the variants of the
>    behaviour this task asks for: the basic case, then each what-if — the
>    dependency times out, the key isn't there yet, the input is empty, the
>    caller lacks permission. Take them from the task line, `spec.md`'s user
>    stories and acceptance scenarios, and `plan.md`. This list is the
>    requirement; code comes after it.
> 2. **Red — write one test for one scenario.** Small, automated, and it would
>    pass only if that scenario's behaviour exists.
> 3. **Run the whole suite. The new test must fail, for the expected reason.**
>    Expected: an assertion that the behaviour is missing (a failing
>    `#expect` or `XCTAssert…`), or the symbol under test not existing yet
>    (`cannot find 'X' in scope` in the test target only). Not expected: a
>    compile error anywhere else, a missing `@testable import`, a scheme with
>    no test action, a simulator that failed to boot — fix those and run
>    again, they are not Red. A new test that **passes immediately** is flawed
>    or the behaviour already exists: find out which before going on. Never
>    count it as Red.
>    Classify the result with **Jev assist** `red-reason` first.
> 4. **Green — write the simplest code that passes the new test.** Hard-coding
>    and inelegance are allowed; step 6 cleans them up. Add no code beyond what
>    the tests exercise.
> 5. **Run the whole suite. Everything must pass** — the new test and every test
>    that passed at baseline. If something fails, fix it with the smallest
>    change. If you are debugging instead of fixing, revert to the last green
>    state and take a smaller step. For each failing test this cycle did not
>    write, ask **Jev assist** `baseline` whether it is yours before chasing it.
> 6. **Refactor — test code and production code, with the suite green.** Remove
>    hard-coded test data from production code, remove duplication, make names
>    self-documenting, move code to where it belongs, split long functions. Run
>    the suite after **each** refactor. Refactor only what this cycle wrote or
>    directly touched; that is not an opportunistic refactor.
> 7. **Repeat from step 2** with the next scenario until the list is done.
>
> Keep each test small and commit at each green-and-refactored point, so a
> broken step is reverted rather than debugged. Test **your** code, not the
> libraries it uses: a test that only proves the library works adds nothing,
> unless there is a stated reason to distrust that library.
>
> For every scenario, keep a one-line record: `scenario — test name — the Red
> failure line — green`, followed by the `record` line of every Jev call made
> for it. Report it back with your result.

### Jev assist (optional — the same block goes to every subagent)

> Jev (TypeSafe's System One model) answers the cycle's bounded judgment calls
> in one fast call. It **only** replaces those pauses: you still write every
> test and every line of code. Call it through the preset's helper:
>
> ```bash
> PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
> JEV="$PROJECT_DIR/.specify/presets/tdd/scripts/ts/jev.ts"
> bun "$JEV" red-reason --scenario "<scenario line>" --test <test file> --output <suite output file>
> bun "$JEV" baseline   --failure <this test's failure output file> --baseline <baseline run output file>
> bun "$JEV" covers     --scenario "<scenario line>" --test <test file>
> bun "$JEV" exempt     --path <file> --diff <file holding its diff>
> ```
>
> Save the suite output to a file first; `-` reads one argument from stdin.
> Every call prints one JSON line. Copy its `record` field into the
> per-scenario record, whatever the outcome.
>
> - **Exit 0: act on `decision`.**
>   - `red-reason`: `expected_red` → go to Green. `harness_error` → fix the
>     test or harness and rerun. `passes_immediately` → stop and investigate,
>     as step 3 says.
>   - `baseline`: `regression` → yours: smallest fix, or revert to the last
>     green state. `baseline_failure` → not yours; carry on.
>   - `covers`: `flag` → name the pair under **Flagged scenario records** in
>     the completion report. `covered` → nothing more.
>   - `exempt`: `refused` → run the cycle for that file. `exempt` → the
>     exemption stands.
> - **Exit 3: decide exactly as you would without Jev.** That covers
>   `SPECKIT_JEV=off`, no `TYPESAFE_API_KEY`, no SDK (the helper installs it
>   into `~/.cache/speckit-squads/jev` on first use), an API error, a
>   low-confidence answer, and `red-reason` in shadow mode. Read the output yourself (step 3), rerun
>   against the base branch (step 5), or keep the exemption you stated.
> - **Exit 2**: your call was malformed. Fix it; never read it as a decision.
>
> Never pass the API key on the command line or put it in a prompt, a file,
> or a record. The helper reads `TYPESAFE_API_KEY` from the environment only.
>
> `red-reason` runs in **shadow mode** until `SPECKIT_JEV_AUTOMATE=red-reason`
> (or the legacy `TDD_JEV_AUTOMATE_RED=1`) is set: it logs its answer but
> always exits 3, so you still make the Red call. Set the variable only after
> `bun "$JEV" measure --case red-reason --records <file.jsonl>` has been run
> over past Red records and its agreement rate and confident share justify
> it. Each record line holds every argument's *content* (not a path) keyed by
> flag name, plus the right verdict as `label`:
> `{scenario, test, output, label}`.

### Tasks that are already split into test and code

When `tasks.md` gives a story separate test tasks and implementation tasks
(the `explicit-task-dependencies` template does), the split **is** the cycle,
spread over two waves:

- A **test task** is Red. When it finishes, run the suite and confirm its tests
  fail for the expected reason **before** the wave holding the implementation
  tasks starts. A test that already passes stops the run: the task plan and
  the code disagree, and that is a finding to report, not to paper over.
- An **implementation task** is Green then Refactor, against those tests. Each
  scenario it covers that has no test yet still goes through the full cycle.

### Subagents

When the core flow dispatches tasks to subagents, every subagent prompt MUST
include **The TDD Cycle** and **Jev assist** blocks above verbatim, plus the
suite command, the baseline failures from the first step, and the saved
baseline run output file. A subagent that reports back without its
per-scenario record has not shown Red, and its task is not done.

### Core Flow

{CORE_TEMPLATE}

### Completion gate (MANDATORY — after the core flow)

1. Run the whole suite. Every test that passed at baseline, and every test this
   run added, must pass. A red suite is an incomplete run.
2. Check that the change set carries tests:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
bun "$PROJECT_DIR/.specify/presets/tdd/scripts/ts/check-tests-accompany.ts"
```

Run it from the feature worktree; it resolves its own root and base
(`--base <ref>` overrides). Handle the exit code:

- **`0`**: production changes are accompanied by test changes. Proceed.
- **`1`**: production source changed with no test file changed. Go back and run
  the cycle for the listed files. The one way past it is the exemption above,
  named file by file in the report. A missing test is not an exemption. Check
  every claimed exemption with **Jev assist** `exempt`; a `refused` file goes
  back through the cycle.
- **`2`**: the check could not run (no base, not a worktree). Fix the cause and
  re-run; never read this as a pass.
- **`4`**: nothing changed. Proceed only if this run truly wrote no code.

## Completion Report

On success, include:

- The suite command, and the baseline and final test counts.
- The per-scenario records (`scenario — test — Red failure — green`), grouped
  by task.
- Any test that passed on first run and what that turned out to mean.
- Exempt files, each with its reason and its Jev `exempt` record.
- **Flagged scenario records**: every pair Jev `covers` flagged, or `none`.
- Whether Jev was used, and if not, why (the `reason` of the first fallback).
- The `check-tests-accompany.ts` result.
