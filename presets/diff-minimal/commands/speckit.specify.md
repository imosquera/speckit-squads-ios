---
description: "Composable wrapper for /speckit-specify that imposes a minimum-diff mandate: re-derive the issue's claims against main, specify the smallest change that satisfies the requirements, and record the result in two mandatory sections."
---

## Wrapper Layer

This preset wraps the stock `/speckit-specify` command. Keep the stock workflow
for branch/worktree setup, feature directory creation, template loading,
checklist generation, hooks, and reporting.

This layer adds a **minimum-diff mandate**. A short spec and a small change are
different things, and the second is the expensive one: a spec that faithfully
restates an issue's seven-file wish list produces a seven-file diff even when
three of those files had no reason to be touched, because nothing in the
pipeline ever asked whether the change actually needed them.

### Minimum-Diff Mandate (MANDATORY)

Before writing the spec, **re-derive every file path and precondition the issue
asserts against current `main`**. Stale references are the norm, not the
exception, and a correction is cheaper than a wrong spec.

Then specify the smallest change that satisfies the requirements:

- **Prefer extending a file that already exists over adding one.** A new module,
  a new route file, a new registration seam, or a new config entry each needs a
  reason stated in the spec — "it is tidier" is not one.
- **Every file the issue names is a hypothesis, not a requirement.** Drop the
  ones the change does not actually need — an index for a query the database
  already serves; a security rule nothing evaluates; a Terraform apply behind it
  — and record why in `## Corrections to the issue as filed`.
- **Reuse the existing shape**: the payload builder, the ownership check, the
  error discriminant, the test helper. A second way to do something the codebase
  already does is a DRY violation, not a design choice.
- **No drive-by refactors**, no renames, no formatting churn, no "while I was in
  here". If a cleanup is genuinely warranted, it is a separate issue.
- **Success looks like a diff a reviewer can read in one sitting.**

**This is a mandate for the smallest change, not a mandate for small changes.**
A migration, a rename, a framework upgrade, or a schema change legitimately
touches many files, and holding one of those to a small diff would be the
failure, not the discipline. When the change is inherently wide, say so:
add a `**Scope justification:**` line to `## Scope discipline` naming what makes
the breadth intrinsic. What is never acceptable is breadth nobody accounted for.

If implementation later shows an excluded file is genuinely required, that is a
**spec change recorded on the issue** — never a quiet edit.

### Required Sections (MANDATORY)

`spec.md` MUST carry these two sections. They are checked deterministically
after the core flow, and they exist so that later phases can be held to them:
the `git` extension renders whatever sections the spec contains into the
tracking issue, so both survive into the issue body, and `## Scope discipline`
has a known heading that `/speckit-plan` and the review passes can parse.

```markdown
## Corrections to the issue as filed

- `path/from/the/issue` — dropped: the query is a single equality filter the
  database already indexes, so no composite index is needed.
- The issue says the read happens in the client; it runs in a Cloud Function on
  the Admin SDK.

## Scope discipline

**MUST NOT touch:**

- `firestore.rules` — the read runs on the Admin SDK, which never consults rules
- `infra/**` — a rules change would pull a Terraform apply in behind it
- `src/legacy/**` — unrelated layer

**Scope justification:** <only when the change is inherently wide — what makes
the breadth intrinsic>
```

Rules for both sections:

- Each `MUST NOT touch:` entry is a bullet whose path or glob is in **backticks**.
  `**` spans directory separators, a single `*` does not, and a trailing `/`
  means the directory and everything under it.
- Give a short reason per entry. The reason is what stops a later phase from
  overturning the exclusion by guessing.
- If the issue was right in every particular, write `None.` under
  `## Corrections to the issue as filed` rather than inventing a correction.
- If nothing needs holding out, write `None.` under `## Scope discipline` — an
  empty heading is worse than no heading, because later phases would be held to
  nothing while appearing to be held to something.

### Core Flow

{CORE_TEMPLATE}

### Post-Flight Check (MANDATORY — LAST STEP)

After the entire core flow above has completed and `spec.md` has been written,
and before reporting success, verify the two sections:

```bash
bun .specify/presets/diff-minimal/scripts/ts/check-scope-sections.ts "$SPECIFY_FEATURE_DIRECTORY/spec.md"
```

This MUST run **before any post-execution hook renders `spec.md` into a GitHub
issue**, so the issue body carries both sections. If a hook has already
published a body from a spec that failed this check, fix the spec and re-run
that hook.

The check is read-only — it never edits the spec. Handle the exit code:

- **`0`** — both sections are present and populated. Report success.
- **`1`** — read the stderr: it names the missing or empty section and shows the
  expected shape. **Write the missing content into `spec.md` yourself** — do not
  ask the user to, and do not report success — then re-run the check.
- **`2`** — bad usage: the invocation above is wrong. Fix the call and re-run.
