# tdd

Wraps `/speckit-implement` in the Red-Green-Refactor cycle, for iOS/Swift
projects: Swift packages and Xcode app projects (SwiftUI or UIKit).

For every task that changes behaviour, the implementer first lists the
scenarios (the basic case plus each what-if), then for each one:

1. **Red**: write one test, run the whole suite, and watch the new test fail
   for the expected reason. A test that passes straight away is flawed or the
   behaviour already exists. It never counts as Red.
2. **Green**: write the simplest code that passes it. Hard-coding is fine here.
3. **Refactor**: clean up test and production code, running the suite after
   each change.

The suite runs with `swift test` for a Swift package, or
`xcodebuild test -scheme <S> -destination 'platform=iOS Simulator,name=<device>'`
for an app project (pick the device from `xcrun simctl list devices available`).
During Red and Green a single test can be run with `swift test --filter` or
`xcodebuild test -only-testing:<Target>/<Suite>/<test>`, but every step still
ends on a whole-suite run. Tests use Swift Testing (`@Test`, `#expect`) or
XCTest, whichever the target already uses.

Commits are small and frequent, so a bad step is reverted rather than debugged.
Tests target the project's own code, not the libraries it calls.

## Composition

- **Priority 11**: inside `parse-dont-validate` (9), outside the
  `explicit-task-dependencies` executor (20). See the ordering contract in the top-level `README.md`.
- With `explicit-task-dependencies`, a story's test tasks are the Red wave and
  its implementation tasks are Green + Refactor. The wrapper confirms the tests
  fail before the implementation wave starts. Every subagent prompt carries the
  cycle verbatim.

## Gates

- A full suite run after the core flow. It must be green.
- `scripts/ts/check-tests-accompany.ts`: exit 1 when production source
  changed since the merge-base with no test file changed, 2 when it cannot run,
  4 on an empty change set. It only checks that tests came with the change.
  - **Tests**: anything under SPM's `Tests/`, an Xcode `<Target>Tests/` or
    `<Target>UITests/` directory, or a generic `tests/`/`test/` directory, and
    any `*Test.swift`, `*Tests.swift`, `*Spec.swift` (or `.m`/`.mm`) file.
  - **Production**: `.swift`, `.m`, `.mm`, `.h`, `.c`, `.cc`, `.cpp`, `.hpp`,
    `.metal`, except `Package.swift` (a manifest).
  - **Neither**: everything else, including `.xcassets`, `.storyboard`,
    `.xib`, `.plist`, `.xcstrings`, `.xcconfig`, `project.pbxproj` and
    `Package.resolved`. Changing only these never fails the gate.
  - **Ignored**: `.specify/`, `Pods/`, `Carthage/`, `.build/` and
    `DerivedData/`, which are vendored or generated.
  Whether each test went red before green is recorded per scenario in the
  completion report and cannot be checked mechanically.

## Jev assist (optional)

`scripts/ts/jev.ts` (the shared helper, a byte-identical copy of the repo's
`scripts/jev.ts`) answers the cycle's four bounded judgment calls with Jev, TypeSafe's System One model, through `@typesafe-ai/sdk` (issue #116):

| Command | Question | Decides when |
|---|---|---|
| `red-reason` | Did the new test fail for the expected reason? (Choice) | confidence ≥ 0.85, not `none_of_these`, and `SPECKIT_JEV_AUTOMATE=red-reason` (or `TDD_JEV_AUTOMATE_RED=1`) |
| `baseline` | Was this failing test passing at baseline? (Noul) | p ≥ 0.85 (regression) or ≤ 0.15 (not ours) |
| `covers` | Does this test exercise this scenario? (Noul) | always; < 0.85 flags the pair in the report |
| `exempt` | Is this file untestable? (Noul) | always; < 0.85 refuses the exemption |

Exit 0 means act on the decision; exit 3 means decide exactly as the preset
did before Jev. That covers `SPECKIT_JEV=off`, no `TYPESAFE_API_KEY`, no SDK, any API error, a
low-confidence answer, and `red-reason` in shadow mode. Every call's answer
and confidence go into the per-scenario record.

`red-reason` stays in shadow mode (logs, never decides) until
`SPECKIT_JEV_AUTOMATE=red-reason` (or the legacy `TDD_JEV_AUTOMATE_RED=1`).
Turn it on only after
`bun jev.ts measure --case red-reason --records past-reds.jsonl` reports a good
agreement rate and confident share over past Red records. Each line holds every
argument's content (not a path) keyed by flag name, plus the right verdict as
`label`: `{scenario, test, output, label}`.

The key is read from `TYPESAFE_API_KEY` by the SDK and nowhere else.
The helper prefers a project's own copy of the SDK; otherwise it installs it
with bun into `~/.cache/speckit-squads/jev` on first use, never into the
project or `.specify/`, which consumers commit. There is no post-install step.

## Runtime

Everything in this preset is TypeScript run by bun. Consumers need bun on
`PATH`.

`bun scripts/ts/selftest-tdd.ts` is the check for the gate. The Jev helper is
checked by the repo's `scripts/selftest-jev.ts`.
