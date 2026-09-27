---
description: Comprehensive Swift/iOS code review using specialized agents — code (incl. crash sites, retain cycles, main-thread UI, security, SwiftUI performance & accessibility), arch (SwiftUI/MVVM/TCA, DI, module boundaries), comments, tests, errors, types, and simplify (incl. ponytail review + audit) — then applies the behaviour-preserving ponytail cuts. One engine for every scope: the current feature branch, the working directory, or a GitHub pull request (`--pr N`). Use this whenever the user asks to review their changes, do a code review, review a PR, check a pull request, "look at this PR", "give me feedback on this PR", or "what do you think of this PR".
scripts:
  sh: bun scripts/ts/detect-changed-files.ts
---

# Comprehensive Code Review

Run a comprehensive review of a Swift/iOS app change using multiple specialized agents, each focusing on a different aspect of code quality. The engine is the same for every review; **scope is the only thing that varies** — a feature branch, the working directory, or a pull request.

**Arguments:** "$ARGUMENTS"

## Review Workflow:

1. **Load Configuration**
   - Read the project config file at `.specify/extensions/review/review-config.yml` (if it exists).
   - If the file does not exist, fall back to the `defaults.agents` section in the extension's `extension.yml`.
   - Extract the `agents` map — each key (`code`, `arch`, `comments`, `tests`, `errors`, `types`, `simplify`) is a boolean toggle. A key missing from an older project config counts as `true`.
   - Agents set to `false` **MUST** be excluded from this run. Do not launch them.

2. **Parse Arguments**
   - **Aspects:** any of the aspect names below. If specific aspects were requested, run exactly those — config toggles do **not** apply (explicit user request overrides config). Default (no aspects): run all applicable reviews that are enabled in config.
   - **`parallel`:** launch the reviewers simultaneously (step 6).
   - **`--pr <N>`:** review pull request N (Mode C). If the user asks to review "the PR" / "this PR" without a number, resolve it for the current branch with `gh pr view --json number --jq .number`; if that finds none, ask the user (`AskUserQuestion` in Claude Code) rather than guessing.
   - **`--comment`:** Mode C only — post the final report to the PR (step 10). Passed without `--pr`, say so in the report and post nothing.
   - **`--no-fix`:** report only — skip step 8 (Apply ponytail cuts). Treat explicit report-only intent in the user's words ("just review", "don't change anything", "read-only") the same way.

3. **Available Review Aspects:**

   - **code** - General code review: project guidelines, crash sites (`!`, `try!`, `as!`), retain cycles, main-thread UI, security (Keychain, ATS), SwiftUI performance, accessibility (labels, Dynamic Type)
   - **arch** - Architecture & API design: SwiftUI/MVVM/TCA boundaries, `@Observable` state ownership, dependency injection, module/package boundaries, public API and persisted-format contracts
   - **comments** - DocC `///` accuracy and completeness, comment rot
   - **tests** - XCTest / Swift Testing coverage and quality, async tests, UI tests, snapshot tests
   - **errors** - `throws`/`Result`/typed throws, swallowed `try?`, silent failures, user-facing error states
   - **types** - Value vs reference types, enums with associated values, `Sendable`, actor isolation, strict concurrency
   - **simplify** - Simplify code for clarity; ponytail review of the change and audit of the touched files
   - **all** - Run all applicable reviews (default)

4. **Identify Changed Files**

   - **Run the `{SCRIPT}` with `--json` in every case** — plus `--pr <N>` when step 2 resolved a PR. It is the only authoritative source of the scope metadata (`repo_root`, `branch`, `diff_base`, and in Mode C `head` and `checkout`) that step 6a requires, and a user-supplied file list carries none of it. Even when the script exits 2 (no changes detected) its JSON still carries those fields. An exit 1 is a failed review, not an empty one: report the script's `error` verbatim and stop.
   - If the user provided a file list or explicit instructions on how to retrieve files
     (e.g., only staged, only unstaged, a specific folder), those instructions decide
     **which files to review** — they override `changed_files` and nothing else. Keep
     every other field from the script.
   - Otherwise take the file list from the script too. **Do not** attempt to detect
     changes by running `git` commands directly, reading git state manually, or using
     any other method — always delegate to the script.
     - The script picks the detection mode:
       - **Mode A (feature branch):** diffs the current branch against the default branch (`main`/`master`) from the merge-base, plus any staged, unstaged and untracked changes.
       - **Mode B (working directory):** falls back to staged + unstaged + untracked changes when there is no feature branch (e.g., working directly on the default branch).
       - **Mode C (pull request, `--pr <N>`):** the PR's files from `gh pr diff`, based at the merge-base of `origin/<base>` and the PR head sha. `checkout` is `worktree` when a local worktree has the PR's head branch checked out (`repo_root` is that worktree), and `none` otherwise (`repo_root` is this checkout and the PR is read through git objects at `head`).
     - JSON output: `{"branch", "default_branch", "repo_root", "diff_base", "mode", "pr", "pr_url", "pr_title", "head", "checkout", "changed_files": [...], "ignored_files": [...]}` — the Mode C fields are empty in Modes A/B.
     - **`ignored_files` is Xcode churn**, already removed from `changed_files`: `*.pbxproj`, anything under `*.xcassets/`, `xcuserdata/`, `*.xcworkspace/`, `__Snapshots__/` reference images, `.DS_Store`. Do not dispatch these to reviewers as code. Two exceptions, handled by you: (1) a changed `project.pbxproj` can carry build-setting changes — grep its diff for setting lines (`SWIFT_VERSION`, `SWIFT_STRICT_CONCURRENCY`, `IPHONEOS_DEPLOYMENT_TARGET`, `CODE_SIGN_ENTITLEMENTS`, `INFOPLIST_KEY_*`, `OTHER_SWIFT_FLAGS`, `ENABLE_*`) and hand any hits to `code` and `arch` as context; (2) changed `__Snapshots__/` images tell `tests` that reference images were re-recorded — list them in its prompt. `Package.swift`, `Package.resolved`, `Info.plist`, `*.entitlements`, `PrivacyInfo.xcprivacy`, `*.xcconfig`, `*.xcstrings`, storyboards/xibs and `*.xctestplan` stay in `changed_files` and are reviewed. List the ignored paths (count, or the paths if few) under the report's Overview.
     - Exit 2 with a non-empty `ignored_files` means the change is **only** Xcode churn: report that, with the list, rather than "no changes".
     - `repo_root` is an absolute path. `diff_base` is the merge-base in Modes A and C
       and empty in Mode B — a **base, not a range**, so in Mode A
       `git diff <diff_base>` reaches the working tree and covers committed, staged
       and unstaged work alike. Carry every field into every reviewer prompt verbatim
       (step 6a); do not re-derive any of them.
     - **`changed_files` is the authoritative scope, not the diff.** No `git diff` can
       show an untracked file, and the detector lists them in Modes A and B. A reviewer
       given only a diff command silently skips every newly created file.
   - **Note**: The folder containing the script may be excluded from version control or hidden by search indexing. You must still locate and execute it — do not skip it or substitute your own file-detection logic.
   - **Ignore** the `graphify-out/` directory in all review passes — exclude it from diffs, file reads, and issue reporting. If the changed-files list includes paths under `graphify-out/`, filter them out before dispatching to specialist agents. Generated knowledge-graph artifacts are out of scope for review.
   - In Mode C, also read the PR description (`gh pr view <pr> --json body --jq .body`) and hand it to reviewers as context for what the change claims to do.

5. **Determine Applicable Reviews**

   Based on changes **and** config toggles (skip any agent where `agents.<name>` is `false`):
   - **Always applicable** (if enabled): `/speckit.review.code` (crash sites, memory, threading, security, SwiftUI performance, accessibility)
   - **If public/`package` API, protocols, view models/reducers, navigation, dependency wiring, `Package.swift` targets, `Codable`/SwiftData/Core Data models, `UserDefaults`/Keychain keys, URL schemes, entitlements or build settings changed** (if enabled): `/speckit.review.arch`
   - **If test files changed** — `*Tests.swift`, anything under a `*Tests/` or `*UITests/` target, `__Snapshots__/` in `ignored_files`, `*.xctestplan` — **or production Swift changed with no accompanying test** (if enabled): `/speckit.review.tests`
   - **If `///` DocC comments, `*.docc` catalogs or other comments/docs added or changed** (if enabled): `/speckit.review.comments`
   - **If error handling changed** (`throws`, `do`/`catch`, `try?`, `Result`, error enums, error UI states) (if enabled): `/speckit.review.errors`
   - **If types added/modified** (structs, classes, enums, protocols, actors, `Sendable`/isolation annotations) (if enabled): `/speckit.review.types`
   - **Always applicable** (if enabled): `/speckit.review.simplify` (polish, plus the ponytail review and audit whose cuts step 8 applies)
   - If an agent is disabled by config, note it in the final summary (e.g., "simplify: skipped (disabled in config)"). Degraded aspects (step 6c) are noted the same way.

6. **Launch Review Agents**

   **Sequential approach** (one at a time):
   - Easier to understand and act on
   - Each report is complete before next
   - Good for interactive review

   **Parallel approach** (user can request):
   - Launch all agents simultaneously
   - Faster for comprehensive review
   - Results come back together

   **6a. Scope contract — every reviewer prompt MUST carry the scope explicitly.**

   A subagent inherits the session's cwd, which is regularly the main checkout on
   the default branch rather than the feature worktree. A reviewer that inherits
   the wrong tree produces confident findings about unrelated files, and nothing in
   its output says so. So each prompt **MUST** open with, verbatim from the
   script's JSON (never re-derived):

   **Mode A (feature branch):**

   ```
   Review scope — do not infer it, do not use your inherited cwd:
     worktree: <repo_root>          # absolute path
     branch:   <branch>
     diff:     git -C <repo_root> diff <diff_base>
     files:    <one path per line, exactly the filtered changed_files list>
   The file list is authoritative — review every path on it. The diff is context for
   the tracked ones; an untracked file appears in no diff at all, so read those from
   disk under <repo_root>.
   Before reviewing, verify: `git -C <repo_root> rev-parse --abbrev-ref HEAD` equals
   <branch>, and every listed file exists under <repo_root>. If either check fails,
   abort immediately and reply with exactly `SCOPE ERROR: <what mismatched>` — do not
   review whatever is in your working directory instead.
   ```

   **Mode B (working directory)** — `diff_base` is empty: pass
   `git -C <repo_root> diff HEAD` as the diff command and drop the branch check. The
   `files:` list is unchanged and still authoritative: a Mode B change set of nothing
   but untracked files yields an empty diff and is still a valid review.

   **Mode C, `checkout: worktree`** — the Mode A block with `pr: #<pr> <pr_url>`
   added, and the branch check replaced by a **sha** check:
   `git -C <repo_root> rev-parse HEAD` equals `<head>`. The branch name is not
   enough: a local branch can sit behind the PR, and a review of the stale copy
   reads exactly like a review of the PR. Run that check yourself **before**
   dispatch; if it fails, stop and tell the user the worktree at `<repo_root>` is
   not at the PR head (pull it, or remove the worktree so the review runs
   read-only) — a reviewer would only return `SCOPE ERROR` for it.

   **Mode C, `checkout: none`** — nothing on disk is the PR, so nothing is read from disk:

   ```
   Review scope — do not infer it, do not use your inherited cwd:
     repo:  <repo_root>             # absolute path; used only as a git object store
     pr:    #<pr> <pr_url>
     head:  <head>
     diff:  git -C <repo_root> diff <diff_base> <head>
     files: <one path per line, exactly the filtered changed_files list>
   This is a READ-ONLY review of commit <head>. The working tree under <repo_root> is
   NOT the PR — never read changed files from disk. Read every file with
   `git -C <repo_root> show <head>:<path>`, and search the PR's tree with
   `git -C <repo_root> grep <pattern> <head>`. You cannot run tests, builds, or linters
   against this code; say so rather than guessing their outcome.
   Before reviewing, verify: `git -C <repo_root> cat-file -e <head>:<path>` succeeds for
   every listed file. If it fails, abort immediately and reply with exactly
   `SCOPE ERROR: <what mismatched>`.
   ```

   If the user supplied an explicit file list or scope (step 4), it replaces the
   `files:` list. Every other line still comes from the script and is still
   mandatory — an explicit file list says *what* to review, never *which checkout*.

   A reviewer that returns `SCOPE ERROR:` is a failed launch, not a finding:
   re-dispatch it with the corrected scope, and never fold its output into the
   summary.

   **6b. Wait contract — do not poll, do not narrate.**

   After dispatching, you **MUST NOT** emit a turn that only reports on the
   reviewers' status. "Waiting on the four reviewers", "three passes still
   running", "I'll stop polling and wait" are all the same anti-pattern: they
   consume a turn and change nothing. Completion notifications arrive on their
   own; you do not need to check for them.

   Either do useful work that cannot conflict with a reviewer (verify a claim you
   already flagged, check CI, draft the PR body) or stop and produce no output at
   all until a notification arrives. Do not edit files the reviewers are reading —
   which is why step 8 waits for every reviewer to finish.

   **6c. Hang recovery.**

   If a reviewer has produced no output and its elapsed time has not advanced for
   **10 minutes**, `TaskStop` it and run that aspect inline yourself against the
   same scope from 6a. Record every aspect handled this way in the final summary
   as `<aspect>: degraded (agent hung, run inline)` — a degraded aspect is not the
   same as a clean pass and must not be reported as one.

7. **Aggregate Results**

   After agents complete, summarize using the four-bucket severity scheme. Always render the section headers with these emoji icons — do not substitute or drop them:
   - 🚨 **Critical** — must fix before merge (bugs, security vulnerabilities, broken contracts)
   - ⚠️ **Important** — strongly recommended (significant quality or correctness concerns)
   - 💡 **Suggestions** — worth addressing (code quality, missing tests, refactors)
   - ✨ **Optional Polish** — nice-to-have style/naming/cosmetic improvements
   - ✅ **Strengths** — what's well-done (be genuine, not perfunctory)
   - 🛠 **Recommended Action** — numbered next-steps list

   **7a. Triage with Jev assist (optional; coordinator only).**

   Jev (TypeSafe's System One model) answers two bounded calls while you merge
   and bucket the reviewers' findings: are two findings the same problem, and is
   a finding a defect, a style point, or wrong. **You** make these calls; reviewers
   never call Jev, and this block never goes into a reviewer prompt. Skip it
   entirely when the reviewers returned no findings. Ponytail cuts are not
   triaged here — step 8 has its own rules for them.

   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   JEV="$PROJECT_DIR/.specify/extensions/review/scripts/ts/jev.ts"
   bun "$JEV" same-finding --a <finding A file> --b <finding B file>
   bun "$JEV" finding --finding <finding file> --code <code excerpt file>
   ```

   Write each finding's text (agent, severity, `file:line`, description) and the
   code it cites (about 20 lines around the line, read from `<repo_root>` — or with
   `git -C <repo_root> show <head>:<path>` in Mode C `checkout: none`) to files in a
   scratch directory, never the repo. Every call prints one JSON line; keep its
   `record` field, whatever the outcome.

   1. **Dedupe first.** You pick the candidate pairs — the same file and nearby
      lines, or near-identical titles from different agents; Jev only confirms.
      `same` → merge into one finding, keep the higher severity, credit both
      agents. `distinct` → keep both. At most **10** pairs; beyond that, dedupe as
      you would without Jev.
   2. **Then triage each finding left**, highest severity first, at most **25**:
      - `defect` → keeps its bucket.
      - `style` → capped at 💡 Suggestions: a 🚨 Critical or ⚠️ Important finding
        moves there; a Suggestion or Optional Polish stays put.
      - `false_positive` → dropped from the buckets and listed under
        `Dropped as false positive` (step 9) with its `record`. This verdict is
        **gated**: it decides (exit 0) only when `SPECKIT_JEV_AUTOMATE` includes
        `finding` (or `all`). In shadow it exits 3 and the finding stays where it
        was, annotated `(jev: likely false positive)`.
   - **Exit 3: triage exactly as you would without Jev** — that covers
     `SPECKIT_JEV=off`, no `TYPESAFE_API_KEY`, no SDK, an API error, a
     low-confidence answer, and shadow mode.
   - **Exit 2**: your call was malformed. Fix it; never read it as a decision.

   Never pass the API key on the command line or put it in a prompt, a file or a
   record; the helper reads `TYPESAFE_API_KEY` from the environment only.

8. **Apply Ponytail Cuts**

   The simplify reviewer's `ponytail-review` (the change) and `ponytail-audit` (the
   touched files, whole) findings are applied here, by you, after every reviewer
   has returned.

   **Skip this step entirely** — and say which reason applied in the report — when:
   - `--no-fix` was passed, or the user asked for a report-only review;
   - Mode C with `checkout: none` — there is no checkout of the PR to edit; report the cuts only;
   - the simplify aspect did not run, or reported no cuts.

   Otherwise, working **only** inside `<repo_root>` and **only** on files in the
   filtered `changed_files` list:

   1. **Baseline the gates.** Discover the project's gates — the build, test and
      lint commands its `CLAUDE.md`/constitution, `Makefile`, `fastlane/Fastfile`,
      scripts or CI workflow name (typically `xcodebuild build`/`test` with a
      `-scheme` and a simulator `-destination`, `swift build`/`swift test` for a
      package, `swiftlint`, `swiftformat --lint`) — and run them once. Note which
      pass. If none are discoverable, say so in the report; if there is no macOS
      toolchain or simulator to run them, say that too — an unbuildable baseline
      cannot judge a cut.
   2. **Snapshot before editing.** Copy every file you are about to cut to a scratch
      directory first. Never revert with `git checkout`/`git restore`: in Modes A/B the
      working tree holds uncommitted work, and restoring from git would erase it.
   3. **Apply** every finding marked `behaviour-preserving: yes` whose target is in
      scope. **Never** cut, whatever a finding says: trust-boundary parsing or
      validation, error handling that prevents data loss, security checks,
      accessibility, or a project's only smoke test/self-check. Every finding you
      decline gets one line: `keep — because <reason>`.
   4. **Re-run the gates.** If a gate that passed at baseline now fails, restore the
      snapshot of the cut files one at a time until it passes again, and move each
      restored cut to the declined list (`keep — because it broke <gate>`). A gate that
      already failed at baseline cannot judge a cut; say so.
   5. **Measure.** `net: -N lines` is the line count of the snapshots minus the line
      count of the same files now (`wc -l`), summed across cut files.

   Cuts are left **uncommitted** in `<repo_root>`; committing is the caller's step.

9. **Provide Action Plan**

   Title the report `# PR #<pr>: <pr_title>` in Mode C, `# Review Summary` otherwise. Organize findings:
   ```markdown
   # Review Summary

   ## Overview
   [2–3 sentences: what this change does and why it matters]
   [Mode C, checkout: none — add: "Read-only review of <head>: no tests, builds or linters were run against this code."]

   ## 🚨 Critical Issues (must fix before merge)
   - [agent-name]: Issue description [file:line]

   ## ⚠️ Important Issues
   - [agent-name]: Issue description [file:line]

   ## 💡 Suggestions
   - [agent-name]: Suggestion [file:line]

   ## ✨ Optional Polish
   - [agent-name]: Polish item [file:line]

   Dropped as false positive:
   - [agent-name]: Issue description [file:line] — <jev record>

   ## ✂️ Ponytail Cuts
   Applied:
   - [ponytail-review|ponytail-audit] <tag> file:line — what was cut
   Kept:
   - file:line — keep — because <reason>
   Gates: [which ran, baseline vs. after]
   **net: -N lines**
   [Or: "Not applied — <--no-fix | read-only PR review | no cuts reported>", with the proposed cuts listed.]

   ## ✅ Strengths
   - [What's well-done — be genuine, not perfunctory]

   ## 🛠 Recommended Action
   1. [Numbered next-steps list]

   ## Recommendation
   **[Approve | Approve with conditions | Request changes]**
   [One paragraph explaining the reasoning]
   ```

   Omit any severity bucket that has nothing to report, and the `Dropped as false positive` line when nothing was dropped. List skipped, disabled and degraded aspects under the Overview. When step 7a ran, end the report with a `Jev:` list of every call's `record` line.

10. **Post to the PR** (`--comment`, Mode C only)

    Write the final report to a scratch file and post it — once, after step 9, never a
    partial report:

    ```bash
    gh pr comment "<pr>" --body-file "<report-file>"
    ```

    Report the comment URL `gh` prints. If posting fails, say so and still show the
    report; a failed post is not a failed review.

## Usage Examples:

**Full review of the current branch or working directory (default):**
```
/speckit-review-run
```

**Specific aspects:**
```
/speckit-review-run tests errors
# Reviews only test coverage and error handling

/speckit-review-run arch
# Reviews only public interfaces and contract changes

/speckit-review-run simplify
# Ponytail review + audit, then applies the behaviour-preserving cuts
```

**Report only — change nothing:**
```
/speckit-review-run --no-fix
```

**Review a pull request:**
```
/speckit-review-run --pr 123
# Every applicable agent against PR #123; read-only unless its branch is checked out in a local worktree

/speckit-review-run --pr 123 --comment
# ...and post the final report to the PR
```

**Parallel review:**
```
/speckit-review-run all parallel
# Launches all agents in parallel
```

## Agent Descriptions:

**code**:
- Checks project-specific guidelines (`.specify/memory/constitution.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, SwiftLint config, or equivalent) compliance
- Crash sites: force unwraps, `try!`, `as!`, unsafe subscripts
- Retain cycles (`[weak self]` where a cycle actually forms), main-thread UI, concurrency misuse
- Security: Keychain vs `UserDefaults` for secrets, ATS exceptions, deep-link validation, sensitive data in logs
- Performance: SwiftUI `body` recomputation, main-thread I/O, resource cleanup
- Accessibility: labels, traits, Dynamic Type

**arch**:
- Reviews public/`package` API, protocols, persisted and wire formats
- SwiftUI / MVVM / TCA boundaries, `@Observable` state ownership, single source of truth
- Dependency injection vs singletons; Swift package and module boundaries
- Flags breaking and subtle contract changes (Codable keys, schema migrations, deployment target)
- Proposes simpler designs

**comments**:
- Verifies DocC `///` comments against signatures (`- Parameter`, `- Returns`, `- Throws`)
- Identifies comment rot and broken symbol links
- Checks public API documentation completeness

**tests**:
- Reviews behavioral coverage in XCTest / Swift Testing
- Async test correctness (no sleeps, awaited tasks), UI test robustness, snapshot hygiene
- Identifies critical gaps

**errors**:
- Finds silent failures: swallowed `try?`, empty `catch`, dropped `Task` errors
- Reviews `throws`/`Result`/typed throws and catch-clause specificity
- Checks logging and user-facing error states

**types**:
- Value vs reference semantics, enums with associated values
- `Sendable`, actor isolation, strict-concurrency cleanliness
- Rates encapsulation and invariant expression/enforcement

**simplify**:
- Simplifies complex code and improves clarity
- Runs `ponytail:ponytail-review` on the change and `ponytail:ponytail-audit` on the whole touched files (when those skills are available; the same passes manually otherwise)
- Reports cuts; the coordinator applies the behaviour-preserving ones (step 8)

## Tips:

- **Run early**: Before creating PR, not after
- **Focus on changes**: Agents analyze the scoped change set
- **Address critical first**: Fix high-priority issues before lower priority
- **Re-run after fixes**: Verify issues are resolved
- **Use specific reviews**: Target specific aspects when you know the concern

## Notes:

- Agents run autonomously and return detailed reports
- Each agent focuses on its specialty for deep analysis
- Results are actionable with specific file:line references
- Agents use appropriate models for their complexity
