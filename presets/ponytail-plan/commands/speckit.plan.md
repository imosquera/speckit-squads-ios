---
description: "Composable wrapper for /speckit-plan that climbs the ponytail ladder for every new file, abstraction, dependency and config knob the finished plan proposes, cuts what a lower rung covers, and records the result in a mandatory `## Ladder` section."
---

## Wrapper Layer

This preset wraps `/speckit-plan` and every inner layer (e.g. `library-research`,
which adds libraries). The plan is where new files, layers and dependencies get
committed to, so it is the cheap place to cut them: nothing is written yet and
`tasks.md` does not exist.

If `ponytail:ponytail` is explicitly listed among this session's available
skills, invoke it before the core flow. Never guess a skill name or install one;
if it is not listed, skip it silently. The ladder below is the binding rule
either way.

### Core Flow

{CORE_TEMPLATE}

### Ladder Pass (MANDATORY — runs after the core flow)

Re-read the finished `plan.md` (and `research.md` if present). Enumerate every
item it proposes to **add**:

- **file** — a new source, config, migration, or test file
- **abstraction** — a new interface, class, module, service, or layer
- **dependency** — a package or external service not in the project today
- **config** — a new setting, flag, env var, or option

For each, read the code it would touch first, then climb. Stop at the first rung
that holds:

1. **Does it need to exist?** Speculative need → cut it. (YAGNI)
2. **Already in this codebase?** Reuse the helper, type, or pattern.
3. **Stdlib does it?**
4. **Native platform feature covers it?** (CSS over JS, a DB constraint over app code.)
5. **Already-installed dependency solves it?**
6. **Can it be one line?**
7. **Only then:** the minimum new code, or a new dependency.

No interface with one implementation, no factory for one product, no config for
a value that never changes, no scaffolding for later.

**Never cut:** validation at trust boundaries, error handling that prevents data
loss, security measures, accessibility basics, or anything `spec.md` explicitly
requires. Those rows record rung 7 with the reason.

**Apply the result, do not just note it.** An item that stops at rung 1 is
removed from `plan.md`. An item that stops at rungs 2–6 is rewritten in
`plan.md` to use the existing code, stdlib, platform feature, installed
dependency, or one-liner instead. A library `library-research` recommended is a
dependency like any other: if rungs 2–6 hold, revise `plan.md` and note the
reversal in `research.md`.

Then add this section to `plan.md`:

```markdown
## Ladder

| Item | Kind | Rung | Reason |
|------|------|------|--------|
| `src/cache.ts` | file | 1 | cut: no measured latency problem |
| RetryPolicy interface | abstraction | 2 | reuse `withBackoff()` in `src/http.ts` |
| `p-queue` | dependency | 7 | concurrency cap across workers |

**Dependency justification:** `p-queue` — no queue in the codebase (2), stdlib
has none (3), no platform primitive (4), no installed dep covers it (5), a
correct cap is not one line (6).
```

- `Kind` is one of `file`, `abstraction`, `dependency`, `config`.
- `Rung` is the single integer 1–7 the item stopped at. An installed dependency
  is rung 5; a **new** dependency is rung 7.
- Any `dependency` row at rung 7 requires a populated
  `**Dependency justification:**` line naming why rungs 2–6 fail.
- A plan that adds nothing writes the section with exactly
  `None — extends existing code only.` in place of the table.

### Post-Flight Check (MANDATORY — LAST STEP)

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
bun "$PROJECT_DIR/.specify/presets/ponytail-plan/scripts/ts/check-ladder.ts" "$SPECIFY_FEATURE_DIRECTORY/plan.md"
```

The check is read-only. Handle the exit code:

- **`0`**: the section is present and well-formed. Report success.
- **`1`**: stderr lists each problem as `file:line`. Fix `plan.md` and re-run.
  Do not report success while it fails.
- **`2`**: bad usage or no `plan.md`. Fix the call and re-run.

The check is mechanical: it cannot tell whether a rung was honestly climbed.
That part is on you.
