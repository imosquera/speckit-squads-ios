---
description: "After the plan is written, research libraries for its technical unknowns"
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

Execute the canonical stock `/speckit-plan` flow, then add one mandatory
research pass: identify build-it-yourself surface area in the finished plan
and check, via live web search, whether an existing library already solves it
well enough that hand-rolling it would be wasted effort.

### Core Flow

Run the core plan flow first so that `plan.md` exists before research begins.

{CORE_TEMPLATE}

### Research Pass (MANDATORY — runs after the core flow)

0. **Applicability gate.** Ask Jev whether the plan hand-rolls anything a
   library could provide:

   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   bun "$PROJECT_DIR/.specify/presets/library-research/scripts/ts/jev.ts" applies-library --plan "$SPECIFY_FEATURE_DIRECTORY/plan.md"
   ```

   Exit 0 with `decision: "skip"` → take the no-surface-area path in step 1
   (the `N/A` `research.md`, `plan.md` untouched) without scanning. Exit 0
   with `"applies"`, exit 3, or any other exit → continue with step 1 as
   usual. Quote the printed `record` line in the Completion Report.

1. **Scan `plan.md` for technical unknowns.** Look for components the plan
   describes building from scratch that commonly have mature off-the-shelf
   solutions on iOS — networking/HTTP clients, request retries/backoff,
   Keychain credential storage, sign-in/OAuth flows, JSON/data parsing,
   image loading/caching, local persistence/offline sync, background work,
   analytics/crash reporting, logging, feature flags, in-app purchases,
   localization, and similar. Ignore plain internal business logic (domain
   rules specific to this feature) — that is never a research target.

   If the plan has no such surface area, write a `research.md` containing
   only `N/A — no build-it-yourself surface area identified in this plan.`,
   skip straight to Completion Report, and do not modify `plan.md`.

2. **Research each unknown using real web search** (`WebSearch` / `WebFetch`
   tools) — do not rely on memorized/training-data knowledge of the Swift
   ecosystem, since versions, maintenance status, and best-fit choice change
   over time. Walk this ladder for each unknown and stop at the first rung
   that genuinely covers it:

   1. **Apple first-party frameworks** — check Apple Developer documentation
      (developer.apple.com) first: Foundation, SwiftUI, Observation,
      SwiftData, Core Data, CryptoKit, AuthenticationServices,
      BackgroundTasks, URLSession, Security (Keychain Services), OSLog,
      StoreKit, Network, and similar. A native framework available at the
      project's deployment target beats any third-party dependency.
   2. **Apple/Swift open-source packages** — e.g. `apple/swift-*` and
      `swiftlang/*` packages (swift-collections, swift-async-algorithms,
      swift-log, etc.).
   3. **Third-party Swift packages** — search Swift Package Index
      (swiftpackageindex.com) for 1-3 candidates.

   For each third-party or open-source candidate, check:
   - **platform support** — supports iOS at or below the project's minimum
     deployment target (Swift Package Index compatibility matrix,
     `platforms:` in the package's `Package.swift`)
   - **Swift 6 readiness** — builds under Swift 6 language mode / strict
     concurrency checking, with `Sendable`-correct public API (Swift Package
     Index reports data-race-safety results)
   - **maintained** — recent releases/commits, not archived, issues and PRs
     get responses
   - **license** compatible with the project (avoid GPL/AGPL for
     permissively licensed or App Store–distributed apps unless the plan
     already accepts that)
   - **SPM-installable** — ships a `Package.swift`; avoid CocoaPods- or
     Carthage-only libraries
   - **binary size impact** — note heavy dependency trees or large
     binaries; app size matters on iOS
   - **fits the project** — check `plan.md`, the project's `Package.swift`,
     and the Xcode project's package dependencies (`Package.resolved`)
     before recommending, so you don't add a second library for something
     already covered
   - **genuinely reduces scope** versus hand-rolling or using the native
     framework — a library that only covers a sliver of the unknown, or adds
     more integration complexity than it removes, is not a win

3. **Write `research.md`** in the feature directory with one section per
   unknown researched:

   ```markdown
   ## <Unknown, e.g. "Image caching">

   **Candidates considered:** <framework or package> (<one-line why>), <package> (<one-line why>)
   **Recommendation:** use `<framework or package>` | build custom
   **Why:** <2-3 sentences — native vs. third-party, iOS target / Swift 6 support, maintenance, size, scope saved or why nothing fit>
   ```

   `research.md` is a valid artifact under this repo's presets — it is
   explicitly allowed by `spec-minimal` (v1.1.0+) when that preset is also
   installed.

4. **Revise `plan.md` in place** for every unknown where the recommendation
   is "use `<library>`": replace the custom-build description with a note
   that the feature will use the framework or package instead, naming it
   (and, for a package, the SPM dependency to add) and linking to
   `research.md` for the rationale (e.g. `See research.md — using <library>
   instead of a custom implementation.`). Do not touch sections for unknowns
   where the recommendation was "build custom" or where no unknown was found.

### Failure Policy

- Do not fabricate library names, versions, or maintenance status. Every claim
  in `research.md` must come from an actual search/fetch result performed
  during this run, not from memory.
- If web search tools are unavailable in this session, write that fact as the
  `research.md` content instead of guessing, and leave `plan.md` untouched.

## Completion Report

On success, include:
- Whether research ran, and if so, how many unknowns were identified and
  researched.
- The Jev `record` line from the applicability gate.
- Any unknown where the recommendation was "use `<library>`", naming the
  library and the plan section it now replaces.
- The normal stock `/speckit-plan` completion summary.
