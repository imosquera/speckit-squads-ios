#!/usr/bin/env bun
// button-design preset: check-buttons.ts
// Deterministic half of the button-design rules.
// Read-only: never edits a file.
//
//   spec <spec.md>       `## Actions & Buttons` exists and is either `None.` or a
//                        table where: kind is button|link; links take no role;
//                        each screen has at most one primary; button labels are
//                        1–3 words and not generic; destructive labels name
//                        their object and carry a confirm/type/undo safeguard.
//   plan <feature-dir>   when the spec declares actions, plan.md has a
//                        `## Button System` with all five markers populated and
//                        no touch target under 44×44.
//
// Prose rules (jargon, "match the moment", placement quality) stay in the
// command prompts. A checker that guesses at those cries wolf, and one that
// cries wolf gets disabled.
//
// Usage: check-buttons.ts spec <spec.md>
//        check-buttons.ts plan <feature-dir>
// Exit:  0 pass   1 rule violation (stderr says which)   2 bad usage

import { readFileSync, statSync } from "node:fs";

// Python's str whitespace set and Unicode-aware `\b`, so matching stays exactly
// what the original python helper accepted.
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_CHARS = new RegExp(`[${WS}]`, "u");
const WORD_END = "(?![\\p{L}\\p{N}_])";

const SPEC_TITLE = "Actions & Buttons";
const PLAN_TITLE = "Button System";
const PLAN_MARKERS: readonly string[] = ["Component", "Color roles", "States", "Touch targets", "Placement"];
const GENERIC: ReadonlySet<string> = new Set([
  "ok", "okay", "yes", "no", "submit", "confirm", "click", "click here", "here", "go", "press",
]);
// First word that makes a button destructive. `cancel` only counts with an
// object (`Cancel Subscription`): a bare `Cancel` is the ordinary dismiss button.
const DESTRUCTIVE: ReadonlySet<string> = new Set([
  "delete", "remove", "erase", "destroy", "discard", "revoke", "purge", "wipe", "terminate",
]);
const SAFEGUARD = /confirm|undo|type/iu;
const TARGET_SIZE = new RegExp(`(\\p{Nd}+)[${WS}]*(?:px|pt|dp)?[${WS}]*[x×][${WS}]*(\\p{Nd}+)`, "gu");
const MIN_TARGET = 44;
const DASH: ReadonlySet<string> = new Set(["", "-", "—", "–", "n/a"]);
const MARKER = new RegExp(`^[${WS}]*(?:[-*][${WS}]+)?\\*\\*([^*]+?):\\*\\*[${WS}]*([^\\n]*)$`, "u");
const H2 = new RegExp(`^##[${WS}]`, "u");
const ANY_HEADING = new RegExp(`^#{1,6}[${WS}]`, "u");
const NONE_RE = new RegExp(`^[${WS}]*None${WORD_END}`, "iu");
const RULE_CELL = /^:?-+:?$/;

const SPEC_SHAPE = `  Expected shape (or \`None — no user-facing UI.\` under the heading):

    ## Actions & Buttons

    | Screen | Label | Kind | Role | Safeguard |
    |---|---|---|---|---|
    | Export dialog | Download Report | button | primary | — |
    | Export dialog | Cancel | button | secondary | — |
    | Settings | Delete Account | button | secondary | type-to-confirm |
    | Settings | Privacy policy | link | — | — |`;

const PLAN_SHAPE =
  "  Expected markers, each populated:\n" + PLAN_MARKERS.map((m) => `    **${m}:** ...`).join("\n");

// ---------------------------------------------------------------- py compat

function pyPath(p: string): string {
  const root = p.startsWith("//") && !p.startsWith("///") ? "//" : p.startsWith("/") ? "/" : "";
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  return root + parts.join("/") || ".";
}

function join(base: string, name: string): string {
  if (base === ".") return name;
  return base.endsWith("/") ? base + name : `${base}/${name}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// str.strip(chars) / str.strip() with Python's whitespace set.
function strip(s: string, chars?: string): string {
  const inSet = (ch: string): boolean => (chars === undefined ? WS_CHARS.test(ch) : chars.includes(ch));
  const cps = [...s];
  let a = 0;
  let b = cps.length;
  while (a < b && inSet(cps[a] ?? "")) a += 1;
  while (b > a && inSet(cps[b - 1] ?? "")) b -= 1;
  return cps.slice(a, b).join("");
}

function rstrip(s: string, chars: string): string {
  const cps = [...s];
  let b = cps.length;
  while (b > 0 && chars.includes(cps[b - 1] ?? "")) b -= 1;
  return cps.slice(0, b).join("");
}

function lstrip(s: string): string {
  const cps = [...s];
  let a = 0;
  while (a < cps.length && WS_CHARS.test(cps[a] ?? "")) a += 1;
  return cps.slice(a).join("");
}

function splitWords(s: string): string[] {
  return s.split(new RegExp(`[${WS}]+`, "u")).filter((w) => w !== "");
}

// Path.read_text().splitlines(): universal newlines, then every line boundary.
function readLines(path: string): string[] {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    .decode(readFileSync(path))
    .replace(/\r\n?/g, "\n");
  const lines = text.split(/[\n\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// int() of a run of Unicode decimal digits (each Nd block is a 0-9 run).
function digitsValue(s: string): number {
  let v = 0;
  for (const ch of s) {
    let cp = ch.codePointAt(0) ?? 0;
    let zero = cp;
    while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
    cp = (cp - zero) % 10;
    v = v * 10 + cp;
  }
  return v;
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

// ---------------------------------------------------------------- checks

type Result = readonly [problems: string[], notes: string[]];

// Body lines of `## <title>` up to the next `## ` heading, or null.
function section(lines: readonly string[], title: string): string[] | null {
  const head = new RegExp(`^##[${WS}]+${escapeRe(title)}[${WS}]*$`, "iu");
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i] ?? "")) {
      const body: string[] = [];
      for (const nxt of lines.slice(i + 1)) {
        if (H2.test(nxt)) break;
        body.push(nxt);
      }
      return body;
    }
  }
  return null;
}

function declaredNone(body: readonly string[]): boolean {
  const first = body.find((l) => strip(l) !== "") ?? "";
  return NONE_RE.test(first);
}

function table(body: readonly string[]): readonly [string[] | null, string[][]] {
  const rows = body
    .filter((l) => lstrip(l).startsWith("|"))
    .map((l) => strip(strip(l), "|").split("|").map((c) => strip(c)));
  const head = rows[0];
  if (rows.length < 2 || head === undefined) return [null, []];
  const data = rows.slice(1).filter((r) => !r.filter((c) => c).every((c) => RULE_CELL.test(c)));
  return [head.map((h) => h.toLowerCase()), data];
}

const COLUMNS = ["screen", "label", "kind", "role", "safeguard"] as const;
type Column = (typeof COLUMNS)[number];

function checkSpec(spec: string): Result {
  const body = section(readLines(spec), SPEC_TITLE);
  if (body === null) return [[`missing section: \`## ${SPEC_TITLE}\`\n${SPEC_SHAPE}`], []];
  if (declaredNone(body)) return [[], ["spec declares no user-facing actions"]];
  const [header, rows] = table(body);
  if (header === null || rows.length === 0) {
    return [[`\`## ${SPEC_TITLE}\` has no action table\n${SPEC_SHAPE}`], []];
  }
  const idx = new Map<Column, number>();
  const missing: string[] = [];
  for (const w of COLUMNS) {
    const i = header.findIndex((h) => h.includes(w));
    if (i === -1) missing.push(w);
    else idx.set(w, i);
  }
  if (missing.length > 0) {
    return [[`action table lacks column(s): ${missing.join(", ")}\n${SPEC_SHAPE}`], []];
  }

  const problems: string[] = [];
  const notes: string[] = [];
  const primaries = new Map<string, number>();
  const buttonScreens: string[] = [];
  rows.forEach((r, k) => {
    const n = k + 1;
    const get = (w: Column): string => {
      const i = idx.get(w) ?? 0;
      return i < r.length ? strip(r[i] ?? "") : "";
    };
    const screen = get("screen");
    const label = strip(get("label"), "`*\"' ");
    const kind = strip(get("kind"), "`").toLowerCase();
    const role = strip(get("role"), "`").toLowerCase();
    const words = splitWords(label);
    const where = `row ${n} (${screen || "?"} / ${label || "?"})`;

    if (kind !== "button" && kind !== "link") {
      problems.push(`${where}: kind must be \`button\` or \`link\`, got \`${kind}\``);
      return;
    }
    if (GENERIC.has(rstrip(label.toLowerCase(), ".!"))) {
      problems.push(`${where}: generic label; say what happens next (\`Download Report\`, not \`Submit\`)`);
    }
    if (kind === "link") {
      if (!DASH.has(role)) {
        problems.push(`${where}: links navigate and take no button role; use \`—\`, or make it a button`);
      }
      return;
    }
    if (role !== "primary" && role !== "secondary" && role !== "tertiary") {
      problems.push(`${where}: button role must be primary|secondary|tertiary, got \`${role}\``);
      return;
    }
    buttonScreens.push(screen);
    if (role === "primary") primaries.set(screen, (primaries.get(screen) ?? 0) + 1);
    if (!(words.length >= 1 && words.length <= 3)) {
      problems.push(`${where}: button labels are 1–3 words, got ${words.length}`);
    }
    const verb = (words[0] ?? "").toLowerCase();
    if (DESTRUCTIVE.has(verb) || (verb === "cancel" && words.length > 1)) {
      if (words.length < 2) {
        problems.push(`${where}: destructive label must name what it destroys (\`Delete Account\`, not \`Delete\`)`);
      }
      if (!SAFEGUARD.test(get("safeguard"))) {
        problems.push(`${where}: destructive action needs a safeguard: \`confirm dialog\`, \`type-to-confirm\`, or \`undo\``);
      }
    }
  });

  for (const [screen, count] of primaries) {
    if (count > 1) {
      problems.push(`screen \`${screen}\`: ${count} primary buttons; exactly one action is the next step, demote the rest to secondary`);
    }
  }
  for (const screen of new Set(buttonScreens)) {
    if (!primaries.has(screen)) {
      notes.push(`screen \`${screen}\` has buttons but no primary; fine for a toolbar, suspicious for a task`);
    }
  }
  return [problems, notes];
}

// Text after `**<name>:**` up to the next plan marker or heading, or null.
function marker(body: readonly string[], name: string): string | null {
  for (let i = 0; i < body.length; i++) {
    const m = MARKER.exec(body[i] ?? "");
    if (m && strip(m[1] ?? "").toLowerCase() === name.toLowerCase()) {
      const parts = [m[2] ?? ""];
      for (const nxt of body.slice(i + 1)) {
        const nm = MARKER.exec(nxt);
        // Only the five plan markers end a block; a nested `**Primary:**`
        // bullet under Color roles is content, not a boundary.
        if ((nm && PLAN_MARKERS.includes(strip(nm[1] ?? ""))) || ANY_HEADING.test(nxt)) break;
        parts.push(nxt);
      }
      return parts.join("\n");
    }
  }
  return null;
}

function checkPlan(fdir: string): Result {
  const spec = join(fdir, "spec.md");
  const body = isFile(spec) ? section(readLines(spec), SPEC_TITLE) : null;
  if (body === null) {
    return [[], [`spec has no \`## ${SPEC_TITLE}\` section (written without this preset's specify layer); nothing to hold the plan to`]];
  }
  if (declaredNone(body)) return [[], ["spec declares no user-facing actions; no button system required"]];
  const plan = section(readLines(join(fdir, "plan.md")), PLAN_TITLE);
  if (plan === null) return [[`missing section in plan.md: \`## ${PLAN_TITLE}\`\n${PLAN_SHAPE}`], []];
  const problems: string[] = [];
  for (const name of PLAN_MARKERS) {
    const content = marker(plan, name);
    if (content === null) problems.push(`\`## ${PLAN_TITLE}\` lacks \`**${name}:**\``);
    else if (strip(content) === "") problems.push(`\`**${name}:**\` is empty`);
    else if (name === "Touch targets") {
      for (const m of content.matchAll(TARGET_SIZE)) {
        const a = m[1] ?? "";
        const b = m[2] ?? "";
        if (Math.min(digitsValue(a), digitsValue(b)) < MIN_TARGET) {
          problems.push(`touch target ${a}×${b} is under ${MIN_TARGET}×${MIN_TARGET}`);
        }
      }
    }
  }
  return [problems, []];
}

const mode = process.argv[2] ?? "";
const targetArg = process.argv[3] ?? "";
function usage(): never {
  console.error("usage: check-buttons.ts spec <spec.md> | plan <feature-dir>");
  process.exit(2);
}
if (mode === "spec") {
  if (!isFile(targetArg)) { console.error(`error: not a file: ${targetArg}`); usage(); }
} else if (mode === "plan") {
  if (!isFile(`${targetArg}/plan.md`)) { console.error(`error: no plan.md in: ${targetArg}`); usage(); }
} else usage();
const target = pyPath(targetArg);

let result: Result;
try {
  result = (mode === "spec" ? checkSpec : checkPlan)(target);
} catch (e) {
  console.error(`error: cannot check ${target} (${e instanceof Error ? e.message : String(e)})`);
  process.exit(1);
}
const [problems, notes] = result;
if (problems.length > 0) {
  console.error(`error: ${target} breaks the button-design rules`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
for (const note of notes) console.log(`button-design: note: ${note}`);
console.log(`button-design: ${mode} check passed.`);
