---
description: "Composable wrapper for /speckit-specify that requires an `## Actions & Buttons` table for every UI-touching iOS feature, in Apple HIG / SwiftUI terms: Button vs NavigationLink/Link, one `.borderedProminent` per screen, toolbar placement, specific 1–3 word labels, and `role: .destructive` plus a safeguard on every destructive action — checked deterministically after the spec is written."
---

## Wrapper Layer

This preset wraps the stock `/speckit-specify` command. Keep the stock workflow
for branch/worktree setup, feature directory creation, template loading,
checklist generation, hooks, and reporting.

This layer makes the feature's **actions** a requirement. Which control is the
next step, what it says, and what it costs to click it wrongly are product
decisions. Left to implementation they get made by whoever writes the view,
one screen at a time, and the result is three `.borderedProminent` buttons on
one screen and an `OK` in the delete dialog.

The target is an iOS app built with SwiftUI (UIKit where the project already
uses it). Speak Apple Human Interface Guidelines and SwiftUI, not web: there is
no hover on iPhone, no CSS, no `<a>` vs `<button>`.

### Button Rules (MANDATORY)

Apply these to every user-facing action the feature adds or changes:

1. **Buttons do something; links go somewhere.** Saving, starting a process,
   presenting a sheet → `Button`. Pushing a screen onto the navigation stack →
   `NavigationLink`. Opening a URL in Safari or another app → `Link`. Never
   dress a link up as the screen's primary action.
2. **One primary per screen.** Exactly one action is the next best step and
   gets `.buttonStyle(.borderedProminent)`. Everything else is `.bordered`,
   `.borderless`, or `.plain`. Toolbar and dialog buttons use `automatic`
   (the system styles them). A sheet or a `confirmationDialog` is its own
   screen.
3. **Place it where the platform expects it.** In a toolbar, the affirmative
   step goes in `.confirmationAction` (e.g. `Done`, `Save`), dismissal in
   `.cancellationAction`, and the screen's main command in `.primaryAction`.
   A primary action at the bottom of the screen sits in the bottom bar or a
   safe-area inset, inside thumb reach. Row actions go in swipe actions or a
   context menu.
4. **Labels are 1–3 words, verb first, and say what happens next.**
   `Export Report`, not `OK`/`Yes`/`Submit`/`Confirm`. Title case, per HIG.
   If a label would make sense on any screen of the app, it is too generic.
   Standard system labels (`Done`, `Cancel`, `Edit`) are fine in their
   standard slots.
5. **Match the moment.** On the step that completes the task, the label names
   the completion (`Export Report`), not the flow (`Next`).
6. **Destructive actions use `role: .destructive`, name their consequence, and
   carry a safeguard.** `Delete Account`, `Cancel Subscription`,
   `Remove Photo` — never a bare `Delete`. The role gives the system red and
   tells VoiceOver. Each one gets a `confirmationDialog` or `alert` (with a
   `role: .cancel` button to back out), a type-to-confirm step for the
   unrecoverable ones, or swipe-to-delete plus undo.
7. **Speak the user's language.** No internal feature names or jargon in a
   label; use the verb a user would say out loud.

### Required Section (MANDATORY)

`spec.md` MUST carry an `## Actions & Buttons` section, placed after
`## User Scenarios & Testing`. The `git` extension renders it into the tracking
issue, and `/speckit-plan` is held to it.

```markdown
## Actions & Buttons

| Screen | Label | Control | Style | Role | Placement | Safeguard |
|---|---|---|---|---|---|---|
| Export sheet | Export Report | Button | automatic | — | toolbar .confirmationAction | — |
| Export sheet | Cancel | Button | automatic | cancel | toolbar .cancellationAction | — |
| Settings | Save Changes | Button | borderedProminent | — | bottom bar | — |
| Settings | Delete Account | Button | bordered | destructive | inline | confirmationDialog + type-to-confirm |
| Delete dialog | Delete Account | Button | automatic | destructive | dialog | confirmationDialog |
| Delete dialog | Keep Account | Button | automatic | cancel | dialog | — |
| Settings | Notifications | NavigationLink | — | — | list row | — |
| Settings | Privacy Policy | Link | — | — | inline | — |
| Inbox | Delete Message | Button | automatic | destructive | swipe action | undo |
```

- **Control** is `Button`, `NavigationLink`, or `Link`.
- **Style** is the SwiftUI button style: `borderedProminent` (at most one per
  screen), `bordered`, `borderless`, `plain`, or `automatic` (toolbar,
  dialog, and swipe buttons the system styles). A link takes `—` or a
  non-prominent style.
- **Role** is `—`, `destructive` (`role: .destructive`), or `cancel`
  (`role: .cancel`). Links take `—`. `.confirmationAction` holds neither
  role; `.cancellationAction` never holds a destructive one.
- **Placement** is where it lives: `toolbar .primaryAction`,
  `toolbar .confirmationAction`, `toolbar .cancellationAction`,
  `bottom bar`, `inline`, `list row`, `dialog`, `swipe action`, or
  `context menu`.
- **Safeguard** is `—` for a non-destructive action. For a destructive one it
  names the mechanism: `confirmationDialog`, `alert`, `type-to-confirm`, or
  `undo`.
- The label is the exact copy the user will read.
- If the feature has **no user-facing UI**, write `None — no user-facing UI.`
  under the heading. Do not omit the heading: an absent section and a
  deliberate "none" must read differently.

### Core Flow

{CORE_TEMPLATE}

### Applicability Gate (after `spec.md` is written)

Before writing `## Actions & Buttons`, ask Jev whether the spec touches UI:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
bun "$PROJECT_DIR/.specify/presets/button-design/scripts/ts/jev.ts" applies-ui --spec "$SPECIFY_FEATURE_DIRECTORY/spec.md"
```

- **exit 0, `decision: "skip"`**: write only `None — no user-facing UI.` under
  `## Actions & Buttons`, then run the post-flight check.
- **exit 0, `decision: "applies"`**: apply the rules above and write the table.
- **exit 3** (or any other exit): decide from the spec yourself, as without Jev.

Quote the printed `record` line in your final report.

### Post-Flight Check (MANDATORY — LAST STEP)

After the entire core flow above has completed and `spec.md` has been written,
and before reporting success:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
bun "$PROJECT_DIR/.specify/presets/button-design/scripts/ts/check-buttons.ts" spec "$SPECIFY_FEATURE_DIRECTORY/spec.md"
```

This MUST run **before any post-execution hook renders `spec.md` into a GitHub
issue**, so the issue body carries a section that passed. If a hook already
published a body from a failing spec, fix the spec and re-run that hook.

The check is read-only. Handle the exit code:

- **`0`**: the table follows the rules, or the section says `None.`. Notes on
  stdout (e.g. a screen with buttons but no primary) are advisory. Report
  success.
- **`1`**: stderr names each violating row and rule. **Fix `spec.md`
  yourself.** Rewrite the label, demote the extra `.borderedProminent`, add
  `role: .destructive` or the safeguard, or move the item to the right
  toolbar slot. Then re-run. Do not report success while it fails.
- **`2`**: bad usage. Fix the call and re-run.
