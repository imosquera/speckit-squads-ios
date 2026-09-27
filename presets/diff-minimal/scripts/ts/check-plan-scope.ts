#!/usr/bin/env bun
// diff-minimal preset: check-plan-scope.ts
// Holds the plan to the contract the spec signed: reports every place plan.md /
// tasks.md / quickstart.md / research.md plans work in a path listed under
// spec.md's `MUST NOT touch:`. Reads the artifacts, not a diff (runs at plan
// time). Lines that negate, and sections about scope/non-goals/corrections, are
// ignored: restating the exclusion is the right thing to do.
//
// Usage: check-plan-scope.ts <feature-dir>
//        check-plan-scope.ts <artifact.md> [<artifact.md> ...]
// An artifact path means its dirname; each feature dir is scanned once.
// Exit:  0 no violation   1 violation (file:line on stderr)
//        2 bad usage (no arg, arg neither dir nor file, or no spec.md)

import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { S, heading, logicalLines, mustNotPaths, pathPattern, pyPath, readLines, strip } from "./scope-common.ts";

function usage() {
  console.error("usage: check-plan-scope.ts <feature-dir>");
  console.error("       check-plan-scope.ts <artifact.md> [<artifact.md> ...]");
}
const kind = (p: string) => {
  try {
    const st = statSync(p);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
  } catch {
    return null;
  }
};

const args = process.argv.slice(2);
if (!args.length) {
  console.error("error: feature directory or artifact path required");
  usage();
  process.exit(2);
}
// Dedupe on the physical path, report as the caller spelled it.
const dirs = new Map<string, string>();
for (const a of args) {
  const k = kind(a);
  if (!k) {
    console.error(`error: not a directory or file: ${a}`);
    usage();
    process.exit(2);
  }
  const dir = k === "dir" ? a : dirname(a);
  if (kind(join(dir, "spec.md")) !== "file") {
    console.error(`error: no spec.md in ${dir}`);
    process.exit(2);
  }
  let canon: string;
  try {
    canon = realpathSync(dir);
  } catch {
    console.error(`error: cannot resolve: ${a}`);
    process.exit(2);
  }
  if (!dirs.has(canon)) dirs.set(canon, dir);
}

// A line that says "don't touch X" names X on purpose.
const NEGATION = new RegExp(
  (String.raw`must\s+not|do(es)?\s+not\s+(touch|modify|edit|change)|never\s+(touch|modify|edit)` +
    String.raw`|out\s+of\s+scope|forbidden|excluded|exclude|no\s+changes?\s+to|not\s+in\s+scope` +
    String.raw`|leave\s+(it\s+)?alone|untouched`).replaceAll(String.raw`\s`, S),
  "i",
);
// Whole sections that exist to restate the exclusions.
const EXEMPT_HEADING = /scope|non-goals?|out of scope|corrections|constraints/i;

function checkDir(arg: string): number {
  const feature = pyPath(arg);
  const paths = mustNotPaths(readLines(join(arg, "spec.md")));
  if (!paths.length) {
    console.log("diff-minimal: spec forbids no paths — nothing to check.");
    return 0;
  }

  const patterns = paths.map((p) => [p, pathPattern(p)] as const);
  const violations: [name: string, n: number, listed: string, text: string][] = [];

  for (const name of ["plan.md", "tasks.md", "quickstart.md", "research.md"]) {
    const path = join(arg, name);
    if (!existsSync(path) || !statSync(path).isFile()) continue;

    let exemptUntil: number | null = null; // heading level we are exempt beneath
    // Fold wrapped continuations before matching: these artifacts are prose, and
    // a restatement that wraps ("this file MUST NOT be / touched") lost its
    // negation on the physical line carrying the path and was reported as a
    // violation (issue #68). Headings still arrive as their own entries, so the
    // exempt-heading state machine below is unchanged.
    for (const [n, line] of logicalLines(readLines(path))) {
      const h = heading(line);
      if (h) {
        const [level, title] = h;
        if (exemptUntil !== null && level <= exemptUntil) exemptUntil = null;
        if (EXEMPT_HEADING.test(title)) exemptUntil = level;
        continue;
      }
      if (exemptUntil !== null) continue;
      if (NEGATION.test(line)) continue;
      for (const [listed, pat] of patterns) {
        if (pat.test(line)) {
          // A folded block can be a whole paragraph; keep the report readable.
          let text = strip(line);
          const cps = Array.from(text);
          if (cps.length > 200) text = cps.slice(0, 197).join("") + "...";
          violations.push([name, n, listed, text]);
          break;
        }
      }
    }
  }

  if (violations.length) {
    console.error("error: plan artifacts touch paths the spec put out of scope");
    for (const [name, n, listed, text] of violations) {
      console.error(`  ${feature}/${name}:${n}: forbidden by \`${listed}\``);
      console.error(`      ${text}`);
    }
    console.error(
      "\nEither remove the work from the plan, or — if the path is genuinely required —\n" +
        "amend `## Scope discipline` in spec.md and say so on the tracking issue.\n" +
        "Never widen the plan quietly.",
    );
    return 1;
  }

  console.log(`diff-minimal: plan artifacts respect all ${paths.length} out-of-scope path(s).`);
  return 0;
}

// Last non-zero status wins, as the per-dir bash loop did.
let status = 0;
for (const dir of dirs.values()) {
  let rc: number;
  try {
    rc = checkDir(dir);
  } catch (e) {
    console.error(e);
    rc = 1;
  }
  if (rc !== 0) status = rc;
}
process.exit(status);
