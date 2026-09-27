# `ponytail-plan`

Applies the [ponytail](https://github.com/DietrichGebert/ponytail) ladder at the
**plan** phase.

## What

A `wrap` layer on `speckit.plan`. After every inner layer has written
`plan.md` (and `research.md`), it enumerates each new **file**, **abstraction**,
**dependency** and **config** knob the plan proposes and climbs the ladder for
each:

1. does it need to exist (YAGNI) → 2. already in the codebase → 3. stdlib →
4. native platform feature → 5. already-installed dependency → 6. one line →
7. minimum new code.

An item that stops at rung 1 is cut from `plan.md`; one that stops at rungs 2–6
is rewritten in place. The result is recorded in a mandatory `## Ladder` table
(`Item | Kind | Rung | Reason`), or `None — extends existing code only.` A new
dependency (rung 7) needs a `**Dependency justification:**` line.

Never cut: validation at trust boundaries, data-loss error handling, security,
accessibility, or anything `spec.md` explicitly requires.

`check-ladder.ts <plan.md>` is the gate. It checks only what is mechanical —
section present, rows or the `None` line, Kind in the vocabulary, Rung an integer
1–7, justification present for a new dependency — and prints `file:line` on
failure (exit 1; 2 on usage). Whether a rung was honestly climbed is the
prompt's job. `selftest-ponytail-plan.ts` is the check.

## Why the plan phase

Ponytail is already loaded at
review (`ponytail-review`). By implement, the plan has already committed to the
new files, layers and dependencies, and cutting them means arguing with the
plan. At plan time nothing is written and `tasks.md` does not exist yet, so a cut
costs one edit.

`library-research` adds libraries to the plan by design. Something has to judge
those additions against rungs 2–6, and it has to run after them.

## Composition

Install at **priority 8** (`install.ts` does this):

```bash
specify preset add --dev presets/ponytail-plan --priority 8
```

Wrappers compose with the lowest priority number outermost, so its post-seam
text runs **last**. At 8 it sits outside `parse-dont-validate` (9) and
`library-research`, `diff-minimal`, `spec-minimal`, `button-design` (default 10),
and judges what they wrote. The ladder never cuts `parse-dont-validate`'s trust-boundary parsers.

## Ponytail is optional

The ladder is embedded in the command file, so the preset works without the
ponytail plugin. If `ponytail:ponytail` is listed among the session's available
skills it is invoked too; it is never guessed or installed.
