#!/usr/bin/env bun
// spec-minimal preset: strip-spec-sections.ts
// Removes the Assumptions, Key Entities, and Success Criteria sections from a
// spec.md, in place. Idempotent. Exit 2 on bad usage.
//
// Section boundary rule: a section starts at its heading line and ends at the
// next heading of the same-or-shallower level, or EOF.
//
// Heading matching tolerates the template's trailing parentheticals, e.g.
// `## Success Criteria *(mandatory)*` — anchoring at `$` silently stripped
// nothing while still reporting success (issue #58).
//
// Usage: strip-spec-sections.ts <spec.md>

import { readFileSync, statSync, writeFileSync } from "node:fs";

// Python's str whitespace set, so heading detection matches what the original
// python helper accepted (JS `\s` differs at the edges: U+FEFF, \x1c-\x1f).
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
// Python's `\b` is Unicode-aware; JS's is ASCII-only.
const WORD_END = "(?![\\p{L}\\p{N}_])";

// (heading_level, name, heading regex) — only the prefix matters: the template's
// `*(mandatory)*` / `*(include if ...)*` suffixes are ignored.
const TARGETS: ReadonlyArray<readonly [number, string, RegExp]> = [
  [2, "Assumptions", new RegExp(`^##[${WS}]+Assumptions${WORD_END}`, "u")],
  [3, "Key Entities", new RegExp(`^###[${WS}]+Key Entities${WORD_END}`, "u")],
  [2, "Success Criteria", new RegExp(`^##[${WS}]+Success Criteria${WORD_END}`, "u")],
];

const HEADING = new RegExp(`^(#{1,6})[${WS}]+[^${WS}]`, "u");

function headingLevel(line: string): number | null {
  const m = HEADING.exec(line);
  return m && m[1] !== undefined ? m[1].length : null;
}

// pathlib.PurePosixPath's str(): drop empty and "." parts and trailing slashes.
function pyPath(p: string): string {
  const root = p.startsWith("//") && !p.startsWith("///") ? "//" : p.startsWith("/") ? "/" : "";
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  return root + parts.join("/") || ".";
}

// str.splitlines(keepends=True) after universal-newline decoding.
function splitLines(text: string): string[] {
  return text.match(/[^\n\v\f\x1c\x1d\x1e\x85\u2028\u2029]*(?:[\n\v\f\x1c\x1d\x1e\x85\u2028\u2029]|$)/gu)
    ?.filter((s) => s !== "") ?? [];
}

const arg = process.argv[2];
if (!arg) {
  console.error("error: spec.md path required");
  process.exit(2);
}
let isFile = false;
try { isFile = statSync(arg).isFile(); } catch {}
if (!isFile) {
  console.error(`error: not a file: ${arg}`);
  process.exit(2);
}
const path = pyPath(arg);

let text: string;
try {
  text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
} catch (e) {
  console.error(`error: cannot read ${path} as UTF-8 (${e instanceof Error ? e.message : String(e)})`);
  process.exit(1);
}
const lines = splitLines(text.replace(/\r\n?/g, "\n"));

const removed: string[] = [];
const out: string[] = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i] ?? "";
  const hit = TARGETS.find(([, , pat]) => pat.test(line));
  if (hit === undefined) {
    out.push(line);
    i += 1;
    continue;
  }
  const [level, name] = hit;
  let j = i + 1;
  while (j < lines.length) {
    const lvl = headingLevel(lines[j] ?? "");
    if (lvl !== null && lvl <= level) break;
    j += 1;
  }
  i = j;
  removed.push(name);
}

writeFileSync(path, out.join(""));

const absent = TARGETS.map(([, name]) => name).filter((name) => !removed.includes(name));
const parts: string[] = [];
if (removed.length > 0) parts.push("stripped " + removed.join(" / "));
if (absent.length > 0) parts.push("not present: " + absent.join(" / "));
console.log(`ok: ${parts.join("; ")} (${path})`);
