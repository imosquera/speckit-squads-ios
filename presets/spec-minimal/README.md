# spec-minimal preset

Wraps `/speckit-specify` and `/speckit-plan` to trim the generated artifacts without replacing the stock command flow.

## What it cuts

| Command | Default artifacts | Under `spec-minimal` |
|---|---|---|
| `/speckit-specify` | `spec.md` with all sections | `spec.md` minus **Assumptions**, **Key Entities**, and **Success Criteria** |
| `/speckit-plan` | `plan.md` + `research.md` + `data-model.md` + `quickstart.md` + `contracts/` | `spec.md`, `plan.md`, `tasks.md`, `checklists/`, optionally `quickstart.md` and `research.md` — `data-model.md` and `contracts/` are forbidden |

This preset does one thing: artifact minimalism. GitHub issue sync lives in the `git` extension (`/speckit-git-issue`, on the `after_specify` hook).

## How enforcement works

This is the canonical description — `preset.yml` and both command files reference it rather than restating it.

Enforcement has two halves:

1. **The prompt rule prevents.** `commands/speckit.plan.md` carries a mandatory, no-exceptions rule: the agent must never create `data-model.md` or `contracts/` in the first place. Content that would have gone into one of those paths is inlined as a section of `plan.md` instead.
2. **The post-flight enforcer guarantees.** As the last step of every plan run, `bun scripts/ts/enforce-minimal-tree.ts "$SPECIFY_FEATURE_DIRECTORY"` runs. It is self-healing rather than read-only: if a forbidden artifact made it to disk anyway, the script folds its content into `plan.md` under an `## Inlined from <name>` heading — inside an idempotent `<!-- BEGIN: spec-minimal inlined <name> -->` / `<!-- END: ... -->` sentinel block — and then deletes the artifact. No content is lost and no broken tree is left behind.

On the specify side the same role is played by `bun scripts/ts/strip-spec-sections.ts <spec.md>`, which `commands/speckit.specify.md` runs after the core flow. It edits `spec.md` in place and idempotently deletes three sections — `## Assumptions`, `### Key Entities`, and `## Success Criteria` — each from its heading line down to the next heading of the same-or-shallower level (or EOF). It exits `2` on bad usage and otherwise `0`. Heading matching tolerates the template's trailing parenthetical (`## Success Criteria *(mandatory)*`, `### Key Entities *(include if feature involves data)*`) — `$`-anchored patterns matched neither while the script still printed a fixed success line, so two of the three sections survived every run (issue #58). The summary now names what was removed and what was absent; `bun test-strip-spec-sections.ts` is the check.

The enforcer's ordering is what makes it safe to run against real work: it gathers all content first, writes the complete new `plan.md` **atomically** (temp file in the same directory, always UTF-8, `fsync` + `rename`, original permission bits preserved), and only removes anything once that write has succeeded. `plan.md` is never truncated in place. Two consequences worth knowing: content inlined from an artifact has any literal sentinel string neutralized to `<!-- (escaped by spec-minimal) BEGIN: ... -->` so a block body can never be mistaken for a block boundary; and a symlinked forbidden path (including a dangling one) has only the link removed — the target is never read, followed, or modified, and this is reported as such rather than as "empty". A missing `plan.md` is not a failure: `plan.md` is itself allowed, so the enforcer creates it with a minimal header and rehomes the content there.

Exit codes:

- **`0`** — the tree matches the allowed set; no forbidden artifact remains on disk. Healing (possibly including creating `plan.md`) and `warning:` lines may have happened, and are reported.
- **`1`** — one of exactly two situations, each stated explicitly on stderr:
  - `HEALING IMPOSSIBLE` — **nothing was written to `plan.md` and nothing was removed.** Causes: the feature directory cannot be listed; `plan.md` exists but is not readable as UTF-8; `plan.md` contains an unbalanced sentinel (an unmatched `BEGIN` is a hard error, since the block structure would otherwise be ambiguous); a forbidden artifact cannot be read; or `plan.md` cannot be written.
  - `PARTIALLY HEALED` — **the content IS safely inlined in `plan.md`, but at least one forbidden artifact could not be removed** and is still on disk. Deleting it by hand loses nothing.
- **`2`** — bad usage.

Unknown top-level entries are **not** failures. The enforcer emits a `warning:` on stderr and carries on, so a file legitimately written by a stacked preset never breaks the run. Dotfiles are ignored entirely. Nothing is ever pre-created on disk — the one file the enforcer will create is `plan.md`, and only when there is inlined content that would otherwise have nowhere to go.

`checklists/` is in the allowed set, not merely tolerated as an unknown entry: core Spec Kit's own `/speckit-specify` mandates writing `checklists/requirements.md`, so warning about it on every single run would train the reader to ignore the warnings. It is never created or healed by the enforcer.

`research.md` is allowed but never pre-created — it exists so the `library-research` preset can stack on top of `spec-minimal` without having its findings folded away.

## Install

```bash
specify preset add --dev ~/Code/speckit-squads/presets/spec-minimal
```

## Stacking

`spec-minimal` composes with the stock `speckit.specify` and `speckit.plan` flows instead of replacing them, so it stacks cleanly with implement-focused presets such as `worktree-isolation` and `tdd`.

Presets that wrap the *same* command nest rather than collide: the engine orders wrappers by priority ascending, then alphabetically by preset id, and each wrapper's core-flow seam expands to the next one in. That makes `spec-minimal` + `diff-minimal` + `library-research` a valid stack — each layer sees the stock flow (plus the inner layers) at its seam.

## When NOT to use

- Features that introduce real new entities and need a standalone `data-model.md` (this preset forbids it).
- Public-facing APIs across service boundaries that need a `contracts/` source of truth (forbidden here).
- First feature in a new project (the full artifact set helps establish norms).
