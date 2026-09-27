---
description: "Require the plan to name trust boundaries and parsers up front"
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

Execute the canonical stock `/speckit-plan` flow with **one mandatory gate**: a
Parse boundary design section in the generated `plan.md`.

### Core Flow

Run the core plan flow first so that `plan.md` exists before the gate is applied.

{CORE_TEMPLATE}

### Mandatory "Parse Boundaries" section

After the core flow has produced `plan.md`, add a **`## Parse Boundaries`**
section to it. This section makes the *parse, don't validate* discipline a
design decision rather than a write-time afterthought.

Apply this gate when the feature is implemented in TypeScript or Python. If the
feature has no TypeScript/Python surface, write `## Parse Boundaries` with a
single line "N/A — no TypeScript or Python in this feature" and continue.

For a TypeScript or Python feature, the section MUST enumerate:

1. **Trust boundaries** — every point where untrusted data enters the feature
   (HTTP handlers, DB rows, env, file/CLI input, `JSON.parse` / `json.loads`,
   third-party SDK responses). Each entry names the raw input and states that it
   is kept untyped-safe on the way in (`unknown` in TypeScript, never `any`;
   fed straight to a parser in Python, never left as `Any`).
2. **Domain types** — the precise / branded types the feature earns the right to
   trust (e.g. `Email`, `UserId`), including how identity is made nominal
   (TypeScript: non-exported `unique symbol` brand or a schema library's
   `.brand()`; Python: `NewType`, a pydantic/attrs model, or a frozen
   dataclass). Every domain primitive that could be confused with another
   (`UserId` vs `OrderId`) is called out as branded.
3. **Parsers** — for each boundary, the parser that maps the raw blob to a
   domain type. TypeScript parsers return a discriminated `Result`
   (`{ kind: "ok" | "err" }`); Python parsers return the parsed model or raise a
   single typed parse error — neither returns a bare boolean and neither relies
   on `throw`/scattered re-checks. Name the module that owns each parser; brand
   casts live only there.
4. **Library choice** — whether the feature uses a schema library (TS: Zod /
   valibot / io-ts; Python: pydantic / attrs / msgspec) or hand-rolled parsers,
   and why. Prefer an existing project dependency over new hand-rolled casts.

Do not write the blanket sentence "inputs are validated" — that is the exact
anti-pattern this section exists to replace. Name the parser, its input, and its
output type.

## Failure Policy

- A TypeScript/Python feature whose `plan.md` lacks a substantive
  `## Parse Boundaries` section (boundaries + domain types + parsers) is
  incomplete. Fill it in before finishing the command.
- Downstream `/speckit-implement` (under this preset) will scan the written code
  against this design; a plan that hand-waves the boundaries will surface as
  scan findings later.

## Completion Report

On success, include:
- Confirmation that `plan.md` has a `## Parse Boundaries` section (or that it is
  N/A for a non-TypeScript/Python feature).
- A one-line summary of the boundaries, domain types, and parsers identified.
- The normal stock `/speckit-plan` completion summary.
