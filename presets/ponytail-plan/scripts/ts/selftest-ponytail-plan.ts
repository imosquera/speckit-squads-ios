#!/usr/bin/env bun
// ponytail-plan preset: selftest-ponytail-plan.ts
// Self-contained test for check-ladder.ts. The checker is read-only, so every
// case asserts the exit code AND that plan.md was left byte-identical.
//
// Usage: bun presets/ponytail-plan/scripts/ts/selftest-ponytail-plan.ts

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = join(import.meta.dir, "check-ladder.ts");
const WORK = mkdtempSync(join(tmpdir(), "selftest-ponytail-plan-"));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));
let failures = 0;

function run(...args: string[]) {
  const p = Bun.spawnSync(["bun", CHECK, ...args], { stdout: "pipe", stderr: "pipe" });
  return { rc: p.exitCode ?? -1, err: p.stderr.toString().replace(/\n+$/, "") };
}
const fail = (msg: string) => { console.log(`FAIL: ${msg}`); failures++; };

function case_(name: string, want: number, needle: string, body: string) {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  const plan = join(dir, "plan.md");
  writeFileSync(plan, body);
  const r = run(plan);
  if (r.rc !== want) return fail(`${name} — expected rc=${want}, got rc=${r.rc} (stderr: ${r.err})`);
  if (needle && !r.err.includes(needle)) return fail(`${name} — stderr missing '${needle}' (stderr: ${r.err})`);
  if (readFileSync(plan, "utf8") !== body) return fail(`${name} — plan.md was modified`);
  console.log(`PASS: ${name}`);
}

const HEAD = `# Implementation Plan: thing

## Summary

Add a thing.
`;
const TABLE = `| Item | Kind | Rung | Reason |
|------|------|------|--------|`;

case_("pass-table", 0, "", `${HEAD}
## Ladder

${TABLE}
| \`src/cache.ts\` | file | 1 | cut: no measured latency problem |
| RetryPolicy | abstraction | 2 | reuse \`withBackoff()\` |
| \`zod\` | dependency | 5 | already installed |
| \`p-queue\` | dependency | 7 | concurrency cap |

**Dependency justification:** \`p-queue\` — nothing in rungs 2-6 caps
concurrency across workers.

## Project Structure

- src/
`);

case_("pass-wrapped-justification", 0, "", `${HEAD}
## Ladder

| Item | Kind | Rung | Reason |
|---|---|---|---|
| \`p-queue\` | dependency | **7** | concurrency cap |

**Dependency justification:**
\`p-queue\` — no installed dependency caps concurrency.
`);

case_("none-line", 0, "", `${HEAD}
## Ladder

None — extends existing code only.
`);

case_("missing-section", 1, "missing `## Ladder` section", `${HEAD}
## Project Structure

- src/
`);

case_("section-only-in-fence", 1, "missing `## Ladder` section", `${HEAD}
\`\`\`markdown
## Ladder

None — extends existing code only.
\`\`\`
`);

case_("empty-section", 1, "no table rows", `${HEAD}
## Ladder

Nothing to say.

## Next
`);

case_("bad-rung", 1, "Rung must be a single integer 1-7", `${HEAD}
## Ladder

${TABLE}
| \`src/a.ts\` | file | 8 | too high |
`);

case_("bad-rung-range", 1, "plan.md:11: Rung", `${HEAD}
## Ladder

${TABLE}
| \`src/a.ts\` | file | 2-3 | ambiguous |
`);

case_("bad-kind", 1, "Kind must be", `${HEAD}
## Ladder

${TABLE}
| \`src/a.ts\` | module | 7 | new |
`);

case_("dependency-without-justification", 1, "without a populated", `${HEAD}
## Ladder

${TABLE}
| \`p-queue\` | dependency | 7 | concurrency cap |
`);

case_("dependency-placeholder-justification", 1, "without a populated", `${HEAD}
## Ladder

${TABLE}
| \`p-queue\` | dependency | 7 | concurrency cap |

**Dependency justification:** <why rungs 2-6 fail>
`);

case_("justification-outside-section", 1, "without a populated", `${HEAD}
## Ladder

${TABLE}
| \`p-queue\` | dependency | 7 | concurrency cap |

## Elsewhere

**Dependency justification:** \`p-queue\` — stated in the wrong section.
`);

// Usage errors.
for (const [name, want, args] of [
  ["no-args", 2, []],
  ["missing-file", 2, [join(WORK, "does-not-exist.md")]],
  ["feature-dir-arg", 0, [join(WORK, "none-line")]],
] as const) {
  const { rc } = run(...args);
  if (rc === want) console.log(`PASS: ${name}`);
  else fail(`${name} — rc=${rc}`);
}

console.log();
if (failures === 0) {
  console.log("all ponytail-plan selftests passed");
  process.exit(0);
}
console.log(`${failures} ponytail-plan selftest(s) failed`);
process.exit(1);
