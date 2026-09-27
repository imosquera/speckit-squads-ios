#!/usr/bin/env bun
// ponytail-plan preset: check-ladder.ts
// Mechanical gate for plan.md's `## Ladder` section: present outside fences;
// a `None — …` line or a table with Kind and Rung columns and >=1 row; Kind in
// file/abstraction/dependency/config; Rung a single integer 1-7; a rung-7
// dependency needs a populated `**Dependency justification:**` line in the
// section. Whether a rung was honestly climbed is the prompt's job, not ours.
//
// Usage: check-ladder.ts <plan.md | feature-dir>
// Exit:  0 pass   1 violations (file:line on stderr)   2 bad usage or no plan.md

import { readFileSync, statSync } from "node:fs";

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

if (process.argv.length !== 3) {
  console.error("usage: check-ladder.ts <plan.md | feature-dir>");
  process.exit(2);
}
let plan = process.argv[2] ?? "";
if (isDir(plan)) plan = `${plan.replace(/\/$/, "")}/plan.md`;
if (!isFile(plan)) {
  console.error(`error: no such file: ${plan}`);
  process.exit(2);
}

// Space/tab only, as the awk original trimmed.
const trim = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, "");
const bare = (s: string) => trim(trim(s).replace(/[*`]/g, "")).toLowerCase();
const cellsOf = (line: string) => {
  const inner = trim(line).replace(/^\|/, "").replace(/\|$/, "");
  return inner === "" ? [] : inner.split("|").map(trim);
};
const JUST = "**Dependency justification:**";

let bad = false;
const err = (n: number, msg: string) => { console.error(`${plan}:${n}: ${msg}`); bad = true; };

let found = false, insec = false, infence = false, none = false, hdr = false, just = false, wantCont = false;
let rows = 0, kcol = 0, rcol = 0, depline = 0, secline = 0;

const lines = readFileSync(plan, "utf8").split("\n");
if (lines.at(-1) === "") lines.pop();
lines.forEach((line, i) => {
  const nr = i + 1;
  if (/^[ \t]*(```|~~~)/.test(line)) { infence = !infence; return; }
  if (infence) return;
  const h = /^(#+)[ \t]/.exec(line);
  if (h) {
    const level = h[1]!.length;
    const title = bare(line.slice(h[0].length));
    if (insec && level <= 2) insec = false;
    if (!found && level === 2 && /^ladder([^a-z]|$)/.test(title)) { found = true; insec = true; secline = nr; }
    wantCont = false;
    return;
  }
  if (!insec) return;

  const t = trim(line);
  if (wantCont) {
    if (t !== "" && !t.startsWith("|") && !t.startsWith("**") && !/^<[^>]*>$/.test(t)) just = true;
    if (t !== "") wantCont = false;
  }
  if (/^None[ \t]*(—|--?)[ \t]*[^ \t]/.test(t)) { none = true; return; }
  if (t.startsWith(JUST)) {
    const rest = trim(t.slice(JUST.length));
    if (rest !== "" && !/^<[^>]*>$/.test(rest)) just = true;
    else wantCont = true;
    return;
  }
  if (!t.startsWith("|")) return;

  const c = cellsOf(t);
  if (!hdr) {
    hdr = true;
    c.forEach((cell, j) => {
      if (bare(cell) === "kind") kcol = j + 1;
      if (bare(cell) === "rung") rcol = j + 1;
    });
    if (!kcol || !rcol) err(nr, "## Ladder table header needs `Kind` and `Rung` columns");
    return;
  }
  if (/^\|[ \t:|-]+$/.test(t)) return; // separator row
  rows++;
  if (!kcol || !rcol) return;
  const kindCell = c[kcol - 1] ?? "", rungCell = c[rcol - 1] ?? "";
  const kind = bare(kindCell), rung = bare(rungCell);
  if (!/^(file|abstraction|dependency|config)$/.test(kind))
    err(nr, `Kind must be file, abstraction, dependency, or config (got \`${kindCell}\`)`);
  if (!/^[1-7]$/.test(rung)) err(nr, `Rung must be a single integer 1-7 (got \`${rungCell}\`)`);
  else if (kind === "dependency" && rung === "7" && !depline) depline = nr;
});

if (!found) err(1, "missing `## Ladder` section");
else if (rows === 0 && !none) err(secline, "## Ladder has no table rows and no `None — extends existing code only.` line");
if (depline && !just) err(depline, "new dependency (rung 7) without a populated `**Dependency justification:**` line in ## Ladder");
if (bad) {
  console.error("ponytail-plan: fix plan.md and re-run.");
  process.exit(1);
}
if (none && rows === 0) console.log("ponytail-plan: ## Ladder declares no additions.");
else console.log(`ponytail-plan: ## Ladder ok (${rows} item(s)).`);
