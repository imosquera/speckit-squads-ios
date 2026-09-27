---
description: "Composable wrapper for /speckit-plan that, when the spec declares user-facing actions, requires a `## Button System` section in plan.md — component reuse, color roles, states and contrast, touch targets, and placement — checked deterministically after the plan is written."
---

## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper the
core flow expands to, e.g. from another chained `speckit.plan` preset).

The spec decided **which** actions exist and what they say
(`## Actions & Buttons`). This layer decides **how they are built** so they look
and behave the same as every other button in the product.

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
- Otherwise `plan.md` MUST carry a `## Button System` section with these five
  markers, each populated:

```markdown
## Button System

**Component:** reuse `Button` from `src/ui/Button.tsx` (variants primary,
secondary, tertiary, destructive). No new button style.
**Color roles:** primary = brand color; secondary = outlined neutral;
destructive = danger red; disabled = muted fill and text, not just lowered
opacity. The same color means the same role on every screen.
**States:** default, hover, focus-visible, active, disabled, loading. Every
state keeps label text ≥ 4.5:1 against its fill and the button ≥ 3:1 against
its container.
**Touch targets:** 44×44 minimum hit area, icon-only buttons included; ≥ 8px
between adjacent targets.
**Placement:** the primary sits where the task ends: bottom of the form,
trailing edge of a button pair, in the platform's dialog order. Actions sit
next to what they act on, never floating in a corner. A sticky mobile CTA never
covers content.
```

Rules behind the markers:

- **Reuse before you add.** Name the existing button component and the variant
  each spec row maps to. A new variant or one-off style needs a stated reason in
  `plan.md`. "This page is different" is not a reason.
- **Consistency across screens.** Shape, radius, font size, weight,
  capitalization, and padding match the existing system. A primary in a modal
  looks like a primary on the dashboard.
- **Links stay links.** Spec rows of kind `link` render as text links (underline
  or link style, no container), never button-shaped.
- **Destructive safeguards are designed here.** For every spec row with a
  safeguard, the plan names the confirm dialog, type-to-confirm field, or undo
  affordance and where it lives.

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
- **`1`**: stderr names the missing section, the empty marker, or a touch
  target under 44×44. Fix `plan.md` and re-run. Do not report success while it
  fails.
- **`2`**: bad usage, or no `plan.md` in the feature directory. Fix the call
  and re-run.
