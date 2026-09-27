---
description: "Composable wrapper for /speckit-plan that, when the spec declares user-facing actions, requires a `## Button System` section in plan.md in SwiftUI / Apple HIG terms — ButtonStyle reuse, styles and tint, pressed/disabled states and haptics, 44×44pt hit targets, Dynamic Type and accessibility labels, and toolbar/bottom-bar placement — checked deterministically after the plan is written."
---

## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper the
core flow expands to, e.g. from another chained `speckit.plan` preset).

The spec decided **which** actions exist and what they say
(`## Actions & Buttons`). This layer decides **how they are built in SwiftUI**
so they look and behave the same as every other button in the app. There is no
hover on iPhone and no CSS: states come from the button style's
configuration and the environment.

### Button System (MANDATORY)

Read `## Actions & Buttons` in `spec.md` first.

- If it says `None.`, add nothing and say so in your report.
- If the spec has no such section (it was written without this preset's
  `speckit.specify` layer), ask Jev whether it touches UI:

  ```bash
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
  bun "$PROJECT_DIR/.specify/presets/button-design/scripts/ts/jev.ts" applies-ui --spec "$SPECIFY_FEATURE_DIRECTORY/spec.md"
  ```

  Exit 0 with `decision: "applies"` → write `## Button System` below from the
  spec's screens. Exit 0 with `"skip"`, exit 3, or any other exit → add nothing
  and say so. Either way the check passes; quote the `record` line in your
  report.
- Otherwise `plan.md` MUST carry a `## Button System` section with these six
  markers, each populated:

```markdown
## Button System

**Component:** reuse the app's button styles in
`Sources/DesignSystem/ButtonStyles.swift` (system `.borderedProminent`,
`.bordered`, `.borderless`, plus `PillButtonStyle`). No new `ButtonStyle`.
UIKit screens use `UIButton.Configuration` (`.filled()`, `.tinted()`,
`.plain()`) with the same mapping.
**Styles & tint:** primary = `.borderedProminent` with the app's `.tint`
(accent color asset); secondary = `.bordered`; tertiary = `.borderless`;
destructive = `role: .destructive` (system red, never a hard-coded red).
Semantic colors only (`Color.accentColor`, `.primary`, `.secondary`), so
light, dark, and Increase Contrast all work. The same style means the same role
on every screen.
**States & feedback:** default, pressed (`configuration.isPressed`, dim or
scale), disabled (`.disabled(_:)`; the system dims it, don't hand-roll
opacity), loading (`ProgressView` in place of the label, button disabled).
No pointer-only states. Label text ≥ 4.5:1 against its fill in every state.
`.sensoryFeedback(.success, trigger:)` on completing save; `.warning` before
a destructive confirm; none on ordinary taps.
**Hit targets:** 44×44pt minimum, icon-only buttons included, via
`.frame(minWidth: 44, minHeight: 44)` plus `.contentShape(Rectangle())` when
the visible glyph is smaller; ≥ 8pt between adjacent targets.
**Accessibility:** labels use text styles (`.body`, `.headline`) and scale
with Dynamic Type through AX5; no fixed heights that clip, and a horizontal
button pair stacks vertically at accessibility sizes (`ViewThatFits`).
Icon-only buttons get `.accessibilityLabel`; `Label("Share", systemImage:)`
over a bare `Image`.
**Placement:** `Save` in `.confirmationAction`, `Cancel` in
`.cancellationAction`, the screen's main command in `.primaryAction`. A
full-width primary sits in `.safeAreaInset(edge: .bottom)` within thumb reach
and never covers content. Destructive confirms use `confirmationDialog` with a
`role: .cancel` button; row deletes are swipe actions with undo.
```

Rules behind the markers:

- **Reuse before you add.** Name the existing `ButtonStyle` (or system style)
  and the style each spec row maps to. A new style or one-off modifier stack
  needs a stated reason in `plan.md`. "This screen is different" is not a
  reason.
- **Consistency across screens.** Shape (`.buttonBorderShape`), control size
  (`.controlSize`), font, and padding match the existing system. A primary in
  a sheet looks like a primary on the home screen.
- **Links stay links.** Spec rows of control `NavigationLink` render as list
  rows with a disclosure indicator or plain tinted text; `Link` rows open
  Safari or the target app. Neither is dressed as the screen's primary button.
- **Destructive safeguards are designed here.** For every spec row with a
  safeguard, the plan names the `confirmationDialog`/`alert`, type-to-confirm
  field, or undo affordance (e.g. an undo toast or `UndoManager`) and where it
  lives.
- **Hover is not a state on iPhone.** Mention it only for iPad pointer support
  (`.hoverEffect`); the checker notes it but does not fail.

### Core Flow

{CORE_TEMPLATE}

### Post-Flight Check (MANDATORY — LAST STEP)

After the entire core flow above has completed, and before reporting success:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
bun "$PROJECT_DIR/.specify/presets/button-design/scripts/ts/check-buttons.ts" plan "$SPECIFY_FEATURE_DIRECTORY"
```

The check is read-only. Handle the exit code:

- **`0`**: the plan carries a populated `## Button System`, or the spec
  declares no actions. Report success.
- **`1`**: stderr names the missing section, the empty marker, a hit
  target under 44×44pt, or an Accessibility marker that never mentions
  Dynamic Type. Fix `plan.md` and re-run. Do not report success while it
  fails.
- **`2`**: bad usage, or no `plan.md` in the feature directory. Fix the call
  and re-run.
