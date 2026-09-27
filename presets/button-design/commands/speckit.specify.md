---
description: "Composable wrapper for /speckit-specify that requires an `## Actions & Buttons` table for every UI-touching feature: one primary per screen, buttons vs links, specific 1–3 word labels, and a safeguard on every destructive action — checked deterministically after the spec is written."
---

## Wrapper Layer

This preset wraps the stock `/speckit-specify` command. Keep the stock workflow
for branch/worktree setup, feature directory creation, template loading,
checklist generation, hooks, and reporting.

This layer makes the feature's **actions** a requirement. Which control is the
next step, what it says, and what it costs to click it wrongly are product
decisions. Left to implementation they get made by whoever writes the markup,
one screen at a time, and the result is three competing primaries and a
`Submit` on the delete dialog.

### Button Rules (MANDATORY)

Apply these to every user-facing action the feature adds or changes:

1. **Buttons do something; links go somewhere.** Submitting, starting a
   process, opening a modal → `button`. Navigating to a page or section →
   `link`. Never style or specify one as the other.
2. **One primary per screen.** Exactly one action is the next best step and
   gets visual priority. Everything else is `secondary` (outlined/neutral) or
   `tertiary` (text-weight). A modal is its own screen.
3. **Labels are 1–3 words, verb first, and say what happens next.**
   `Download Report`, not `Submit`/`OK`/`Yes`/`Confirm`/`Click here`. If a label
   would make sense on any screen of the product, it is too generic.
4. **Match the moment.** On the step that completes the task, the label names
   the completion (`Download Report`), not the flow (`Next`).
5. **Destructive actions name their consequence and carry a safeguard.**
   `Delete Account`, `Cancel My Subscription`, `Remove File Permanently` —
   never a bare `Delete`. Each one gets a confirm dialog, a type-to-confirm
   step for the unrecoverable ones, or an undo.
6. **Speak the user's language.** No internal feature names or jargon in a
   label; use the verb a user would say out loud.

### Required Section (MANDATORY)

`spec.md` MUST carry an `## Actions & Buttons` section, placed after
`## User Scenarios & Testing`. The `git` extension renders it into the tracking
issue, and `/speckit-plan` is held to it.

```markdown
## Actions & Buttons

| Screen | Label | Kind | Role | Safeguard |
|---|---|---|---|---|
| Export dialog | Download Report | button | primary | — |
| Export dialog | Cancel | button | secondary | — |
| Settings | Save Changes | button | primary | — |
| Settings | Delete Account | button | secondary | type-to-confirm |
| Delete dialog | Delete Account | button | primary | confirm dialog |
| Delete dialog | Keep Account | button | secondary | — |
| Settings | Privacy policy | link | — | — |
```

- **Kind** is `button` or `link`. **Role** is `primary`, `secondary`, or
  `tertiary` for a button, and `—` for a link.
- **Safeguard** is `—` for a non-destructive action. For a destructive one it
  names the mechanism: `confirm dialog`, `type-to-confirm`, or `undo`.
- The label is the exact copy the user will read.
- If the feature has **no user-facing UI**, write `None — no user-facing UI.`
  under the heading. Do not omit the heading: an absent section and a
  deliberate "none" must read differently.

If the `spec-ui-preview` preset is also installed, its preview must show the
same hierarchy: one filled primary per screen, secondaries outlined or neutral,
links as underlined text with no container, and destructive actions in the
danger color.

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
  yourself.** Rewrite the label, demote the extra primary, or add the
  safeguard. Then re-run. Do not report success while it fails.
- **`2`**: bad usage. Fix the call and re-run.
