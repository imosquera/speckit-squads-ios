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

Apply this gate when the feature is implemented in Swift. If the feature has no
Swift surface, write `## Parse Boundaries` with a single line "N/A — no Swift
in this feature" and continue.

For a Swift feature, the section MUST enumerate:

1. **Trust boundaries** — every point where untrusted data enters the feature
   (`URLSession` responses, files and caches, `UserDefaults`, keychain items,
   deep links / universal links / URL query items, push and widget payloads,
   pasteboard, text fields, third-party SDK callbacks). Each entry names the raw
   input (`Data`, `String`, `URLComponents`, `[AnyHashable: Any]` userInfo)
   and states that it stays raw only until its parser runs — never passed on as
   `Any` or `[String: Any]`.
2. **Domain types** — the precise types the feature earns the right to trust
   (e.g. `Email`, `UserID`), and how each is made distinct: a wrapper struct
   (`struct Email { let raw: String; init(parsing:) throws }`), a
   `RawRepresentable` struct, or a phantom-tagged type (`Tagged<User, UUID>`).
   Every domain primitive that could be confused with another (`UserID` vs
   `OrderID`) is called out as its own type.
3. **Parsers** — for each boundary, the parser that maps the raw input to a
   domain type: a throwing `init(parsing:)`, a failable `init?`, or a
   `Decodable` conformance (custom `init(from:)` where the wire shape differs
   from the domain type). Each returns the domain type or throws a single typed
   error; none returns a bare `Bool`, uses `try!`, or leaves callers to
   re-check. Name the type or file that owns each parser; `as!` and
   `JSONSerialization` live only there.
4. **Decoding strategy** — `Codable` with `JSONDecoder` into domain types
   (preferred), separate wire DTOs mapped into domain types, or hand-written
   parsers over `JSONSerialization` for legacy payloads — and why. Prefer what
   the project already uses over new hand-rolled casts.

Do not write the blanket sentence "inputs are validated" — that is the exact
anti-pattern this section exists to replace. Name the parser, its input, and its
output type.

## Failure Policy

- A Swift feature whose `plan.md` lacks a substantive
  `## Parse Boundaries` section (boundaries + domain types + parsers) is
  incomplete. Fill it in before finishing the command.
- Downstream `/speckit-implement` (under this preset) will scan the written code
  against this design; a plan that hand-waves the boundaries will surface as
  scan findings later.

## Completion Report

On success, include:
- Confirmation that `plan.md` has a `## Parse Boundaries` section (or that it is
  N/A for a feature with no Swift).
- A one-line summary of the boundaries, domain types, and parsers identified.
- The normal stock `/speckit-plan` completion summary.
