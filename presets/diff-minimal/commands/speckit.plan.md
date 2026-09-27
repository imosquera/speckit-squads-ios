---
description: "Composable wrapper for /speckit-plan that holds the plan to the spec's `## Scope discipline` contract: no plan step may touch a path the spec put out of scope, checked deterministically after the plan is written."
---

## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper the
core flow expands to, e.g. from another chained `speckit.plan` preset).

`## Scope discipline` in `spec.md` is a contract, not a note. This layer is the
half of the minimum-diff mandate that enforces it at plan time — the cheap
moment. The expensive moment is reviewing the seven-file PR the unenforced plan
would have produced.

### Scope Rule (MANDATORY)

Before designing anything, **read `## Scope discipline` in `spec.md`** and treat
its `MUST NOT touch:` list as binding on the plan, on `tasks.md`, and on every
artifact this phase writes.

- No plan step, task, file-change list, or code sketch may modify a listed path.
- Also honour the mandate the spec was written under: prefer extending an
  existing file over adding one, reuse the existing shape rather than inventing
  a parallel one, and plan no refactor, rename, or formatting churn the
  requirements do not need. Each new file the plan introduces needs a reason
  stated in `plan.md`.
- If the design genuinely requires a listed path, **do not quietly widen the
  plan.** Stop, amend `## Scope discipline` in `spec.md` to remove that entry
  with the reason, and say so on the tracking issue. A spec change is a visible
  event; a widened plan is not.
- Restating an exclusion is encouraged, not penalized: a `## Scope` or
  `## Non-Goals` section in `plan.md`, and any line that says a path must not be
  touched, are both exempt from the check below.

If `spec.md` has no `## Scope discipline` section, the spec was written without
this preset's `speckit.specify` layer. Say so in your report and continue —
this layer never invents a scope contract the spec did not sign.

### Core Flow

{CORE_TEMPLATE}

### Post-Flight Check (MANDATORY — LAST STEP)

After the entire core flow above has completed, and before reporting success:

```bash
bun .specify/presets/diff-minimal/scripts/ts/check-plan-scope.ts "$SPECIFY_FEATURE_DIRECTORY"
```

The check is read-only. It parses the spec's `MUST NOT touch:` list and scans
`plan.md`, `tasks.md`, and any `quickstart.md` / `research.md`, skipping lines
that negate ("must not touch `X`") and sections about scope, non-goals, or
corrections.

Handle the exit code:

- **`0`** — the plan respects every out-of-scope path (or the spec forbids
  none). Report success.
- **`1`** — read the stderr: each violation is printed as `file:line` with the
  entry that forbids it. **Remove the work from the plan** and re-run. Only if
  the path is genuinely required do you amend `## Scope discipline` in `spec.md`
  and record the change on the tracking issue — then re-run. Do not report
  success while the check fails.
- **`2`** — bad usage, or no `spec.md` in the feature directory. Fix the call
  and re-run.
