# button-design

Holds every UI-touching iOS feature to Apple Human Interface Guidelines button
rules, in SwiftUI terms (UIKit where the project uses it), at the two cheapest
moments to get them right: the spec and the plan.

| Layer | Adds | Checked by |
|---|---|---|
| `speckit.specify` wrap | `## Actions & Buttons`: a table of every action per screen (label, `Button`/`NavigationLink`/`Link`, button style, `role`, toolbar/bottom-bar placement, destructive safeguard), or `None — no user-facing UI.` | `check-buttons.ts spec <spec.md>` |
| `speckit.plan` wrap | `## Button System`: the `ButtonStyle` to reuse, styles and semantic tint, pressed/disabled/loading states and haptics, 44×44pt hit targets, Dynamic Type and accessibility labels, placement | `check-buttons.ts plan <feature-dir>` |

## What is enforced vs. prompted

**Checked deterministically** (exit 1 fails the phase):

- the section exists, or says `None.`
- control is `Button`, `NavigationLink`, or `Link`; links take no role and
  are never `.borderedProminent`
- a `Button` has a style: `borderedProminent`, `bordered`, `borderless`,
  `plain`, or `automatic`; role is `—`, `destructive`, or `cancel`
- at most one `.borderedProminent` per screen
- every row names its placement; `.confirmationAction` holds no cancel or
  destructive role, `.cancellationAction` no destructive one
- labels are 1–3 words and not generic (`OK`, `Yes`, `Submit`, `Confirm`, …)
- a destructive label (`Delete …`, `Remove …`, `Cancel <object>`, …) has
  `role: .destructive`; any destructive action names its object and carries a
  `confirmationDialog`/`alert`/`type-to-confirm`/`undo` safeguard
- the plan's six markers (Component, Styles & tint, States & feedback, Hit
  targets, Accessibility, Placement) are present and populated; no `N×N` hit
  target under 44×44pt; Accessibility mentions Dynamic Type

**Prompted, not checked:** plain language instead of jargon, labels that match
the moment (`Export Report`, not `Next`), thumb-reach placement, semantic
colors over hard-coded ones, `.contentShape` on small glyphs, `.sensoryFeedback`
where it helps, and reuse of existing button styles. A checker that guesses at
these cries wolf, and one that cries wolf gets disabled.

A screen with in-content buttons but no `.borderedProminent` gets a stdout
note, not a failure; toolbar, dialog, and swipe buttons don't count, since the
system styles those. A plan that mentions `hover` also gets a note: iPhone has
no hover, so keep it only for iPad pointer support.

## Composition

Both layers are `strategy: wrap` at the default priority, so they stack with
`spec-minimal`, `diff-minimal`, and `library-research` in id
order. `spec-minimal`'s stripper never touches
either section.

## Test

```bash
bun presets/button-design/scripts/ts/selftest-button-design.ts
```
