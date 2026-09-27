#!/usr/bin/env bun
// spec-minimal preset: enforce-minimal-tree.ts
// The single, self-healing enforcer for spec-minimal; the last step of the
// wrapped /speckit-plan.
//
// ALLOWED top-level entries:  spec.md, plan.md, tasks.md, quickstart.md,
//                             research.md, checklists (dir)
// FORBIDDEN (any form):       data-model.md, contracts (file or dir)
// Anything else only warns (stacked presets write here); dotfiles are ignored.
//
// Safety invariants (this script deletes files):
// 1. Write-before-remove: plan.md is rebuilt in memory and written atomically
//    (temp + fsync + rename, mode preserved) before anything is removed.
// 2. Inlined content has sentinel prefixes escaped, so blocks parse unambiguously.
// 3. Unbalanced sentinels in plan.md: write nothing, remove nothing, exit 1.
// 4. Symlinks are never followed; only the link is removed.
// 5. A missing plan.md is created, never an excuse to leave an artifact behind.
//
// Exit: 0 tree clean (may have healed/warned); 1 HEALING IMPOSSIBLE (nothing
// changed) or PARTIALLY HEALED (inlined, but an artifact is still on disk) --
// stderr always says which; 2 bad usage.
//
// Usage: enforce-minimal-tree.ts <feature-dir>

import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { randomInt } from "node:crypto";

const ALLOWED: readonly string[] = [
  "spec.md", "plan.md", "tasks.md", "quickstart.md", "research.md",
  // Core Spec Kit's /speckit-specify mandates checklists/requirements.md.
  "checklists",
];
// Deterministic processing order — keeps plan.md stable across runs.
const FORBIDDEN: readonly string[] = ["data-model.md", "contracts"];

const SENTINEL_RE = /<!-- (BEGIN|END): spec-minimal inlined ([^\n]*?) -->/g;

// ---------------------------------------------------------------- py compat
// Paths and error text are rendered exactly as the original python helper
// rendered them (pathlib str(), OSError str()), so messages stay byte-identical.

function pyPath(p: string): string {
  const root = p.startsWith("//") && !p.startsWith("///") ? "//" : p.startsWith("/") ? "/" : "";
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  return root + parts.join("/") || ".";
}

function join(base: string, name: string): string {
  if (base === ".") return name;
  return base.endsWith("/") ? base + name : `${base}/${name}`;
}

function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === "\\" || ch === q) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return q + out + q;
}

const STRERROR: Readonly<Record<string, string>> = {
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  ENOENT: "No such file or directory",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  ENOTEMPTY: "Directory not empty",
  EEXIST: "File exists",
  EROFS: "Read-only file system",
  ENOSPC: "No space left on device",
  ELOOP: "Too many levels of symbolic links",
  EBUSY: "Resource busy",
  EIO: "Input/output error",
  ENAMETOOLONG: "File name too long",
  EMFILE: "Too many open files",
  EXDEV: "Cross-device link",
  EINVAL: "Invalid argument",
};

interface ErrnoLike {
  code?: unknown;
  path?: unknown;
  dest?: unknown;
  message?: unknown;
}

function pyErr(e: unknown): string {
  const x = (typeof e === "object" && e !== null ? e : {}) as ErrnoLike;
  if (typeof x.code === "string" && x.code.startsWith("E")) {
    const errnos = osConstants.errno as Readonly<Record<string, number>>;
    const num = errnos[x.code];
    const msg = STRERROR[x.code] ?? x.code;
    let s = num === undefined ? msg : `[Errno ${num}] ${msg}`;
    if (typeof x.path === "string") {
      s += `: ${pyRepr(x.path)}`;
      if (typeof x.dest === "string") s += ` -> ${pyRepr(x.dest)}`;
    }
    return s;
  }
  return typeof x.message === "string" ? x.message : String(e);
}

class DecodeError extends Error {}

// bytes.decode("utf-8"), including CPython's UnicodeDecodeError wording.
function decodeUtf8(buf: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new DecodeError(utf8ErrorText(buf));
  }
}

function utf8ErrorText(b: Uint8Array): string {
  const at = (k: number): number => b[k] ?? -1;
  const cont = (k: number, lo = 0x80, hi = 0xbf): boolean => at(k) >= lo && at(k) <= hi;
  const fmt = (start: number, end: number, reason: string): string => {
    const head = "'utf-8' codec can't decode";
    return end - start === 1
      ? `${head} byte 0x${at(start).toString(16).padStart(2, "0")} in position ${start}: ${reason}`
      : `${head} bytes in position ${start}-${end - 1}: ${reason}`;
  };
  let i = 0;
  while (i < b.length) {
    const c = at(i);
    if (c < 0x80) { i += 1; continue; }
    let need: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c >= 0xe0 && c <= 0xef) {
      need = 2;
      if (c === 0xe0) lo = 0xa0;
      if (c === 0xed) hi = 0x9f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3;
      if (c === 0xf0) lo = 0x90;
      if (c === 0xf4) hi = 0x8f;
    } else return fmt(i, i + 1, "invalid start byte");
    for (let k = 1; k <= need; k++) {
      const j = i + k;
      if (j >= b.length) return fmt(i, j, "unexpected end of data");
      if (!(k === 1 ? cont(j, lo, hi) : cont(j))) return fmt(i, i + 1, "invalid continuation byte");
    }
    i += need + 1;
  }
  return "'utf-8' codec can't decode input";
}

// str.isspace()-based strip(): Python's whitespace set, not JS trim()'s.
const PY_BLANK = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

function stripNewlines(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

function byCodepoint(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function byParts(a: readonly string[], b: readonly string[]): number {
  for (let k = 0; k < Math.min(a.length, b.length); k++) {
    const c = byCodepoint(a[k] ?? "", b[k] ?? "");
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function lexists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}
function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// ---------------------------------------------------------------- state

const argDir = process.argv[2];
if (!argDir) {
  console.error("error: feature directory argument required");
  process.exit(2);
}
if (!isDir(argDir)) {
  console.error(`error: not a directory: ${argDir}`);
  process.exit(2);
}
const featureDir = pyPath(argDir);
const PLAN = join(featureDir, "plan.md");

// Progress flags — they decide what we may TRUTHFULLY claim in an error message.
let PLAN_WRITTEN = false;
let REMOVAL_STARTED = false;

class Exit extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

function err(msg: string): void {
  console.error(msg);
}

function beginSentinel(name: string): string {
  return `<!-- BEGIN: spec-minimal inlined ${name} -->`;
}

function endSentinel(name: string): string {
  return `<!-- END: spec-minimal inlined ${name} -->`;
}

function dieUntouched(lines: readonly string[]): never {
  for (const line of lines) err(line);
  err("");
  err("HEALING IMPOSSIBLE: nothing was written to plan.md and nothing was");
  err("removed. Fix the problem above and re-run this script.");
  throw new Exit(1);
}

// ---------------------------------------------------------------- sanitizing

// Neutralize literal sentinels so a block body can never contain one
// (invariant 2). Lossy only in the escaping sense; idempotent.
function sanitize(text: string): string {
  return text
    .replaceAll(
      "<!-- BEGIN: spec-minimal inlined",
      "<!-- (escaped by spec-minimal) BEGIN: spec-minimal inlined",
    )
    .replaceAll(
      "<!-- END: spec-minimal inlined",
      "<!-- (escaped by spec-minimal) END: spec-minimal inlined",
    );
}

// ---------------------------------------------------------------- gathering

function readTextOrNull(path: string): string | null {
  try {
    return decodeUtf8(readFileSync(path));
  } catch (e) {
    if (e instanceof DecodeError) return null;
    throw e;
  }
}

function gatherFile(path: string, name: string, skipped: string[]): string {
  const text = readTextOrNull(path);
  if (text === null) {
    skipped.push(name);
    return "";
  }
  return text;
}

// Every regular (non-symlink) file under root, as relative parts. Like
// pathlib's rglob: unreadable directories are skipped silently and symlinked
// directories are never descended into.
function walk(root: string, rel: readonly string[], acc: string[][]): void {
  const dir = rel.length === 0 ? root : join(root, rel.join("/"));
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const parts = [...rel, ent.name];
    if (ent.isDirectory()) walk(root, parts, acc);
    else if (ent.isFile()) acc.push(parts);
  }
}

// Concatenate every file under root, each under a '### <relpath>' heading.
function gatherDir(root: string, rootName: string, skipped: string[]): string {
  const files: string[][] = [];
  walk(root, [], files);
  files.sort(byParts);
  const chunks: string[] = [];
  for (const parts of files) {
    const rel = parts.join("/");
    const text = readTextOrNull(join(root, rel));
    if (text === null) {
      skipped.push(`${rootName}/${rel}`);
      continue;
    }
    const body = stripNewlines(text);
    chunks.push(body ? `### ${rel}\n\n${body}\n` : `### ${rel}\n`);
  }
  return chunks.join("\n");
}

// Read a NON-symlink forbidden path. Symlinks are handled by the caller.
function gather(path: string, name: string, skipped: string[]): string {
  return isDir(path) ? gatherDir(path, name, skipped) : gatherFile(path, name, skipped);
}

function makeBlock(name: string, content: string): string {
  const body = stripNewlines(sanitize(content));
  return `${beginSentinel(name)}\n## Inlined from ${name}\n\n${body}\n${endSentinel(name)}\n`;
}

// ---------------------------------------------------------------- parsing

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let k = text.indexOf("\n"); k !== -1 && k < offset; k = text.indexOf("\n", k + 1)) n += 1;
  return n;
}

type Block = readonly [name: string, start: number, stop: number];

// Every well-formed sentinel block. Any imbalance is a hard error (invariant 3).
function parseBlocks(planText: string): Block[] {
  const blocks: Block[] = [];
  let open: readonly [string, number] | null = null;
  for (const m of planText.matchAll(SENTINEL_RE)) {
    const kind = m[1] ?? "";
    const name = m[2] ?? "";
    const start = m.index;
    if (kind === "BEGIN") {
      if (open !== null) {
        dieUntouched([
          `FAIL: unbalanced spec-minimal sentinels in ${PLAN}`,
          `  - ${beginSentinel(open[0])}`,
          `    on line ${lineOf(planText, open[1])} is never closed;`,
          `    a second BEGIN (for '${name}') appears first on line ${lineOf(planText, start)}.`,
        ]);
      }
      open = [name, start];
    } else {
      if (open === null) {
        dieUntouched([
          `FAIL: unbalanced spec-minimal sentinels in ${PLAN}`,
          `  - ${endSentinel(name)}`,
          `    on line ${lineOf(planText, start)} has no matching BEGIN.`,
        ]);
      }
      if (open[0] !== name) {
        dieUntouched([
          `FAIL: unbalanced spec-minimal sentinels in ${PLAN}`,
          `  - ${endSentinel(name)}`,
          `    on line ${lineOf(planText, start)} does not match the open`,
          `    ${beginSentinel(open[0])}`,
          `    on line ${lineOf(planText, open[1])}.`,
        ]);
      }
      let stop = start + m[0].length;
      // Swallow the newline that terminates the END sentinel line, since a
      // replacement block already carries its own.
      if (planText[stop] === "\n") stop += 1;
      blocks.push([name, open[1], stop]);
      open = null;
    }
  }
  if (open !== null) {
    dieUntouched([
      `FAIL: unbalanced spec-minimal sentinels in ${PLAN}`,
      `  - ${beginSentinel(open[0])}`,
      `    on line ${lineOf(planText, open[1])} is never closed.`,
      "    Close it (or delete the orphan line) so the block structure is",
      "    unambiguous, then re-run.",
    ]);
  }
  return blocks;
}

// Replace each named block in place; drop later duplicates of that name.
// Names with no existing block are appended, separated by one blank line.
function rebuild(planText: string, blocks: readonly Block[], newBlocks: ReadonlyMap<string, string>): string {
  const out: string[] = [];
  let pos = 0;
  const placed = new Set<string>();
  for (const [name, start, stop] of blocks) {
    const block = newBlocks.get(name);
    if (block === undefined) continue;
    out.push(planText.slice(pos, start));
    if (!placed.has(name)) {
      out.push(block);
      placed.add(name);
      pos = stop;
    } else {
      // Stale duplicate: drop it, along with the blank line after it.
      pos = stop;
      while (planText[pos] === "\n") pos += 1;
    }
  }
  out.push(planText.slice(pos));
  let text = out.join("");

  for (const [name, block] of newBlocks) {
    if (placed.has(name)) continue;
    if (text && !text.endsWith("\n")) text += "\n";
    if (text) text += "\n";
    text += block;
  }
  return text;
}

// ---------------------------------------------------------------- writing

function mkstemp(dir: string): readonly [number, string] {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_";
  for (;;) {
    let rand = "";
    for (let k = 0; k < 8; k++) rand += alphabet[randomInt(alphabet.length)];
    const tmp = join(dir, `.plan.md.${rand}.tmp`);
    try {
      return [openSync(tmp, "wx", 0o600), tmp];
    } catch (e) {
      if ((e as ErrnoLike).code !== "EEXIST") throw e;
    }
  }
}

// Write plan.md via temp-file + fsync + rename. Never truncates (invariant 1).
function writePlanAtomically(text: string): void {
  const [fd, tmp] = mkstemp(featureDir);
  try {
    try {
      const data = Buffer.from(text, "utf8");
      let off = 0;
      while (off < data.length) off += writeSync(fd, data, off, data.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    let mode: number;
    try {
      mode = statSync(PLAN).mode & 0o7777;
    } catch {
      mode = 0o644; // plan.md did not exist; mkstemp's 0600 is too tight
    }
    try {
      chmodSync(tmp, mode);
    } catch {
      // best effort, as before
    }
    renameSync(tmp, PLAN);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw e;
  }
  try {
    const dfd = openSync(featureDir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // directory fsync is best effort
  }
  PLAN_WRITTEN = true;
}

// ---------------------------------------------------------------- removing

// shutil.rmtree's fd-based walk, step for step: a directory's files are
// unlinked in readdir order before its subdirectories (LIFO) are walked, the
// first failure aborts the whole removal, and the error names the directory
// being processed — so a partial removal leaves the same files behind and is
// reported with the same text as before.
function rmtree(top: string): void {
  const stack: Array<readonly ["walk" | "rmdir", string]> = [["walk", top]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [op, path] = item;
    try {
      if (op === "rmdir") {
        rmdirSync(path);
        continue;
      }
      stack.push(["rmdir", path]);
      for (const ent of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, ent.name);
        if (ent.isDirectory()) {
          stack.push(["walk", full]);
          continue;
        }
        try {
          unlinkSync(full);
        } catch (e) {
          if ((e as ErrnoLike).code !== "ENOENT") throw e;
        }
      }
    } catch (e) {
      if ((e as ErrnoLike).code === "ENOENT" && path !== top) continue;
      throw { code: (e as ErrnoLike).code, path, message: (e as ErrnoLike).message };
    }
  }
}

// ---------------------------------------------------------------- main

function main(): void {
  // ------------------------------------------------------------ scan
  let entries: string[] = [];
  try {
    entries = readdirSync(featureDir).sort(byCodepoint);
  } catch (e) {
    dieUntouched([`FAIL: cannot list ${featureDir} (${pyErr(e)})`]);
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue; // dotfiles are not our business
    if (ALLOWED.includes(name) || FORBIDDEN.includes(name)) continue;
    err(`warning: unknown top-level entry (left in place): ${name}`);
  }

  // lexists, not exists: a DANGLING symlink is still a forbidden artifact.
  const present = FORBIDDEN.filter((n) => lexists(join(featureDir, n)));

  if (present.length === 0) {
    console.log(`ok: ${featureDir} matches spec-minimal allowed set`);
    return;
  }

  // plan.md is itself an allowed file, so a missing one is not a reason to
  // leave a forbidden artifact on disk (invariant 5) — create it and rehome.
  let planCreated = false;
  let planText = "";
  if (!isFile(PLAN)) {
    if (lexists(PLAN)) {
      dieUntouched([
        `FAIL: ${PLAN} exists but is not a regular file`,
        "  - refusing to overwrite it",
      ]);
    }
    planCreated = true;
    planText =
      "# Implementation Plan\n" +
      "\n" +
      "_Created by the spec-minimal enforcer to rehome content inlined from" +
      " forbidden artifacts._\n";
  } else {
    try {
      // Universal-newline read, as python's read_text() did.
      planText = decodeUtf8(readFileSync(PLAN)).replace(/\r\n?/g, "\n");
    } catch (e) {
      dieUntouched([`FAIL: cannot read ${PLAN} as UTF-8 (${pyErr(e)})`]);
    }
  }

  const blocks = parseBlocks(planText);

  // ------------------------------------------------------------ gather
  const newBlocks = new Map<string, string>();
  const empties: string[] = [];
  const symlinks: Array<readonly [string, string]> = [];

  for (const name of present) {
    const path = join(featureDir, name);
    if (isSymlink(path)) {
      let target: string;
      try {
        target = readlinkSync(path);
      } catch {
        target = "<unreadable>";
      }
      symlinks.push([name, target]);
      continue;
    }
    const skipped: string[] = [];
    let content = "";
    try {
      content = gather(path, name, skipped);
    } catch (e) {
      dieUntouched([`FAIL: cannot read forbidden artifact '${name}' (${pyErr(e)})`]);
    }
    for (const s of skipped) err(`warning: undecodable file, bytes skipped: ${s}`);
    if (!PY_BLANK.test(content)) newBlocks.set(name, makeBlock(name, content));
    else empties.push(name);
  }

  // ------------------------------------------------------------ write
  // Only write (and only create plan.md) when there is content to rehome.
  if (newBlocks.size > 0) {
    try {
      writePlanAtomically(rebuild(planText, blocks, newBlocks));
    } catch (e) {
      dieUntouched([`FAIL: cannot write ${PLAN} (${pyErr(e)})`]);
    }
  } else {
    planCreated = false;
  }

  // ------------------------------------------------------------ remove
  REMOVAL_STARTED = true;
  const removed: string[] = [];
  const failures: string[] = [];
  for (const name of present) {
    const path = join(featureDir, name);
    try {
      if (isSymlink(path)) unlinkSync(path);
      else if (isDir(path)) rmtree(path);
      else unlinkSync(path);
      removed.push(name);
    } catch (e) {
      failures.push(`${name}: could not remove (${pyErr(e)})`);
    }
  }

  // ------------------------------------------------------------ report
  if (planCreated) console.log("created: plan.md (it was missing; inlined content was rehomed there)");
  for (const name of FORBIDDEN) {
    if (newBlocks.has(name)) console.log(`inlined: ${name} -> plan.md (block '${beginSentinel(name)}')`);
  }
  for (const name of empties) console.log(`empty:   ${name} had no content -- nothing inlined`);
  for (const [name, target] of symlinks) {
    console.log(
      `symlink: ${name} is a symlink -> ${target}; only the link was` +
        " handled, the target was neither read nor modified",
    );
  }
  for (const name of removed) console.log(`removed: ${name}`);

  if (failures.length > 0) {
    err(`FAIL: spec-minimal healing incomplete in ${featureDir}`);
    for (const f of failures) err(`  - ${f}`);
    err("");
    if (newBlocks.size > 0) {
      err("PARTIALLY HEALED: the content IS safely inlined in plan.md, but the");
      err("artifact(s) above are still on disk. Remove them by hand (nothing");
      err("will be lost -- plan.md already has the content) and re-run.");
    } else {
      err("PARTIALLY HEALED: nothing needed inlining, but the artifact(s) above");
      err("are still on disk. Remove them by hand and re-run.");
    }
    throw new Exit(1);
  }

  console.log(`ok: ${featureDir} healed to the spec-minimal allowed set`);
}

try {
  main();
} catch (e) {
  if (e instanceof Exit) process.exit(e.code);
  // invariant: never surface a raw stack trace
  const name = e instanceof Error ? e.name : typeof e;
  const msg = e instanceof Error ? e.message : String(e);
  err(`FAIL: spec-minimal enforcer hit an unexpected error in ${featureDir}`);
  err(`  - ${name}: ${msg}`);
  err("");
  if (PLAN_WRITTEN || REMOVAL_STARTED) {
    err(PLAN_WRITTEN
      ? "The run did not complete. plan.md was already updated"
      : "The run did not complete. plan.md was NOT updated");
    err(REMOVAL_STARTED
      ? "and artifact removal had already started."
      : "and no artifact was removed.");
    err("Check the tree by hand before re-running.");
  } else {
    err("HEALING IMPOSSIBLE: nothing was written to plan.md and nothing was removed.");
  }
  process.exit(1);
}
