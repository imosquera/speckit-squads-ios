---
description: "Composable wrapper for /speckit-specify that trims Assumptions, Key Entities, and Success Criteria out of spec.md."
---

## Wrapper Layer

This preset wraps the stock `/speckit-specify` command. Keep the stock workflow for branch/worktree setup, feature directory creation, template loading, checklist generation, hooks, and reporting.

This layer adds one post-processing step: a deterministic section stripper that removes `## Assumptions`, `### Key Entities`, and `## Success Criteria` from the rendered `spec.md`. It runs after the core flow below, not during it — the exact instruction is in **Output Rules (MANDATORY — LAST STEP)** after the core-flow seam. Keep all other mandatory sections intact, including User Scenarios, Edge Cases, Functional Requirements, Functional Programming Constraints, and Platform Constraints.

### Core Flow

{CORE_TEMPLATE}

### Output Rules (MANDATORY — LAST STEP)

After the entire core flow above has completed and `spec.md` has been written, and
before reporting success, run the deterministic section stripper as the final step:

```bash
bun .specify/presets/spec-minimal/scripts/ts/strip-spec-sections.ts "$SPECIFY_FEATURE_DIRECTORY/spec.md"
```

This MUST run **before any post-execution hook renders `spec.md` into a GitHub
issue** (or any other downstream consumer reads the file). If the core flow's
post-execution hooks have not yet fired when you reach this point, run the
stripper first and then fire them. If a hook already published an issue body from
the unstripped file, re-run that hook after stripping so the issue reflects the
stripped spec.

The stripper removes `## Assumptions`, `### Key Entities`, and `## Success
Criteria` idempotently — it is safe to run repeatedly. It leaves every other
section untouched.
