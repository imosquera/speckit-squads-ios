---
description: "Composable wrapper for /speckit-plan that holds the documentation tree to spec.md, plan.md, tasks.md, and optional quickstart.md/research.md via a mandatory prompt rule plus a self-healing post-flight enforcer."
---

## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper that
the core flow expands to, e.g. from another chained `speckit.plan` preset). It
enforces a strictly minimal artifact tree.

Enforcement has two halves — the prompt rule below prevents, and the post-flight
enforcer guarantees. `presets/spec-minimal/README.md` is the canonical
description of the mechanism; do not restate it elsewhere.

### Documentation Rule (MANDATORY — NO EXCEPTIONS)

The feature directory MUST contain ONLY these entries at the top level:

- `spec.md`
- `plan.md`
- `tasks.md`
- `quickstart.md` (optional but allowed)
- `research.md` (optional but allowed — e.g. written by the `library-research`
  preset; nothing pre-creates it)
- `checklists/` (allowed — core Spec Kit's `/speckit-specify` mandates
  `checklists/requirements.md`)

`data-model.md` and `contracts/` **MUST NOT be created** — not as files, not as
directories, not in any form. There is no escape hatch. Any content that the
stock flow would have written into one of those paths MUST instead be inlined
as a section of `plan.md`.

When you reach any step of the core flow that would create `data-model.md` or
`contracts/`, do not create the path. Fold its content into `plan.md` and
continue.

In the **Project Structure → Documentation (this feature)** subsection of
`plan.md`, list exactly the allowed files and nothing else.

### Core Flow

{CORE_TEMPLATE}

### Post-Flight Enforcement (MANDATORY — LAST STEP)

After the entire core flow above has completed, and before reporting success, run
the enforcer as the final step:

```bash
bun .specify/presets/spec-minimal/scripts/ts/enforce-minimal-tree.ts "$SPECIFY_FEATURE_DIRECTORY"
```

The enforcer is self-healing: if a forbidden artifact is on disk it folds the
content into `plan.md` under an `## Inlined from <name>` heading (inside an
idempotent sentinel block) and then deletes the artifact. It always writes
`plan.md` before removing anything, so content cannot be lost. If `plan.md` is
missing it creates it. Unknown top-level entries only produce a `warning:` on
stderr — they never fail the run, so stacking with other presets is safe.

Handle the exit code as follows:

- **`0`** — the tree is clean. If the enforcer reported that it folded and
  removed any artifacts (or created `plan.md`), tell the user exactly what was
  inlined, created, and removed, then report success.
- **`1`** — read the stderr, which always says which of two cases it is:
  - `HEALING IMPOSSIBLE` — nothing was written to `plan.md` and nothing was
    removed. Surface the error verbatim, fix the underlying problem (an
    unbalanced sentinel in `plan.md`, an unreadable path, an unwritable
    directory), and re-run the enforcer.
  - `PARTIALLY HEALED` — the content IS already safely inlined in `plan.md`,
    but a forbidden artifact could not be removed. Surface the error verbatim,
    remove the named artifact (nothing is lost by doing so), and re-run.

  In both cases, do not report success.
- **`2`** — bad usage: the invocation above is wrong. Fix the call and re-run.

Only report success once the enforcer exits `0`.
