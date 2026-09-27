# `diff-minimal`

**A shorter spec and a smaller change are different problems, and the second one
is the expensive one.**

`spec-minimal` strips `## Assumptions`, `### Key Entities`, and
`## Success Criteria` out of `spec.md`. That makes the spec shorter. It does
nothing to make the resulting *change* smaller: a spec that faithfully restates
an issue's seven-file wish list produces a seven-file diff even when three of
those files have no reason to be touched — because nothing in the pipeline ever
asks "does this change actually need that file?".

Observed on `seasonpass#182`: the issue asked for a Firestore composite index
(the query was a single equality filter the database already indexes) and a
security-rules change (the read runs in Cloud Functions on the Admin SDK, which
never consults rules, and a rules edit would have pulled a Terraform apply in
behind it). Two of seven files, both removable, and only because the spec author
happened to check.

This preset makes that check mandatory and its result durable.

## What it does

Two `wrap` layers, one prompt half and one deterministic half each.

### `speckit.specify` — the mandate

Before the spec is written: re-derive every file path and precondition the issue
asserts against current `main`. Then specify the smallest change that satisfies
the requirements — extend before adding, treat every file the issue names as a
hypothesis, reuse the existing shape, and no drive-by refactors.

Two sections become mandatory in `spec.md`:

```markdown
## Corrections to the issue as filed

- `firestore.indexes.json` — dropped: the query is a single equality filter the
  database already indexes.

## Scope discipline

**MUST NOT touch:**

- `firestore.rules` — the read runs on the Admin SDK, which never consults rules
- `infra/**` — a rules change would pull a Terraform apply in behind it

**Scope justification:** <only when the change is inherently wide>
```

`check-scope-sections.ts` asserts after the core flow that both headings exist
and are populated. `None.` is an accepted answer for either — a spec with no
corrections should say so, not invent one.

### `speckit.plan` — the contract

`## Scope discipline` is binding on the plan. `check-plan-scope.ts` parses the
`MUST NOT touch:` list out of `spec.md` and scans `plan.md`, `tasks.md`, and any
`quickstart.md` / `research.md` for work in those paths, failing with `file:line`
for each hit.

It reads the **artifacts, not the diff**, because at plan time there is no diff
— and catching a forbidden path in the plan is the cheap moment.

## Wrapped bullets are one bullet

Both checkers parse **folded logical lines**, not physical ones:
`scope-common.ts`'s `logicalLines()` joins a wrapped line onto the bullet or
`**marker:**` line it continues, and a blank line — or any line that opens
something of its own — closes the block. The reported line number is the line
the block *started* on, so a violation still points at the bullet rather than at
its tail.

**Only a bullet or a `**marker:**` line accepts a continuation. Prose does not
fold.** That limit is the point, not an omission: folding consecutive prose
lines would make two sentences of one paragraph a single logical line, and a
negation in the first sentence would then silently exempt a violation in the
second. A wrongly-exempted violation is a worse failure than the truncation this
fixes, and both defects #68 reports were wrapped *bullets*. Fenced code blocks,
ordered items, blockquotes, table rows and thematic breaks are block openers too,
so none of them fold into a bullet written directly above them.

Matching physical lines broke in both directions (issue #68):

- a `MUST NOT touch:` bullet that wrapped ended the list at its first
  continuation line — nine forbidden paths silently became one, and the plan
  check passed;
- a plan line that restated an exclusion across a wrap (`this file MUST NOT be /
  touched`) lost its negation on the physical line carrying the path, and was
  reported as a violation.

Nothing about authoring changes: prose wraps, and neither the spec nor the plan
has to keep a bullet on one physical line to be parsed correctly.

## Why the two sections have to be sections

Both halves of the rule want a known heading, which is exactly what a preset can
guarantee and a per-project `CLAUDE.md` line cannot:

- **`## Corrections to the issue as filed`** is only useful if it survives into
  the issue body. The `git` extension's `/speckit-git-issue` renders whatever
  sections `spec.md` actually contains, so the section travels to the tracking
  issue for free — but only if something guarantees it was written.
- **`## Scope discipline`** is a contract the *later* phases enforce. That is
  only checkable against a known heading with a parseable list.

## Not a mandate for small changes

A migration, a rename, a framework upgrade, or a schema change legitimately
touches many files. Holding one of those to a small diff would be the failure,
not the discipline. The escape hatch is explicit: a `**Scope justification:**`
line in `## Scope discipline` naming what makes the breadth intrinsic. What is
never acceptable is breadth nobody accounted for.

## Why a sibling preset rather than an extension of `spec-minimal`

`spec-minimal` is a pure deterministic post-processor with no prompt layer; this
adds one, and the two answer different questions. Keeping them separate lets a
project take the section stripper without the mandate, or the mandate without
the stripper. Composition is already supported — `spec-minimal` and
`spec-ui-preview` stack today, and all three sort at the default priority 10, so
they compose as `wrap` layers in id order with no ordering contract to maintain.

The stripper never touches either of the two sections this preset adds, so the
order the two `speckit.specify` layers compose in does not matter.

## Anti-false-positive rules in the plan check

A plan that *restates* an exclusion is doing the right thing and must not be
flagged for it. Two classes of line are skipped:

- any line whose own text negates — `MUST NOT`, `do not touch`, `out of scope`,
  `excluded`, `no changes to`, `leave alone`, `untouched`;
- every line under a heading matching `scope`, `non-goals`, `corrections`, or
  `constraints`, up to the next heading of the same or a shallower level.

Both exemptions are evaluated on the folded logical line, so a restatement that
wraps still carries its own negation.

A checker that cries wolf gets disabled within a day.

## Path syntax

Entries are globs, matched as substrings against each artifact logical line:

| Spelling | Matches |
|----------|---------|
| `` `infra/**` `` | `infra/` and everything beneath it, at any depth |
| `` `src/*.ts` `` | `.ts` files directly in `src/`, not in subdirectories |
| `` `firestore.rules` `` | that literal path anywhere on a line |
| `` `infra/` `` | trailing slash is shorthand for `infra/**` |

A bullet without backticks still gets parsed — the first token that looks like a
path is used — so a forgotten backtick degrades to a check, not to silence.

## Tests

```bash
bun presets/diff-minimal/scripts/ts/selftest-diff-minimal.ts
```

Self-contained, no framework. Both scripts are read-only, so every case asserts
the exit code *and* that the input files were left byte-identical.
