#!/usr/bin/env bun
// diff-minimal preset: check-scope-sections.ts
// Asserts spec.md carries the two sections the minimum-diff mandate adds, and
// that they say something: `## Corrections to the issue as filed` (non-empty or
// "None.") and `## Scope discipline` (a `MUST NOT touch:` list or "None.").
// Read-only.
//
// Usage: check-scope-sections.ts <spec.md>
// Exit:  0 both populated   1 a section missing or empty   2 bad usage

import { existsSync, statSync } from "node:fs";
import {
  CORRECTIONS_TITLE,
  MUST_NOT_MARKER,
  NONE_ANSWER,
  SCOPE_TITLE,
  hasContent,
  mustNotPaths,
  pyPath,
  readLines,
  section,
  strip,
} from "./scope-common.ts";

const arg = process.argv[2] ?? "";
if (!arg) {
  console.error("error: spec.md path required");
  console.error("usage: check-scope-sections.ts <spec.md>");
  process.exit(2);
}
if (!existsSync(arg) || !statSync(arg).isFile()) {
  console.error(`error: not a file: ${arg}`);
  process.exit(2);
}
const spec = pyPath(arg);
const lines = readLines(arg);
const problems: string[] = [];

const corrections = section(lines, CORRECTIONS_TITLE);
if (corrections === null) {
  problems.push(
    "missing section: `## Corrections to the issue as filed`\n" +
      "  Every file and precondition the issue asserts is a hypothesis. Record\n" +
      "  which ones you re-derived against main and dropped, and why — or write\n" +
      "  `None.` if the issue was right in every particular.",
  );
} else if (!hasContent(corrections)) {
  problems.push(
    "empty section: `## Corrections to the issue as filed`\n" +
      "  Write the corrections, or `None.` if there were none.",
  );
}

const scope = section(lines, SCOPE_TITLE);
if (scope === null) {
  problems.push(
    "missing section: `## Scope discipline`\n" +
      "  This section is the contract /speckit-plan and the review passes are\n" +
      "  held to. Expected shape:\n" +
      "\n" +
      "    ## Scope discipline\n" +
      "\n" +
      "    **MUST NOT touch:**\n" +
      "\n" +
      "    - `infra/**` — no Terraform apply behind this change\n" +
      "    - `firestore.rules` — the read runs on the Admin SDK, which never consults rules\n",
  );
} else if (!hasContent(scope)) {
  problems.push(
    "empty section: `## Scope discipline`\n" +
      "  List what MUST NOT be touched, or state `None.` explicitly.",
  );
} else {
  const text = scope.join("\n");
  const declaredNone = scope.some((l) => strip(l) !== "" && NONE_ANSWER.test(l));
  if (!MUST_NOT_MARKER.test(text) && !declaredNone) {
    problems.push(
      "`## Scope discipline` has no `MUST NOT touch:` list\n" +
        "  The list is the machine-checkable half — without it nothing downstream\n" +
        "  can be held to this section. Add the list, or state `None.`",
    );
  } else if (MUST_NOT_MARKER.test(text) && mustNotPaths(lines).length === 0 && !declaredNone) {
    problems.push(
      "`## Scope discipline` declares `MUST NOT touch:` but lists no paths\n" +
        "  Each entry must be a bullet naming a path or glob in backticks,\n" +
        "  e.g. ``- `infra/**` — no Terraform apply behind this change``.",
    );
  }
}

if (problems.length) {
  console.error(`error: ${spec} does not satisfy the minimum-diff mandate`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const paths = mustNotPaths(lines);
if (paths.length) {
  console.log(`diff-minimal: scope sections present; ${paths.length} path(s) held out of scope:`);
  for (const p of paths) console.log(`  - ${p}`);
} else {
  console.log("diff-minimal: scope sections present (nothing held out of scope).");
}
