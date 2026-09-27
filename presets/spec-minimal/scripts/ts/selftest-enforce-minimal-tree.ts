#!/usr/bin/env bun
// spec-minimal preset: selftest-enforce-minimal-tree.ts
// Self-contained test for enforce-minimal-tree.ts. No test framework required.
// Every case asserts exit code AND on-disk state AND plan.md content: this
// script deletes files, so "it exited 0" is not evidence of anything.
//
// Usage: bun presets/spec-minimal/scripts/ts/selftest-enforce-minimal-tree.ts

import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENFORCE = join(import.meta.dir, "enforce-minimal-tree.ts");
if (!existsSync(ENFORCE)) {
  console.error(`error: not found: ${ENFORCE}`);
  process.exit(2);
}

const WORK = mkdtempSync(join(tmpdir(), "selftest-spec-minimal-"));
// Cases deliberately create unreadable/unwritable dirs; loosen before deleting.
process.on("exit", () => {
  Bun.spawnSync(["chmod", "-R", "u+rwx", WORK]);
  rmSync(WORK, { recursive: true, force: true });
});

let failures = 0;
let CASE = "";
const start = (name: string) => { CASE = name; };
const pass = () => console.log(`PASS: ${CASE}`);
const fail = (why: string) => { console.log(`FAIL: ${CASE} — ${why}`); failures++; };

// Built by concatenation so this file never contains a literal sentinel.
const bSent = (n: string) => `<!-- BEGIN: spec-minimal inlined ${n} -->`;
const eSent = (n: string) => `<!-- END: spec-minimal inlined ${n} -->`;

// Byte-oriented fixed-string checks, like `LC_ALL=C grep -F`.
const bytes = (f: string) => { try { return readFileSync(f); } catch { return null; } };
const has = (needle: string, f: string) => bytes(f)?.includes(Buffer.from(needle)) ?? false;
// grep -c: number of matching lines
function count(needle: string, f: string): number {
  const b = bytes(f);
  if (b === null) return 0;
  const n = Buffer.from(needle).toString("latin1");
  return b.toString("latin1").split("\n").filter((l) => l.includes(n)).length;
}
const cat = (f: string) => readFileSync(f, "utf8");
const exists = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const ls = (d: string) => readdirSync(d).sort().join("\n");
// Bash glob `*a*b*`: the parts appear in order.
function glob(s: string, ...parts: string[]): boolean {
  let i = 0;
  for (const p of parts) { const j = s.indexOf(p, i); if (j < 0) return false; i = j + p.length; }
  return true;
}

function mkfeature(name: string): string {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.md"), "# Spec\n\nsome spec\n");
  writeFileSync(join(dir, "plan.md"), "# Plan\n\nsome plan\n");
  writeFileSync(join(dir, "tasks.md"), "# Tasks\n\n- T001\n");
  return dir;
}

let RC = 0, OUT = "", ERR = "";
// $(...) strips trailing newlines; keep that so the shape checks match.
function run(dir?: string, env: Record<string, string> = {}): void {
  const p = Bun.spawnSync(["bun", ENFORCE, ...(dir === undefined ? [] : [dir])], {
    env: { ...process.env, ...env },
  });
  RC = p.exitCode ?? -1;
  OUT = p.stdout.toString().replace(/\n+$/, "");
  ERR = p.stderr.toString().replace(/\n+$/, "");
}

// ---------------------------------------------------------------- case 1
start("clean tree => exit 0, nothing changed, stderr empty");
{
  const d = mkfeature("clean");
  const before = ls(d);
  const planBefore = cat(join(d, "plan.md"));
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (ls(d) !== before) fail("tree changed");
  else if (cat(join(d, "plan.md")) !== planBefore) fail("plan.md changed");
  else if (ERR !== "") fail(`expected empty stderr, got: ${ERR}`);
  else if (!OUT.startsWith("ok:")) fail(`expected an 'ok:' line, got: ${OUT}`);
  else pass();
}

// ---------------------------------------------------------------- case 2
start("data-model.md with content => inlined + removed");
{
  const d = mkfeature("data-model");
  const plan = join(d, "plan.md");
  writeFileSync(join(d, "data-model.md"), "# Data Model\n\nWe picked sqlite because it is boring.\n");
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (exists(join(d, "data-model.md"))) fail("data-model.md still on disk");
  else if (!has(bSent("data-model.md"), plan)) fail("BEGIN sentinel missing from plan.md");
  else if (!has(eSent("data-model.md"), plan)) fail("END sentinel missing from plan.md");
  else if (!has("## Inlined from data-model.md", plan)) fail("heading missing from plan.md");
  else if (!has("boring", plan)) fail("data-model content missing from plan.md");
  else if (!has("some plan", plan)) fail("original plan.md content lost");
  else pass();
}

// ---------------------------------------------------------------- case 3
start("contracts/ dir with two nested files => both inlined with ### headings");
{
  const d = mkfeature("contracts");
  const plan = join(d, "plan.md");
  mkdirSync(join(d, "contracts/api"), { recursive: true });
  writeFileSync(join(d, "contracts/api/openapi.yml"), "openapi: 3.0.0\n");
  writeFileSync(join(d, "contracts/events.json"), '{"kind": "event"}\n');
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (exists(join(d, "contracts"))) fail("contracts/ still on disk");
  else if (!has("### api/openapi.yml", plan)) fail("'### api/openapi.yml' heading missing");
  else if (!has("### events.json", plan)) fail("'### events.json' heading missing");
  else if (!has("openapi: 3.0.0", plan)) fail("openapi.yml content missing");
  else if (!has('"kind": "event"', plan)) fail("events.json content missing");
  else pass();
}

// ---------------------------------------------------------------- case 4
start("idempotence: re-running over the same artifact is byte-identical");
{
  const d = mkfeature("idempotent");
  const plan = join(d, "plan.md");
  writeFileSync(join(d, "data-model.md"), "# Data Model\n\nround one\n");
  run(d);
  const first = cat(plan);
  // Same artifact again: the block must be replaced, not duplicated.
  writeFileSync(join(d, "data-model.md"), "# Data Model\n\nround one\n");
  run(d);
  const second = cat(plan);
  const n = count(bSent("data-model.md"), plan);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (first !== second) fail("plan.md differs between runs");
  else if (n !== 1) fail(`expected exactly 1 sentinel block, found ${n}`);
  else pass();
}

// ---------------------------------------------------------------- case 5
start("unknown entry => exit 0, warning on stderr, entry kept");
{
  const d = mkfeature("unknown");
  mkdirSync(join(d, "notes"));
  writeFileSync(join(d, "notes/scratch.md"), "- [ ] item\n");
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (!isDir(join(d, "notes"))) fail("notes/ was removed");
  else if (!glob(ERR, "warning:", "notes")) fail(`expected a warning about notes on stderr, got: ${ERR}`);
  else pass();
}

// ---------------------------------------------------------------- case 6
start("forbidden artifact + missing plan.md => plan.md created, artifact rehomed, exit 0");
{
  const d = mkfeature("noplan");
  const plan = join(d, "plan.md");
  rmSync(plan);
  writeFileSync(join(d, "data-model.md"), "# Data Model\n\nirreplaceable\n");
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (!isFile(plan)) fail("plan.md was not created");
  else if (exists(join(d, "data-model.md"))) fail("data-model.md still on disk (acceptance: never left behind)");
  else if (!has("irreplaceable", plan)) fail("data-model content was not rehomed into the new plan.md");
  else if (!has("# Implementation Plan", plan)) fail("created plan.md is missing its header");
  else if (!glob(OUT, "created:", "plan.md")) fail(`expected a 'created:' line for plan.md, got: ${OUT}`);
  else pass();
}

// ---------------------------------------------------------------- case 7
start("missing arg => exit 2");
{
  run();
  if (RC !== 2) fail(`expected exit 2, got ${RC}`);
  else if (!ERR.startsWith("error:")) fail(`expected an 'error:' line on stderr, got: ${ERR}`);
  else pass();
}

// ---------------------------------------------------------------- case 7b
// Validation the deleted bash wrapper used to do.
start("not a directory => exit 2");
{
  run(join(WORK, "does-not-exist"));
  if (RC !== 2) fail(`expected exit 2, got ${RC}`);
  else if (!ERR.startsWith("error: not a directory:")) fail(`expected 'error: not a directory:', got: ${ERR}`);
  else pass();
}

// ---------------------------------------------------------------- case 8
start("empty forbidden artifact => removed, no empty section appended");
{
  const d = mkfeature("empty");
  writeFileSync(join(d, "data-model.md"), "");
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (exists(join(d, "data-model.md"))) fail("data-model.md still on disk");
  else if (has("spec-minimal inlined data-model.md", join(d, "plan.md"))) fail("an empty sentinel block was appended");
  else if (!glob(OUT, "removed:", "data-model.md")) fail(`expected a 'removed:' line for data-model.md, got: ${OUT}`);
  else pass();
}

// ---------------------------------------------------------------- case 9
start("paths with spaces are handled");
{
  const d = mkfeature("feature with spaces");
  const plan = join(d, "plan.md");
  mkdirSync(join(d, "contracts/sub dir"), { recursive: true });
  writeFileSync(join(d, "contracts/sub dir/a file.yml"), "spaced contract\n");
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (exists(join(d, "contracts"))) fail("contracts/ still on disk");
  else if (!has("### sub dir/a file.yml", plan)) fail("'### sub dir/a file.yml' heading missing");
  else if (!has("spaced contract", plan)) fail("content missing");
  else pass();
}

// ---------------------------------------------------------------- case 10 (C2a)
start("C2a: inlined content quoting a foreign BEGIN sentinel must not truncate plan.md");
{
  const d = mkfeature("sentinel-truncate");
  const plan = join(d, "plan.md");
  const mk = () => {
    writeFileSync(join(d, "data-model.md"),
      `# Data Model\n\nQuoting a sentinel, as this preset README does:\n\n${bSent("contracts")}\n\nDMTAIL\n`);
    mkdirSync(join(d, "contracts"), { recursive: true });
    writeFileSync(join(d, "contracts/api.yml"), "openapi: 3.0.0\n");
  };
  mk(); run(d);
  mk(); run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (exists(join(d, "data-model.md")) || exists(join(d, "contracts"))) fail("forbidden artifact left on disk");
  else if (!has("DMTAIL", plan)) fail("data-model block was truncated — DMTAIL lost");
  else if (!has("openapi", plan)) fail("contracts content lost");
  else if (!has("some plan", plan)) fail("original plan.md content lost");
  else if (count(bSent("data-model.md"), plan) !== 1)
    fail(`expected exactly 1 data-model.md BEGIN, found ${count(bSent("data-model.md"), plan)}`);
  else if (count(eSent("data-model.md"), plan) !== 1) fail("expected exactly 1 data-model.md END");
  else if (count(bSent("contracts"), plan) !== 1)
    fail(`expected exactly 1 contracts BEGIN, found ${count(bSent("contracts"), plan)}`);
  else if (count(eSent("contracts"), plan) !== 1) fail("expected exactly 1 contracts END");
  else pass();
}

// ---------------------------------------------------------------- case 11 (C2b)
start("C2b: inlined content quoting its own END sentinel must not grow plan.md");
{
  const d = mkfeature("sentinel-growth");
  const plan = join(d, "plan.md");
  const mk = () => writeFileSync(join(d, "data-model.md"),
    `# Data Model\n\nbefore\n\n${eSent("data-model.md")}\n\nafter\n`);
  mk(); run(d); const r1 = cat(plan);
  mk(); run(d); const r2 = cat(plan);
  mk(); run(d); const r3 = cat(plan);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (r1 !== r2 || r2 !== r3) fail("plan.md is not idempotent across runs (grew or shrank)");
  else if (count(bSent("data-model.md"), plan) !== 1)
    fail(`expected exactly 1 BEGIN, found ${count(bSent("data-model.md"), plan)}`);
  else if (count(eSent("data-model.md"), plan) !== 1)
    fail(`expected exactly 1 END, found ${count(eSent("data-model.md"), plan)}`);
  else if (!has("after", plan)) fail("content after the quoted sentinel was lost");
  else if (!has("some plan", plan)) fail("original plan.md content lost");
  else pass();
}

// ---------------------------------------------------------------- case 12 (C3)
start("C3: orphan BEGIN in plan.md => exit 1, nothing written, nothing removed");
{
  const d = mkfeature("orphan-begin");
  const plan = join(d, "plan.md");
  const dm = join(d, "data-model.md");
  writeFileSync(plan, `# Plan\n\nsome plan\n\n${bSent("data-model.md")}\n\nKEEPME\n`);
  writeFileSync(dm, "# Data Model\n\nnew round\n");
  const planBefore = cat(plan);
  const dmBefore = cat(dm);
  run(d);
  if (RC !== 1) fail(`expected exit 1, got ${RC}`);
  else if (!isFile(dm)) fail("data-model.md was removed despite the hard error");
  else if (cat(dm) !== dmBefore) fail("data-model.md was modified");
  else if (cat(plan) !== planBefore) fail("plan.md was modified despite the hard error (KEEPME at risk)");
  else if (!ERR.includes("unbalanced")) fail(`expected stderr to say 'unbalanced', got: ${ERR}`);
  else if (!ERR.includes("never closed")) fail(`expected stderr to name the unclosed sentinel, got: ${ERR}`);
  else if (!ERR.includes("line")) fail(`expected stderr to give a line number, got: ${ERR}`);
  else pass();
}

// ---------------------------------------------------------------- case 13 (C1a)
start("C1a: read-only plan.md => healed atomically, content never lost, mode preserved");
{
  const d = mkfeature("readonly-plan");
  const plan = join(d, "plan.md");
  writeFileSync(join(d, "data-model.md"), "# Data Model\n\nWe picked sqlite because it is boring.\n");
  chmodSync(plan, 0o444);
  run(d);
  const mode = statSync(plan).mode & 0o777;
  chmodSync(plan, 0o644);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (exists(join(d, "data-model.md"))) fail("data-model.md removed without its content being written");
  else if (!has("boring", plan)) fail("data-model content was NOT written to plan.md (data loss)");
  else if (!has("some plan", plan)) fail("original plan.md content lost");
  else if (mode !== 0o444) fail(`plan.md permission bits not preserved, got: ${mode.toString(8)}`);
  else pass();
}

// ---------------------------------------------------------------- case 14 (C1b)
start("C1b: non-UTF-8 locale with non-latin1 content => still healed losslessly");
{
  const d = mkfeature("nonutf8-locale");
  const plan = join(d, "plan.md");
  writeFileSync(join(d, "data-model.md"), "# Data Model\n\nJAPANESEMARKER 天気 café\n");
  run(d, { LC_ALL: "en_US.ISO8859-1" });
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (exists(join(d, "data-model.md"))) fail("data-model.md removed but plan.md write failed");
  else if (!(statSync(plan).size > 0)) fail("plan.md was truncated to 0 bytes");
  else if (!has("JAPANESEMARKER", plan)) fail("data-model content missing from plan.md");
  else if (!has("天気", plan)) fail("non-latin1 bytes were mangled or dropped");
  else if (!has("some plan", plan)) fail("original plan.md content lost");
  else pass();
}

// ---------------------------------------------------------------- case 15 (M1)
start("M1: one artifact removable, one not => exit 1, content safe, state reported exactly");
{
  const d = mkfeature("partial-removal");
  const plan = join(d, "plan.md");
  const locked = join(d, "contracts/locked");
  writeFileSync(join(d, "data-model.md"), "# Data Model\n\nDMBODY\n");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "api.yml"), "LOCKEDCONTRACT\n");
  chmodSync(locked, 0o500);
  run(d);
  try { chmodSync(locked, 0o700); } catch {}
  if (RC !== 1) fail(`expected exit 1, got ${RC} (${OUT})`);
  else if (exists(join(d, "data-model.md"))) fail("data-model.md should have been removed (its removal succeeds)");
  else if (!isDir(join(d, "contracts"))) fail("contracts/ should still be on disk (its removal fails)");
  else if (!has("DMBODY", plan)) fail("data-model content not inlined before removal");
  else if (!has("LOCKEDCONTRACT", plan)) fail("contracts content not inlined — it is about to be reported as unremovable");
  else if (!has("some plan", plan)) fail("original plan.md content lost");
  else if (!ERR.includes("PARTIALLY HEALED")) fail(`expected stderr to say PARTIALLY HEALED, got: ${ERR}`);
  else if (!ERR.includes("contracts")) fail(`expected stderr to name contracts, got: ${ERR}`);
  else if (ERR.includes("HEALING IMPOSSIBLE")) fail("stderr wrongly claims nothing was written");
  else pass();
}

// ---------------------------------------------------------------- case 16 (M2)
start("M2: dangling data-model.md symlink => detected and removed, not reported clean");
{
  const d = mkfeature("dangling-symlink");
  symlinkSync(join(WORK, "does-not-exist-ever"), join(d, "data-model.md"));
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (isLink(join(d, "data-model.md"))) fail("dangling data-model.md symlink left on disk");
  else if (!glob(OUT, "symlink:", "data-model.md")) fail(`expected a 'symlink:' line for data-model.md, got: ${OUT}`);
  else if (!glob(OUT, "removed:", "data-model.md")) fail(`expected a 'removed:' line for data-model.md, got: ${OUT}`);
  else if (glob(ERR, "unknown top-level entry", "data-model.md")) fail(`data-model.md was misreported as an unknown entry: ${ERR}`);
  else pass();
}

// ---------------------------------------------------------------- case 17 (M3)
start("M3: contracts symlink to a dir => link removed, target intact, reported truthfully");
{
  const d = mkfeature("contracts-symlink");
  const target = join(WORK, "contracts-target");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "api.yml"), "TARGETCONTRACT\n");
  symlinkSync(target, join(d, "contracts"));
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (exists(join(d, "contracts"))) fail("contracts symlink left on disk");
  else if (!isFile(join(target, "api.yml"))) fail("symlink target was destroyed");
  else if (cat(join(target, "api.yml")) !== "TARGETCONTRACT\n") fail("symlink target content was modified");
  else if (!glob(OUT, "symlink:", "contracts")) fail(`expected a truthful 'symlink:' line, got: ${OUT}`);
  else if (glob(OUT, "empty:", "contracts")) fail(`contracts was falsely reported as empty, got: ${OUT}`);
  else if (ERR.includes("undecodable")) fail(`spurious 'undecodable file' warning, got: ${ERR}`);
  else pass();
}

// ---------------------------------------------------------------- case 18 (L1)
start("L1: unreadable feature dir => clean exit 1, no traceback, nothing removed");
{
  const d = mkfeature("unreadable-dir");
  const dm = join(d, "data-model.md");
  writeFileSync(dm, "# Data Model\n\nSTILLHERE\n");
  chmodSync(d, 0o300);
  run(d);
  chmodSync(d, 0o700);
  if (RC !== 1) fail(`expected exit 1, got ${RC} (${OUT})`);
  else if (ERR.includes("Traceback")) fail(`raw traceback leaked to stderr: ${ERR}`);
  else if (!ERR.startsWith("FAIL:")) fail(`expected a 'FAIL:' line on stderr, got: ${ERR}`);
  else if (!ERR.includes("HEALING IMPOSSIBLE")) fail(`expected stderr to state HEALING IMPOSSIBLE, got: ${ERR}`);
  else if (!isFile(dm)) fail("data-model.md was removed");
  else if (!has("STILLHERE", dm)) fail("data-model.md content changed");
  else pass();
}

// ---------------------------------------------------------------- case 18b
start("research.md is ALLOWED => kept untouched, no warning");
{
  const d = mkfeature("research-allowed");
  const research = join(d, "research.md");
  writeFileSync(research, "# Research\n\nLIBFINDINGS\n");
  const planBefore = cat(join(d, "plan.md"));
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (!isFile(research)) fail("research.md was removed — it is in the allowed set");
  else if (!has("LIBFINDINGS", research)) fail("research.md content changed");
  else if (cat(join(d, "plan.md")) !== planBefore) fail("plan.md changed — research.md must not be inlined");
  else if (glob(ERR, "warning:", "research.md")) fail(`research.md was warned about as unknown, got: ${ERR}`);
  else pass();
}

// ---------------------------------------------------------------- case 19 (L2)
start("L2: dotfiles are ignored, not warned about");
{
  const d = mkfeature("dotfiles");
  writeFileSync(join(d, ".DS_Store"), "junk");
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (ERR !== "") fail(`expected empty stderr, got: ${ERR}`);
  else if (!isFile(join(d, ".DS_Store"))) fail(".DS_Store was removed");
  else pass();
}

// ---------------------------------------------------------------- case 20 (L3)
start("L3: pre-existing duplicate blocks for one name converge to a single block");
{
  const d = mkfeature("duplicate-blocks");
  const plan = join(d, "plan.md");
  const B = bSent("data-model.md"), E = eSent("data-model.md");
  writeFileSync(plan,
    `# Plan\n\nsome plan\n\n` +
    `${B}\n## Inlined from data-model.md\n\nSTALEONE\n${E}\n\n` +
    `${B}\n## Inlined from data-model.md\n\nSTALETWO\n${E}\n\nPLANTAIL\n`);
  writeFileSync(join(d, "data-model.md"), "# Data Model\n\nFRESHCONTENT\n");
  run(d);
  const nBegin = count(B, plan), nEnd = count(E, plan);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (exists(join(d, "data-model.md"))) fail("data-model.md still on disk");
  else if (nBegin !== 1) fail(`expected exactly 1 BEGIN after healing, found ${nBegin}`);
  else if (nEnd !== 1) fail(`expected exactly 1 END after healing, found ${nEnd}`);
  else if (has("STALEONE", plan)) fail("stale block 1 survived");
  else if (has("STALETWO", plan)) fail("stale duplicate block 2 survived");
  else if (!has("FRESHCONTENT", plan)) fail("fresh content missing");
  else if (!has("PLANTAIL", plan)) fail("content after the duplicate blocks was lost");
  else if (!has("some plan", plan)) fail("original plan.md content lost");
  else pass();
}

// ---------------------------------------------------------------- case 21
start("C1b: report text itself must be encodable in a non-UTF-8 locale");
{
  const d = mkfeature("nonutf8-report");
  writeFileSync(join(d, "data-model.md"), "");
  mkdirSync(join(d, "checklists"));
  run(d, { LC_ALL: "en_US.ISO8859-1" });
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (exists(join(d, "data-model.md"))) fail("data-model.md still on disk");
  else if (!glob(OUT, "empty:", "data-model.md")) fail(`expected the 'empty:' report line to survive the locale, got: ${OUT}`);
  else if (!glob(OUT, "removed:", "data-model.md")) fail(`expected a 'removed:' line, got: ${OUT}`);
  else if (ERR.includes("Error")) fail(`reporting raised under a non-UTF-8 locale: ${ERR}`);
  else pass();
}

// ---------------------------------------------------------------- case 22
start("checklists/ is allowed => exit 0, no warning, dir left in place");
{
  const d = mkfeature("checklists-allowed");
  mkdirSync(join(d, "checklists"));
  writeFileSync(join(d, "checklists/requirements.md"), "- [ ] item\n");
  run(d);
  if (RC !== 0) fail(`expected exit 0, got ${RC} (${ERR})`);
  else if (!isFile(join(d, "checklists/requirements.md"))) fail("checklists/ was removed or emptied");
  else if (ERR !== "") fail(`expected no warning about checklists, got: ${ERR}`);
  else if (has("requirements.md", join(d, "plan.md"))) fail("checklists content was folded into plan.md");
  else pass();
}

console.log("");
if (failures === 0) {
  console.log("all cases passed");
  process.exit(0);
}
console.log(`${failures} case(s) failed`);
process.exit(1);
