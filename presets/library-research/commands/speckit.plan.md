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
   solutions — auth, session/token handling, parsing/validation, queues,
   retries/backoff, rate limiting, caching, diffing, scheduling, PDF/image
   processing, i18n, payments, and similar. Ignore plain internal business
   logic (domain rules specific to this feature) — that is never a research
   target.

   If the plan has no such surface area, write a `research.md` containing
   only `N/A — no build-it-yourself surface area identified in this plan.`,
   skip straight to Completion Report, and do not modify `plan.md`.

2. **Research each unknown using real web search** (`WebSearch` / `WebFetch`
   tools) — do not rely on memorized/training-data knowledge of the library
   ecosystem, since versions, maintenance status, and best-fit choice change
   over time. For each unknown, find 1-3 candidate libraries and check:
   - still maintained (recent releases/commits, not archived)
   - license compatible with the project (avoid GPL/AGPL for permissively
     licensed projects unless the plan already accepts that)
   - fits the project's existing language/runtime and dependencies (check
     `plan.md` and the repo's manifest files, e.g. `package.json`,
     `pyproject.toml`, `go.mod`, before recommending)
   - genuinely reduces scope versus hand-rolling — a library that only
     covers a sliver of the unknown, or adds more integration complexity
     than it removes, is not a win

3. **Write `research.md`** in the feature directory with one section per
   unknown researched:

   ```markdown
   ## <Unknown, e.g. "Rate limiting">

   **Candidates considered:** <library> (<one-line why>), <library> (<one-line why>)
   **Recommendation:** use `<library>` | build custom
   **Why:** <2-3 sentences — maintenance status, fit, scope saved or why nothing fit>
   ```

   `research.md` is a valid artifact under this repo's presets — it is
   explicitly allowed by `spec-minimal` (v1.1.0+) when that preset is also
   installed.

4. **Revise `plan.md` in place** for every unknown where the recommendation
   is "use `<library>`": replace the custom-build description with a note
   that the feature will use the library instead, naming it and linking to
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
