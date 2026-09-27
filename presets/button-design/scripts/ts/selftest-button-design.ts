#!/usr/bin/env bun
// button-design preset: selftest-button-design.ts
// Self-contained test for check-buttons.ts. The checker is read-only, so every
// case asserts the exit code AND that spec.md was left byte-identical.
//
// Usage: bun presets/button-design/scripts/ts/selftest-button-design.ts

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = join(import.meta.dir, "check-buttons.ts");
const WORK = mkdtempSync(join(tmpdir(), "selftest-button-design-"));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));
let failures = 0;

function run(...args: string[]) {
  const p = Bun.spawnSync(["bun", CHECK, ...args], { stdout: "pipe", stderr: "pipe" });
  return { rc: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() };
}

function check(name: string, want: number, mode: "spec" | "plan", spec: string, plan = "") {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, "spec.md");
  writeFileSync(specPath, `# Feature\n\n${spec}\n`);
  writeFileSync(join(dir, "plan.md"), `# Plan\n\n${plan}\n`);
  const before = readFileSync(specPath, "utf8");
  const r = run(mode, mode === "plan" ? dir : specPath);
  if (r.rc !== want) {
    console.log(`FAIL: ${name} — want rc=${want}, got rc=${r.rc}`);
    console.log(r.out.replace(/^/gm, "    ").trimEnd());
    failures++;
  } else if (readFileSync(specPath, "utf8") !== before) {
    console.log(`FAIL: ${name} — spec.md was modified`);
    failures++;
  } else console.log(`PASS: ${name}`);
}

const HEAD = `## Actions & Buttons

| Screen | Label | Kind | Role | Safeguard |
|---|---|---|---|---|`;

const GOOD = `${HEAD}
| Export | Download Report | button | primary | — |
| Export | Cancel | button | secondary | — |
| Settings | Save Changes | button | primary | — |
| Settings | Delete Account | button | secondary | type-to-confirm |
| Settings | Privacy policy | link | — | — |

## Functional Requirements`;

const NONE = `## Actions & Buttons

None — no user-facing UI.`;

// --- spec mode
check("spec-good", 0, "spec", GOOD);
check("spec-none", 0, "spec", NONE);
check("spec-toolbar-no-primary", 0, "spec", `${HEAD}\n| Toolbar | Bold | button | tertiary | — |`);
check("spec-missing", 1, "spec", "## User Scenarios");
check("spec-no-table", 1, "spec", "## Actions & Buttons\n\nSome prose about buttons.");
check("spec-missing-column", 1, "spec", `## Actions & Buttons

| Screen | Label | Kind |
|---|---|---|
| Export | Download Report | button |`);
check("spec-two-primaries", 1, "spec", `${HEAD}
| Export | Download Report | button | primary | — |
| Export | Email Report | button | primary | — |`);
check("spec-generic-label", 1, "spec", `${HEAD}\n| Export | Submit | button | primary | — |`);
check("spec-generic-link", 1, "spec", `${HEAD}\n| Home | Click here | link | — | — |`);
check("spec-long-label", 1, "spec", `${HEAD}\n| Export | Download The Quarterly Report | button | primary | — |`);
check("spec-bare-delete", 1, "spec", `${HEAD}\n| Files | Delete | button | secondary | confirm dialog |`);
check("spec-unguarded-delete", 1, "spec", `${HEAD}\n| Files | Delete File | button | secondary | — |`);
check("spec-unguarded-cancel", 1, "spec", `${HEAD}\n| Billing | Cancel Subscription | button | primary | — |`);
check("spec-link-with-role", 1, "spec", `${HEAD}\n| Home | Pricing | link | primary | — |`);
check("spec-bad-kind", 1, "spec", `${HEAD}\n| Home | Pricing | chip | — | — |`);

// --- plan mode
const PLAN_GOOD = `## Button System

**Component:** reuse \`Button\` from \`src/ui/Button.tsx\`.
**Color roles:**
- **Primary:** brand color
- **Destructive:** danger red
**States:** default, hover, focus-visible, disabled, loading; 4.5:1 text contrast.
**Touch targets:** 44×44 minimum; 8px gaps.
**Placement:** primary at the end of the form.`;
const PLAN_NO_PLACEMENT = PLAN_GOOD.slice(0, PLAN_GOOD.lastIndexOf("**Placement:**"));

check("plan-good", 0, "plan", GOOD, PLAN_GOOD);
check("plan-spec-none", 0, "plan", NONE, "");
check("plan-spec-legacy", 0, "plan", "## User Scenarios", "");
check("plan-missing-section", 1, "plan", GOOD, "## Summary");
check("plan-missing-marker", 1, "plan", GOOD, PLAN_NO_PLACEMENT);
check("plan-empty-marker", 1, "plan", GOOD, `${PLAN_NO_PLACEMENT}**Placement:**`);
check("plan-small-target", 1, "plan", GOOD, PLAN_GOOD.replace("44×44", "32x32"));

// --- usage
if (run().rc === 2) console.log("PASS: usage-no-args");
else { console.log("FAIL: usage-no-args"); failures++; }

if (failures > 0) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("all button-design checks passed");
