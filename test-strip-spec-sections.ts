#!/usr/bin/env bun
// Check for spec-minimal's strip-spec-sections.ts (issue #58):
//   1. headings carrying the template's trailing parenthetical are stripped;
//   2. the summary line names what was removed and what was absent.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "presets/spec-minimal/scripts/ts/strip-spec-sections.ts");
const TMP = mkdtempSync(join(tmpdir(), "test-strip-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
let fail = 0;

function check(name: string, expected: string, actual: string) {
  if (expected === actual) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}`);
    console.log(`       expected: ${expected}`);
    console.log(`       actual:   ${actual}`);
    fail = 1;
  }
}
function contains(name: string, out: string, needle: string) {
  if (out.includes(needle)) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}: ${out}`); fail = 1; }
}

const spec = join(TMP, "spec.md");
const lines = () => readFileSync(spec, "utf8").split("\n");
const headings = () => lines().filter((l) => l.startsWith("#")).join("|");
function run() {
  const p = Bun.spawnSync(["bun", SCRIPT, spec]);
  return { code: p.exitCode, out: p.stdout.toString().replace(/\n+$/, "") };
}

writeFileSync(spec, `# Feature

## User Scenarios

Some prose.

### Key Entities *(include if feature involves data)*

- **Thing**: a thing

## Success Criteria *(mandatory)*

- SC-001: fast

## Requirements

- FR-001: works
`);

const r1 = run();
check("exit 0", "0", String(r1.code));
check("remaining headings", "# Feature|## User Scenarios|## Requirements", headings());
check("body kept", "- FR-001: works", lines().filter((l) => l.includes("FR-001")).join("\n"));
contains("reports what was stripped", r1.out, "stripped Key Entities / Success Criteria");
contains("reports what was absent", r1.out, "not present: Assumptions");

// idempotent: second run removes nothing
const r2 = run();
check("idempotent headings", "# Feature|## User Scenarios|## Requirements", headings());
contains("second run reports all absent", r2.out, "not present: Assumptions / Key Entities / Success Criteria");

process.exit(fail);
