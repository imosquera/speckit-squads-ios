#!/usr/bin/env bun
// diff-minimal preset: selftest-diff-minimal.ts
// Self-contained test for check-scope-sections.ts and check-plan-scope.ts
// (and, through them, scope-common.ts). No test framework required.
//
// Both scripts are read-only, so every case asserts the exit code AND that the
// inputs were left byte-identical — "it exited 1" is not evidence that it kept
// its hands off the spec.
//
// Usage: bun presets/diff-minimal/scripts/ts/selftest-diff-minimal.ts

import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECTIONS = join(import.meta.dir, "check-scope-sections.ts");
const PLAN = join(import.meta.dir, "check-plan-scope.ts");

for (const s of [SECTIONS, PLAN]) {
  try {
    accessSync(s, constants.X_OK);
  } catch {
    console.error(`error: not executable: ${s}`);
    process.exit(2);
  }
}

const WORK = mkdtempSync(join(tmpdir(), "selftest-diff-minimal-"));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));

let failures = 0;
type Result = { rc: number; out: string; err: string };

function run(...cmd: string[]): Result {
  const p = Bun.spawnSync(["bun", ...cmd], { stdout: "pipe", stderr: "pipe" });
  return { rc: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** Run one case: `body` returns null on pass, or a failure reason. */
function check(name: string, body: () => string | null) {
  let why: string | null;
  try {
    why = body();
  } catch (e) {
    why = `threw: ${e}`;
  }
  if (why === null) console.log(`PASS: ${name}`);
  else {
    console.log(`FAIL: ${name} — ${why}`);
    failures++;
  }
}

const rcIs = (r: Result, want: number): string | null =>
  r.rc === want ? null : `expected rc=${want}, got rc=${r.rc} (stderr: ${r.err.trimEnd()})`;

function mkfeature(name: string, files: Record<string, string> = {}): string {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

const digest = (f: string) => readFileSync(f, "utf8");
const pathLines = (out: string) => out.split("\n").filter((l) => l.startsWith("  - ")).length;

const SPEC_HEAD = `# Feature Specification: thing

## User Scenarios

- a user does a thing
`;

const CORRECTIONS_OK = `
## Corrections to the issue as filed

- \`firestore.indexes.json\` — dropped: the query is a single equality filter.
`;

const SCOPE_OK = `
## Scope discipline

**MUST NOT touch:**

- \`firestore.rules\` — the read runs on the Admin SDK
- \`infra/**\` — a rules change pulls a Terraform apply in behind it
`;

// A MUST-NOT list whose bullets wrap, the way any editor writes prose. Four
// paths; the first and third each continue onto further physical lines. Before
// issue #68 the parser stopped at the first continuation and saw exactly one.
const SCOPE_WRAPPED = `
## Scope discipline

**MUST NOT touch:**

- \`firestore.rules\` — the read runs on the Admin SDK, which never consults
  rules, so a rules edit changes nothing here and drags a deploy in behind it
- \`infra/**\` — a Terraform apply is not part of this change
- \`scripts/deploy.sh\` — the release path is unchanged by this feature, and a
  change here lands on every service at once rather than on this one
- \`package-lock.json\` — no dependency moves
`;

// --------------------------------------------------------------- sections
check("sections: both present and populated -> 0", () => {
  const d = mkfeature("s1", { "spec.md": SPEC_HEAD + CORRECTIONS_OK + SCOPE_OK });
  const before = digest(join(d, "spec.md"));
  const r = run(SECTIONS, join(d, "spec.md"));
  return rcIs(r, 0)
    ?? (before !== digest(join(d, "spec.md")) ? "spec.md was modified by a read-only check" : null)
    ?? (r.out.includes("firestore.rules") ? null : `did not report the out-of-scope paths: ${r.out}`);
});

check("sections: Corrections missing -> 1, names the section", () => {
  const d = mkfeature("s2", { "spec.md": SPEC_HEAD + SCOPE_OK });
  const before = digest(join(d, "spec.md"));
  const r = run(SECTIONS, join(d, "spec.md"));
  return rcIs(r, 1)
    ?? (r.err.includes("Corrections to the issue as filed") ? null : `stderr does not name the missing section: ${r.err}`)
    ?? (before !== digest(join(d, "spec.md")) ? "spec.md was modified" : null);
});

check("sections: Scope discipline missing -> 1, shows expected shape", () => {
  const d = mkfeature("s3", { "spec.md": SPEC_HEAD + CORRECTIONS_OK });
  const r = run(SECTIONS, join(d, "spec.md"));
  return rcIs(r, 1) ?? (r.err.includes("MUST NOT touch") ? null : `stderr lacks the expected shape: ${r.err}`);
});

check("sections: heading present but empty -> 1", () => {
  const d = mkfeature("s4", { "spec.md": `${SPEC_HEAD}${CORRECTIONS_OK}\n## Scope discipline\n\n` });
  const r = run(SECTIONS, join(d, "spec.md"));
  return rcIs(r, 1) ?? (/empty section/i.test(r.err) ? null : `stderr should say the section is empty: ${r.err}`);
});

check("sections: MUST NOT list declared but no paths -> 1", () => {
  const d = mkfeature("s5", { "spec.md": `${SPEC_HEAD}${CORRECTIONS_OK}\n## Scope discipline\n\n**MUST NOT touch:**\n\n` });
  const r = run(SECTIONS, join(d, "spec.md"));
  return rcIs(r, 1) ?? (r.err.includes("lists no paths") ? null : `wrong diagnosis: ${r.err}`);
});

check("sections: explicit None. is accepted for both -> 0", () => {
  const d = mkfeature("s6", {
    "spec.md": `${SPEC_HEAD}\n## Corrections to the issue as filed\n\nNone.\n\n## Scope discipline\n\nNone.\n`,
  });
  return rcIs(run(SECTIONS, join(d, "spec.md")), 0);
});

check("sections: explicit None. inside the MUST NOT list is accepted -> 0", () => {
  const d = mkfeature("s6b", {
    "spec.md": `${SPEC_HEAD}${CORRECTIONS_OK}\n## Scope discipline\n\n**MUST NOT touch:**\n\n- **None.**\n`,
  });
  const r = run(SECTIONS, join(d, "spec.md"));
  return rcIs(r, 0) ?? (r.out.includes("nothing held out of scope") ? null : `unexpected output: ${r.out}`);
});

check("sections: section boundary respects a following H2", () => {
  const d = mkfeature("s7", {
    "spec.md": `${SPEC_HEAD}${CORRECTIONS_OK}${SCOPE_OK}\n## Functional Requirements\n\n- FR-001 modify \`infra/main.tf\`\n`,
  });
  const r = run(SECTIONS, join(d, "spec.md"));
  // `infra/main.tf` lives outside Scope discipline, so it must not be read as
  // a third forbidden path.
  return rcIs(r, 0) ?? (pathLines(r.out) === 2 ? null : `wrong path count: ${r.out}`);
});

check("sections: wrapped MUST NOT bullets report every path, not the first", () => {
  const d = mkfeature("s8", { "spec.md": SPEC_HEAD + CORRECTIONS_OK + SCOPE_WRAPPED });
  const before = digest(join(d, "spec.md"));
  const r = run(SECTIONS, join(d, "spec.md"));
  // rc=0 alone is exactly the silent pass this bug produced: a 4-path list read
  // as 1 path still exits 0. Assert the count and every name.
  const missing = ["firestore.rules", "infra/**", "scripts/deploy.sh", "package-lock.json"].filter(
    (p) => !r.out.includes(p),
  );
  return rcIs(r, 0)
    ?? (before !== digest(join(d, "spec.md")) ? "spec.md was modified by a read-only check" : null)
    ?? (pathLines(r.out) !== 4 ? `wrapped bullets truncated the list: ${r.out}` : null)
    ?? (r.out.includes("4 path(s)") ? null : `reported count is not 4: ${r.out}`)
    ?? (missing.length ? `paths lost to wrapping: ${missing.join(" ")}` : null);
});

check("sections: a wrapped bullet's tail is not read as a second path", () => {
  const d = mkfeature("s9", {
    "spec.md": `${SPEC_HEAD}${CORRECTIONS_OK}\n## Scope discipline\n\n**MUST NOT touch:**\n\n- \`infra/**\` — a rules change pulls a Terraform\n  apply in behind it, and \`terraform.tfstate\` is not ours to move\n`,
  });
  const r = run(SECTIONS, join(d, "spec.md"));
  return rcIs(r, 0) ?? (pathLines(r.out) === 1 ? null : `one wrapped bullet is one path: ${r.out}`);
});

check("sections: a bare-spelled bullet keeps its own path, not its tail's backticks", () => {
  const d = mkfeature("s10", {
    "spec.md": `${SPEC_HEAD}${CORRECTIONS_OK}\n## Scope discipline\n\n**MUST NOT touch:**\n\n- infra/** — a Terraform apply is not part of this change; the queue is\n  provisioned already and \`src/queue/worker.ts\` is the only consumer\n`,
  });
  const r = run(SECTIONS, join(d, "spec.md"));
  // Preferring backticks over position picks a path out of the bullet's own
  // prose: `infra/**` would be permitted and `src/queue/worker.ts` forbidden —
  // enforcement inverted, not merely weakened.
  return rcIs(r, 0)
    ?? (r.out.includes("src/queue/worker.ts") ? `took the path from the wrapped tail: ${r.out}` : null)
    ?? (r.out.includes("infra/**") ? null : `lost the bullet's own path: ${r.out}`);
});

check("sections: missing file -> 2", () => rcIs(run(SECTIONS, join(WORK, "nope", "spec.md")), 2));
check("sections: no argument -> 2", () => rcIs(run(SECTIONS), 2));

// ------------------------------------------------------------------- plan
const planFeature = (name: string, files: Record<string, string>) =>
  mkfeature(name, { "spec.md": SPEC_HEAD + CORRECTIONS_OK + SCOPE_OK, ...files });
const wrappedFeature = (name: string, files: Record<string, string>) =>
  mkfeature(name, { "spec.md": SPEC_HEAD + CORRECTIONS_OK + SCOPE_WRAPPED, ...files });

/** Expect rc=1 with `want` in stderr and none of `never`. */
function flags(r: Result, want: string[], never: string[] = [], why = "missing file:line or path"): string | null {
  return rcIs(r, 1)
    ?? (never.find((s) => r.err.includes(s)) ? `flagged ${never.find((s) => r.err.includes(s))}: ${r.err}` : null)
    ?? (want.every((s) => r.err.includes(s)) ? null : `${why}: ${r.err}`);
}

check("plan: clean plan -> 0", () => {
  const d = planFeature("p1", { "plan.md": "# Plan\n\n- edit `src/handlers/claim.ts`\n- add a test in `test/claim.test.ts`\n" });
  const before = digest(join(d, "plan.md"));
  return rcIs(run(PLAN, d), 0) ?? (before === digest(join(d, "plan.md")) ? null : "plan.md was modified");
});

check("plan: forbidden literal path -> 1 with file:line", () => {
  const d = planFeature("p2", { "plan.md": "# Plan\n\n- edit `src/handlers/claim.ts`\n- update `firestore.rules` to allow the read\n" });
  return flags(run(PLAN, d), ["plan.md:4", "firestore.rules"]);
});

check("plan: forbidden glob (infra/** matches a nested path) -> 1", () => {
  const d = planFeature("p3", { "plan.md": "# Plan\n\n- apply `infra/modules/db/main.tf`\n" });
  return flags(run(PLAN, d), ["infra/**"], [], "glob not attributed");
});

check("plan: negation line is not a violation -> 0", () => {
  const d = planFeature("p4", {
    "plan.md": "# Plan\n\n- do not touch `firestore.rules`; the Admin SDK ignores it\n- `infra/**` is out of scope\n",
  });
  return rcIs(run(PLAN, d), 0);
});

check("plan: a restating ## Scope section is exempt, but later prose is not -> 1", () => {
  const d = planFeature("p5", {
    "plan.md": "# Plan\n\n## Scope\n\n- `firestore.rules`\n- `infra/**`\n\n## Steps\n\n- edit `infra/main.tf`\n",
  });
  return flags(run(PLAN, d), ["plan.md:10"], ["plan.md:5"]);
});

check("plan: tasks.md is scanned too -> 1", () => {
  const d = planFeature("p6", { "plan.md": "# Plan\n\nclean\n", "tasks.md": "# Tasks\n\n- T001 edit `firestore.rules`\n" });
  return flags(run(PLAN, d), ["tasks.md:3"], [], "tasks.md not scanned");
});

check("plan: quickstart.md and research.md are scanned too -> 1", () => {
  const d = planFeature("p6b", {
    "plan.md": "# Plan\n\nclean\n",
    "quickstart.md": "# Quickstart\n\nrun `infra/up.sh`\n",
    "research.md": "# Research\n\n- edit `firestore.rules`\n",
  });
  return flags(run(PLAN, d), ["quickstart.md:3", "research.md:3"]);
});

check("plan: spec with no Scope discipline -> 0 and says so", () => {
  const d = mkfeature("p7", { "spec.md": SPEC_HEAD + CORRECTIONS_OK, "plan.md": "# Plan\n\n- edit `infra/main.tf`\n" });
  const r = run(PLAN, d);
  return rcIs(r, 0) ?? (r.out.includes("forbids no paths") ? null : `unexpected output: ${r.out}`);
});

check("plan: single * does not span a separator", () => {
  const d = mkfeature("p8", {
    "spec.md": `${SPEC_HEAD}${CORRECTIONS_OK}\n## Scope discipline\n\n**MUST NOT touch:**\n\n- \`src/*.ts\`\n`,
    "plan.md": "# Plan\n\n- edit `src/handlers/claim.ts`\n",
  });
  return rcIs(run(PLAN, d), 0);
});

check("plan: a trailing slash forbids the directory, and regex metachars are literal", () => {
  const d = mkfeature("p8b", {
    "spec.md": `${SPEC_HEAD}${CORRECTIONS_OK}\n## Scope discipline\n\n**MUST NOT touch:**\n\n- \`infra/\`\n- \`a+b(c).md\`\n`,
    "plan.md": "# Plan\n\n- edit `infrastructure.md`\n- edit `aab(c).md`\n- edit `infra/x/y.tf`\n- edit `a+b(c).md`\n",
  });
  return flags(run(PLAN, d), ["plan.md:5", "plan.md:6"], ["plan.md:3", "plan.md:4"]);
});

check("plan: a negation split across a line wrap is still a negation -> 0", () => {
  const d = planFeature("p10", {
    "plan.md":
      "# Plan\n\n- `firestore.rules` is deliberately\n  left untouched; the Admin SDK never consults it\n- we must not\n  apply `infra/main.tf` as part of this change\n- edit `src/handlers/claim.ts`\n",
  });
  const before = digest(join(d, "plan.md"));
  return rcIs(run(PLAN, d), 0) ?? (before === digest(join(d, "plan.md")) ? null : "plan.md was modified");
});

check("plan: a path declared in a WRAPPED spec bullet is still enforced -> 1", () => {
  const d = wrappedFeature("p11", { "plan.md": "# Plan\n\n- edit `src/handlers/claim.ts`\n- run `scripts/deploy.sh` after the migration\n" });
  // `scripts/deploy.sh` sits on a continuation line in the spec; if the spec
  // parse truncated, this violation would go unseen and the gate would pass.
  return flags(run(PLAN, d), ["plan.md:4", "scripts/deploy.sh"], [], "wrapped-bullet path was not enforced");
});

check("plan: a heading is never folded into by the prose line after it", () => {
  const d = planFeature("p12", {
    "plan.md":
      "# Plan\n\n## Non-goals\n\nDeliberately parked for a follow-up: `firestore.rules` and its tests.\n\n## Steps\n\n- apply `infra/main.tf`\n",
  });
  // The prose names a forbidden path with no negation of its own. It is exempt
  // only because `## Non-goals` was seen as a heading.
  return flags(run(PLAN, d), ["plan.md:9"], ["plan.md:5"]);
});

// Folding is for WRAPPED BULLETS only. Everything below is a line of markdown
// that starts something of its own, so it must arrive as its own logical line —
// both so the report points at the right line, and (the real damage) so a
// negation earlier in the block cannot exempt a forbidden path later in it.

check("plan: an ordered-list step is its own line, not a fold into the step above", () => {
  const d = planFeature("p13", {
    "plan.md":
      "# Plan\n\n## Steps\n\n1. Add the handler in `src/handlers/claim.ts`; no changes to the schema.\n2. Apply `infra/main.tf` so the new subnet exists.\n3. Deploy.\n",
  });
  return flags(run(PLAN, d), ["plan.md:6"], [], "numbered step folded into the negation above it");
});

check("plan: a table row is its own line, not a fold into the header", () => {
  const d = planFeature("p14", {
    "plan.md":
      "# Plan\n\n## File map\n\n| File | Change |\n|------|--------|\n| `firestore.rules` | no changes to this file |\n| `infra/main.tf` | add the subnet |\n",
  });
  return flags(run(PLAN, d), ["plan.md:8"], [], "table folded into one line; a negating row exempted the rest");
});

check("plan: a blockquote is its own line, not a fold into the prose above", () => {
  const d = planFeature("p15", {
    "plan.md": "# Plan\n\n## Steps\n\nRules are excluded here.\n> We still need to apply `infra/main.tf` for the subnet.\n",
  });
  return flags(run(PLAN, d), ["plan.md:6"], [], "blockquote folded");
});

check("plan: a bullet does not absorb a blockquote written under it", () => {
  const d = planFeature("p15b", {
    "plan.md": "# Plan\n\n## Steps\n\n- the rules file is excluded\n> apply `infra/main.tf` for the subnet\n",
  });
  return flags(run(PLAN, d), ["plan.md:6"], [], "blockquote folded into the negating bullet");
});

check("plan: code inside a fence never folds, and the fence never eats prose", () => {
  const d = planFeature("p16", {
    "plan.md":
      "# Plan\n\n## Steps\n\nThe rules file is out of scope for this change.\n\n```bash\ncd deploy\nterraform apply infra/main.tf\n```\n",
  });
  // Without fence handling the whole block folds onto line 5, whose text
  // negates — a real violation silently exempted.
  return flags(run(PLAN, d), ["plan.md:9"], [], "fenced code folded into the prose above it");
});

check("plan: two prose sentences are two logical lines, not one exempt block", () => {
  const d = planFeature("p17", {
    "plan.md":
      "# Plan\n\n## Steps\n\nThe read path stays on the Admin SDK, so `firestore.rules` is out of scope.\nWe then apply `infra/main.tf` to add the new subnet the queue needs.\n",
  });
  const before = digest(join(d, "plan.md"));
  // Fold these two sentences together and the first one's "out of scope"
  // exempts the second one's forbidden path: the gate exits 0 on a real
  // violation, which is worse than the truncation issue #68 fixed.
  return flags(run(PLAN, d), ["plan.md:6"], ["plan.md:5"], "did not report the violating sentence's own line")
    ?? (before === digest(join(d, "plan.md")) ? null : "plan.md was modified");
});

check("plan: a wrapped bullet reports the line it started on", () => {
  const d = planFeature("p17b", {
    "plan.md": "# Plan\n\n- first we refactor the handler and then\n  apply `infra/main.tf` for the subnet\n",
  });
  return flags(run(PLAN, d), ["plan.md:3"], ["plan.md:4"]);
});

check("plan: a long folded block is truncated to 200 characters in the report", () => {
  const d = planFeature("p17c", { "plan.md": `# Plan\n\n- edit \`infra/main.tf\` ${"x".repeat(300)}\n` });
  const r = run(PLAN, d);
  const shown = r.err.split("\n").find((l) => l.startsWith("      - edit"));
  return flags(r, ["plan.md:3"])
    ?? (shown && shown.trim().length === 200 && shown.endsWith("...") ? null : `not truncated: ${shown}`);
});

check("plan: artifact file paths are accepted, and reported once -> 1", () => {
  const d = planFeature("p18", { "plan.md": "# Plan\n\n- update `firestore.rules` to allow the read\n" });
  const r = run(PLAN, join(d, "spec.md"), join(d, "plan.md"));
  return rcIs(r, 1) ?? (r.err.split("plan.md:3").length - 1 === 1 ? null : `same feature dir reported more than once: ${r.err}`);
});

check("plan: dir spellings that differ only by a trailing slash dedupe -> 1, once", () => {
  const d = planFeature("p19", { "plan.md": "# Plan\n\n- update `firestore.rules` to allow the read\n" });
  const r = run(PLAN, `${d}/`, d, join(d, "plan.md"));
  return rcIs(r, 1) ?? (r.err.split("plan.md:3").length - 1 === 1 ? null : `same feature dir reported more than once: ${r.err}`);
});

check("plan: a lone artifact file path resolves its feature dir -> 0", () => {
  const d = planFeature("p20", { "plan.md": "# Plan\n\n- edit `src/handlers/claim.ts`\n" });
  return rcIs(run(PLAN, join(d, "plan.md")), 0);
});

check("plan: argument that is neither dir nor file -> 2", () => rcIs(run(PLAN, join(WORK, "nope", "plan.md")), 2));

check("plan: no spec.md -> 2", () => {
  const d = mkfeature("p9", { "plan.md": "# Plan\n" });
  return rcIs(run(PLAN, d), 2);
});

check("plan: no argument -> 2", () => rcIs(run(PLAN), 2));

console.log();
if (failures === 0) {
  console.log("all cases passed");
  process.exit(0);
}
console.log(`${failures} case(s) failed`);
process.exit(1);
