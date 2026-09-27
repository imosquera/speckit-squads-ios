---
description: "Run /speckit-implement under Parse, Don't Validate discipline"
strategy: "wrap"
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Wrapper Layer

This preset wraps `/speckit-implement` (and any inner wrapper the core-flow seam
expands to). It honors one design discipline while code is written, then runs
**one mandatory scan gate** after the core flow, before reporting completion. It
does not change how tasks are executed.

### Design discipline (applies while code is written)


Parse, don't validate. A validator says "this is fine, continue" and throws the
proof away the instant it returns; a parser takes raw input and returns either a
**more precise type** or a typed error. Encode what you checked in the type so
future code never re-checks.

Whenever this run touches Swift that ingests untrusted data (`URLSession`
responses, files, `UserDefaults`, keychain, deep links / URL query items, push
payloads, pasteboard, user input), prefer parsing over validating:

1. **Untrusted data stays at the boundary.** Raw input is `Data` / `String` /
   `URLComponents` and goes straight into a parser. `Any`, `AnyObject` and
   `[String: Any]` never leave the parser; `JSONSerialization` and
   `PropertyListSerialization` are used only inside one, and only when
   `Decodable` cannot express the payload.
2. **Parse into domain newtypes.** Turn `String` into `Email`, `UUID` into
   `UserID`: a wrapper struct (`struct Email { let raw: String; init(parsing:)
   throws }`), a `RawRepresentable` struct, or a phantom-tagged type
   (`Tagged<User, UUID>`). Illegal states become unrepresentable; downstream
   code trusts the type instead of re-checking.
3. **Parsers are throwing/failable `init`s or `Decodable`.** `init(parsing:)
   throws`, `init?(_:)`, or a `Decodable` conformance (a custom `init(from:)`
   when the wire shape is not the domain shape) returns the domain type or a
   single typed error. Do not add `func isValid…(…) -> Bool` / `validate…() ->
   Bool` helpers that callers must remember to run. Prefer decoding straight
   into domain types (`JSONDecoder().decode(Profile.self, from: data)`) over
   decoding into loose containers and checking them afterwards.
4. **Casts and traps are confined.** `as!` is allowed only inside the parser
   scope that owns the conversion; use `as?` and throw on failure. Never use
   `try!` on anything that can fail at runtime — propagate the typed error.
5. **Swift's own tools are welcome.** `Codable`, `RawRepresentable` enums,
   `CodingKeys`, property wrappers and swift-tagged satisfy this discipline and
   are preferred over hand-rolled casts. The tool is a means; the boundary
   discipline is still yours.

Respect any project constitution and existing conventions. If the feature has no
Swift surface, this discipline is a no-op and you proceed with the stock flow.

### Core Flow

Apply the discipline above to any Swift written by the flow below.

{CORE_TEMPLATE}

### Mandatory anti-pattern scan (runs AFTER all task execution)

After the entire core flow above finishes, gate completion on a deterministic
scan of the Swift (`.swift`) changed during this run.

1. **Review the discipline items** the scan enforces:

   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   bun "$PROJECT_DIR/.specify/presets/parse-dont-validate/scripts/ts/parse_dont_validate.ts" checklist
   ```

   | Rule | Flags | Where |
   |---|---|---|
   | `PDV001` | `Any` / `AnyObject` as a type (incl. `[String: Any]`); `AnyObject` as a class constraint is fine | outside parser scopes |
   | `PDV002` | `JSONSerialization`, `PropertyListSerialization`, `unarchiveObject`, `decode([String: …].self, …)` | outside parser scopes |
   | `PDV003` | `func isValid…` / `validate…` / `checkValid…` returning `Bool` | everywhere |
   | `PDV004` | `as!` force casts | outside parser scopes |
   | `PDV005` | `try!` | everywhere |

   A **parser scope** is a parser-named file (`*Parser*`, `*Parsing*`,
   `*Decod*`, `*Codec*`, `*Schema*`, `*DTO*`), the body of a type named
   `*Parser*` or declared/extended as `Decodable`/`Codable`, or the parameter
   list and body of `init(from:)`, `init(parsing:)` and `func parse…`. Force
   unwraps are not scanned (the scanner cannot tell a decoded value's `!` from
   any other) — keep them out of parsers by hand.

2. **Scan the changed files.** This is the whole invocation — one command, from
   anywhere in the checkout:

   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   bun "$PROJECT_DIR/.specify/presets/parse-dont-validate/scripts/ts/parse_dont_validate.ts" scan --new-only
   ```

   With no paths the script inspects the git change set — working-tree changes
   **plus** work already committed on the current branch, so the gate still
   fires even if a post-implement hook has committed the implementation. It
   anchors at the git worktree root itself, so it cannot silently scan one file
   because you started in a subdirectory, and it skips vendored trees
   (`.specify/`, `Pods/`, `Carthage/`, `.build/`, `DerivedData/`,
   `SourcePackages/`). `--new-only` re-scans the base ref's copy of the same
   files and subtracts every finding that reproduces there, so what you get back
   is what *this run* introduced — do not hand-verify findings against `main`
   yourself. Pass explicit paths/dirs to narrow, or `--base <ref>` to pin the
   branch base (needed only when the base cannot be auto-detected;
   `--new-only` exits `3` and says so).

   Drop `--new-only` to see the pre-existing findings too — informative, but
   never a reason to hold up this feature.

   **A scan that examined nothing never exits zero.** Exit `2` is a bad
   invocation (an unknown option, `--base` with no ref); exit `3` is a scan that
   could not run (a Swift file it cannot lex — an unterminated string or
   comment, unbalanced brackets — paths that resolved to no Swift file, a cwd
   outside any git worktree); exit `4` is an empty *input* — the change set
   holds no Swift. Read the message and fix the call.

   The scanner is a TypeScript script run by `bun`; it needs no Swift
   toolchain and no Xcode. If the shell reports `bun: command not found` (exit
   `127`) the gate never ran — install bun (https://bun.sh) and re-run, never
   report it as a pass. It is a lexer, not a Swift parser: it blanks comments
   and string literals (keeping `\(...)` interpolations) before matching, so a
   pattern inside a comment or string is never a finding. If it exits `3` on a
   file that compiles (a bare `/regex/` literal, or `#if` branches that each
   open a brace), report that instead of editing the code to please it.

3. **Resolve every finding.** For each reported `PDVxxx`, either:
   - **Fix it** — replace the validator / `Any` / `as!` / `try!` with a parser
     that returns a precise type or throws (this is the default and preferred
     outcome), or
   - **Waive it at the boundary** — if the finding is legitimate raw handling
     *inside a parser* the scanner did not recognise as one, add a
     `// parse-dont-validate: allow PDVxxx (<reason>)` comment on that line or
     the line above. Waive only at the trusted parser boundary; a waiver
     anywhere else is the bug this preset exists to catch.

   Re-run `scan --new-only` until it **exits zero, or exits `4` on a run you have
   confirmed wrote no Swift** (the "verified empty input" case below). Those two
   are the only outcomes you may report completion on.

**The verified empty-input case.** If the run produced no Swift, `scan` exits
`4` saying nothing was scanned. That is the one non-zero exit you may proceed
past, and only after checking the change set yourself and confirming it really
holds no `.swift` file. Wherever the rest of this section says "exits zero",
read it as "exits zero, or exits `4` verified this way". If the run *did* write
Swift, exit `4` means the invocation is wrong, not that the gate passed — fix
the call and re-run.

## Failure Policy

- A non-zero exit from `parse_dont_validate.ts scan --new-only` is a hard stop on
  reporting completion, with the single verified exit-`4` exception above. Exit
  `1` means findings: fix the flagged code or add a boundary waiver, then
  re-scan. Exits `2`/`3` mean the gate never ran — fix the invocation or the
  environment and run it; they are not a pass. Exit `4` means nothing was
  scanned, which is a pass only for a run you have confirmed wrote no Swift;
  report it as such rather than reporting a zero exit.
- Do not silence a finding by deleting the offending line's functionality, by
  hiding the pattern from the scanner (renaming a file to `*Parser*`, moving
  code into an unrelated `Decodable` type), or by waiving outside a parser.
  The point is a real parser at the boundary, not a green scan.
- If the feature has no Swift, do not fabricate parsing work — the gate is a
  no-op.

## Completion Report

On success, include:
- The normal `/speckit-implement` completion summary from the core flow.
- Whether the parse-don't-validate scan ran and that it exited zero — or, for a
  run with no Swift, that it exited `4` and that you confirmed the change set
  holds no such file. State which of the two it was; never claim a zero exit
  for the exit-`4` case.
- Any findings that were fixed (what became a parser) and any that were waived
  at a parser boundary (with the reason).
