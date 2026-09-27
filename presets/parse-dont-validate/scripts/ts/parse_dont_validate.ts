#!/usr/bin/env bun
/*
 * Parse, Don't Validate — deterministic anti-pattern scanner (driver).
 *
 * Run by bun. TypeScript files are handed to `pdv_ts_scan.ts` (next to this
 * file), which walks a real AST parsed by a pinned `oxc-parser`; Python
 * files (only with PDV_PYTHON=1, for now) are scanned in-process by a Python tokenizer plus a statement-level
 * structural pass (see "Python" below). Only bun/node built-ins.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DOC = `Parse, Don't Validate — deterministic anti-pattern scanner.

Enforces the "parse, don't validate" discipline: push untrusted data through a
parser at the boundary that returns a *more precise type*, instead of scattering
re-validation (\`isValid...\`, defensive \`if\`s) across the call stack. A validator
says "this is fine, continue" and throws the proof away the instant it returns;
a parser returns either a precise type or a typed error and the type carries the
proof forward. This script gives the preset teeth: an implementer can't claim
"no validators left" while an \`is_valid_user\` / \`isValidUser\` still sits in the
diff.

Sources are analysed structurally, never by line regex:
  * TypeScript (\`.ts/.tsx/.mts/.cts\`) by the bun helper \`scripts/ts/pdv_ts_scan.ts\`
    and a pinned \`oxc-parser\` from the machine cache (never the project's), so
    no \`typescript\` install is needed — TS 7, TS 5 or none all work. There is
    NO regex fallback: if the parser cannot be installed or loaded, or a source
    file cannot be parsed, the scan fails loudly (exit 3) rather than silently
    under-reporting.
  * Python (\`.py/.pyi\`) — only with PDV_PYTHON=1 for now; otherwise .py files
    are skipped, not scanned — by an in-process Python tokenizer (strings, f-string
    expressions, comments, brackets) and a statement-level pass that finds
    annotations, \`def\` headers and calls. Unbalanced brackets or unterminated
    strings fail the scan (exit 3).

Runs under bun (\`#!/usr/bin/env bun\`); no dependencies beyond bun built-ins.

Subcommands
-----------
  checklist
      Print the discipline items an implementation audit must cover.

  scan [--base <ref>] [--new-only] [paths ...]
      Scan TypeScript sources (and Python, with PDV_PYTHON=1) for parse-don't-validate anti-patterns.
      With explicit paths, scans exactly those. With no paths, scans the git
      change set: the working tree PLUS work already committed on the current
      branch (diffed against \`--base\`, or an auto-detected base ref —
      origin/HEAD, then origin/main/master, then main/master). Including
      committed work means the gate still fires after a post-implement hook has
      staged and committed the changes. Exits non-zero when un-waived findings
      exist (1) or when the scan itself could not run (3).

      \`--new-only\` subtracts the findings that already reproduce in the base
      ref's copy of the same files, so only findings this branch introduced are
      reported. Findings are matched by (file, rule, source text), not line
      number.

      Change-set detection always anchors at the git worktree root, so a scan
      started from a subdirectory sees the whole diff rather than the untracked
      files below it.

      Exit codes: 0 clean, 1 findings, 2 bad invocation (unknown option, or
      \`--base\` with no ref), 3 the scan could not run (missing tool, given
      paths resolved to nothing, not a git worktree), 4 nothing was scanned
      because the change set holds no TypeScript (or Python, with PDV_PYTHON=1). A scan that examined
      zero files never exits 0 — an empty input is not a clean result.

Waivers
-------
Any finding can be suppressed with a trailing or preceding line comment
(\`//\` for TypeScript, \`#\` for Python):

      const raw = input as User; // parse-dont-validate: allow PDV004 (boundary)
      user = cast(User, raw)      # parse-dont-validate: allow PDV004 (boundary)

The rule id is required; the parenthetical reason is for humans. Waive at the
*parser boundary* — that is the one place a narrowing cast is legitimate. A
waiver that leaks outside a parser module is the bug this scheme exists to
prevent.
`;

// --- discipline items (language-general) ------------------------------------

const CHECKLIST: ReadonlyArray<readonly [string, string, string]> = [
  ['PDV001', 'No dynamic-typing escape hatch',
    'TypeScript `any`/`as any` and Python `Any` erase the boundary. Untrusted ' +
    'input is `unknown` (TS) or a parsed model (Py), never `any`/`Any`.'],
  ['PDV002', 'Deserialization stays at a parser boundary',
    '`JSON.parse` / `json.loads` / `pickle.loads` are deserializers, not ' +
    'validators. Keep them inside a parser module that hands back a precise ' +
    "domain type; don't scatter raw deserialization through domain code."],
  ['PDV003', 'No boolean validators at the boundary',
    'A `boolean`/`bool`-returning `isValid*`/`validate*` throws information ' +
    'away the instant it returns. Return a parsed, more-precise type (or a ' +
    'Result) instead.'],
  ['PDV004', 'Narrowing casts only inside parser modules',
    'TypeScript `x as Brand` and Python `cast(Brand, x)` are the one ' +
    'sanctioned lie — confine them to the parser at the boundary. A cast ' +
    'elsewhere forges trust the type system never granted.'],
];

const USAGE = 'usage: parse_dont_validate.ts scan [--base <ref>] [--new-only] [paths ...]';

const WAIVER_RE = /parse-dont-validate:\s*allow\s+(PDV\d{3})/gi;

// A parser boundary module — the sanctioned home for narrowing casts and raw
// deserialization. Covers TS parser/schema idioms and Python model/schema ones.
const PARSER_FILE_RE = /(parse|parser|schema|schemas|codec|decoder|brand|model|models)/i;

// Python's `\w` is Unicode-aware; JS's is not, even under /u.
const VALIDATOR_NAME_RE = /^(is_[A-Za-z][\p{L}\p{N}_]*|validate[\p{L}\p{N}_]*|check_valid[\p{L}\p{N}_]*)$/u;

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const PY_EXTENSIONS = new Set(['.py', '.pyi']);
// TypeScript only for now: Python is scanned only when PDV_PYTHON=1. Off, a
// .py file is not a target at all — skipped, never flagged — so a Python-only
// change set is an empty input (exit 4). The scanner and its tests stay.
const PYTHON = process.env.PDV_PYTHON === '1';
const EXTENSIONS = new Set([...TS_EXTENSIONS, ...(PYTHON ? PY_EXTENSIONS : [])]);
const LANGS = PYTHON ? 'TypeScript/Python' : 'TypeScript';

const TS_HELPER = path.join(import.meta.dir, 'pdv_ts_scan.ts');

class ScanError extends Error {}

interface Finding { rule: string; path: string; line: number; text: string }
type Hit = readonly [rule: string, line: number];

// --- path helpers (pathlib semantics: `./a//b/` is `a/b`) --------------------

function normPath(p: string): string {
  if (p === '') return '.';
  const abs = p.startsWith('/');
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  const joined = parts.join('/');
  if (abs) return '/' + joined;
  return joined === '' ? '.' : joined;
}

function suffixOf(p: string): string {
  const name = path.basename(p);
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i) : '';
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// str.splitlines() — the line numbering Python's driver used.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(LINE_BREAK);
  if (LINE_BREAK.test(text.slice(-1))) lines.pop();
  return lines;
}

function readLines(p: string): string[] {
  try {
    return splitLines(new TextDecoder('utf-8').decode(fs.readFileSync(p)));
  } catch { return []; }
}

function waiversForLine(lines: string[], idx: number): Set<string> {
  const waived = new Set<string>();
  for (const probe of [idx, idx - 1]) {
    const line = lines[probe];
    if (line === undefined) continue;
    for (const m of line.matchAll(WAIVER_RE)) waived.add((m[1] ?? '').toUpperCase());
  }
  return waived;
}

/** Apply waivers and attach source text to (rule, line) pairs. */
function finalize(p: string, lines: string[], raw: readonly Hit[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const [rule, line] of raw) {
    const key = `${rule}\0${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (waiversForLine(lines, line - 1).has(rule)) continue;
    out.push({ rule, path: p, line, text: (lines[line - 1] ?? '').trim() });
  }
  return out;
}

// --- Python: tokenizer ------------------------------------------------------
//
// A faithful-enough Python lexer: names, numbers, operators, strings (all
// prefixes, triple quotes, escapes), comments, explicit/implicit line joining,
// and f-/t-string replacement fields, whose expressions are re-lexed so a call
// inside `f"{cast(T, x)}"` is still seen (as `ast` sees it). Logical-line ends
// are NEWLINE tokens. It is not a full parser: it rejects unbalanced or
// mismatched brackets, unterminated strings and stray characters, but not
// indentation errors or grammar it has no reason to understand.

type TokKind = 'name' | 'number' | 'string' | 'op' | 'newline';
interface Tok { kind: TokKind; value: string; line: number }

class PySyntaxError extends Error {
  constructor(readonly lineno: number, msg: string) { super(msg); }
}

const ID_START = /[\p{L}\p{Nl}_\u1885\u1886\u2118\u212e\u309b\u309c]/u;
const ID_CONT = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_\u00b7\u0387\u1369-\u1371\u19da]/u;
const STRING_PREFIXES = new Set(['r', 'u', 'b', 'br', 'rb', 'f', 'fr', 'rf', 't', 'tr', 'rt']);
const OPS3 = ['**=', '//=', '>>=', '<<=', '...'];
const OPS2 = ['->', ':=', '==', '!=', '<=', '>=', '**', '//', '<<', '>>', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '@='];
const OPS1 = new Set(['+', '-', '*', '/', '%', '@', '&', '|', '^', '~', '<', '>', '(', ')',
  '[', ']', '{', '}', ',', ':', '.', ';', '=']);
const CLOSER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Lex `src`. Tokens of f-/t-string replacement-field expressions go to `side`
 * (one list per field) rather than into the returned stream, so they never
 * break the statement structure around the string.
 */
function tokenizePython(src: string, side: Tok[][], firstLine = 1, fragment = false): Tok[] {
  const toks: Tok[] = [];
  const stack: Array<{ ch: string; line: number }> = [];
  let i = 0;
  let line = firstLine;
  let lineHasTokens = false;
  const n = src.length;

  const push = (kind: TokKind, value: string, at: number): void => {
    toks.push({ kind, value, line: at });
    lineHasTokens = true;
  };
  const countNewlines = (s: string): number => {
    let c = 0;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '\n' || (s[k] === '\r' && s[k + 1] !== '\n')) c++;
    }
    return c;
  };

  while (i < n) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\f' || c === '\ufeff') { i++; continue; }
    if (c === '\\' && (src[i + 1] === '\n' || src[i + 1] === '\r')) {
      i += src[i + 1] === '\r' && src[i + 2] === '\n' ? 3 : 2;
      line++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      if (stack.length === 0 && lineHasTokens) {
        toks.push({ kind: 'newline', value: '\n', line });
        lineHasTokens = false;
      }
      line++;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }

    // names, possibly a string prefix
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_CONT.test(src[j] as string)) j++;
      const word = src.slice(i, j);
      const q = src[j];
      if ((q === '"' || q === "'") && STRING_PREFIXES.has(word.toLowerCase())) {
        const startLine = line;
        const end = lexString(src, j, word.toLowerCase(), startLine, side);
        line += countNewlines(src.slice(i, end));
        push('string', src.slice(i, end), startLine);
        i = end;
        continue;
      }
      push('name', word, line);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      const end = lexString(src, i, '', startLine, side);
      line += countNewlines(src.slice(i, end));
      push('string', src.slice(i, end), startLine);
      i = end;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n) {
        const d = src[j] as string;
        if (/[0-9A-Za-z_.]/.test(d)) { j++; continue; }
        if ((d === '+' || d === '-') && /[eE]/.test(src[j - 1] ?? '') &&
            !/^0[xX]/.test(src.slice(i, j))) { j++; continue; }
        break;
      }
      push('number', src.slice(i, j), line);
      i = j;
      continue;
    }

    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    let op: string | undefined;
    if (OPS3.includes(three)) op = three;
    else if (OPS2.includes(two)) op = two;
    else if (OPS1.has(c)) op = c;
    else if (fragment && c === '!') op = c; // f-string conversion `!r`
    if (op === undefined) throw new PySyntaxError(line, `invalid character '${c}'`);

    if (op === '(' || op === '[' || op === '{') stack.push({ ch: op, line });
    const opener = CLOSER[op];
    if (opener !== undefined) {
      const top = stack.pop();
      if (top === undefined) throw new PySyntaxError(line, `unmatched '${op}'`);
      if (top.ch !== opener) {
        throw new PySyntaxError(line,
          `closing parenthesis '${op}' does not match opening parenthesis '${top.ch}'`);
      }
    }
    push('op', op, line);
    i += op.length;
  }
  const open = stack[stack.length - 1];
  if (open !== undefined) throw new PySyntaxError(open.line, `'${open.ch}' was never closed`);
  if (lineHasTokens) toks.push({ kind: 'newline', value: '\n', line });
  return toks;
}

/**
 * Lex one string literal starting at the quote `src[q]`; return the index just
 * past it. For f/t-strings, each replacement field's expression is re-lexed and
 * its tokens pushed onto `side` as their own list, so calls inside it are
 * visible to the call scan.
 */
function lexString(src: string, q: number, prefix: string, startLine: number, side: Tok[][]): number {
  const quote = src[q] as string;
  const triple = src.slice(q, q + 3) === quote.repeat(3);
  const delim = triple ? quote.repeat(3) : quote;
  const formatted = prefix.includes('f') || prefix.includes('t');
  let i = q + delim.length;
  let line = startLine;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    if (c === '\\') {
      if (src[i + 1] === '\n') line++;
      i += 2;
      continue;
    }
    if (!triple && (c === '\n' || c === '\r')) break;
    if (c === '\n') line++;
    if (src.startsWith(delim, i)) return i + delim.length;
    if (formatted && c === '{') {
      if (src[i + 1] === '{') { i += 2; continue; }
      const end = fieldEnd(src, i + 1, line);
      const inner = src.slice(i + 1, end);
      try {
        side.push(tokenizePython(inner, side, line, true));
      } catch { /* an unlexable format spec is not a reason to fail the file */ }
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      i = end + 1;
      continue;
    }
    i++;
  }
  throw new PySyntaxError(startLine,
    triple ? 'unterminated triple-quoted string literal' : 'unterminated string literal');
}

/** Index of the `}` closing an f-string replacement field whose body starts at `i`. */
function fieldEnd(src: string, i: number, line: number): number {
  let depth = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    if (c === '"' || c === "'") {
      // a nested string (3.12 allows the outer quote again)
      let pre = '';
      for (let k = i - 1; k >= 0 && /[A-Za-z]/.test(src[k] as string); k--) pre = src[k] + pre;
      i = lexString(src, i, STRING_PREFIXES.has(pre.toLowerCase()) ? pre.toLowerCase() : '',
        line, []);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '}') {
      if (depth === 0) return i;
      depth--;
    }
    i++;
  }
  throw new PySyntaxError(line, "f-string: expecting '}'");
}

// --- Python: structural pass ------------------------------------------------
//
// Mirrors the old `ast.NodeVisitor`:
//   PDV001  `Any` / `x.Any` inside a variable annotation (`target: T`), a
//           parameter annotation, or a return annotation.
//   PDV002  `json|pickle|marshal.load(s)(` / `yaml.load|safe_load(` where the
//           module is a bare name — outside parser modules.
//   PDV003  `def <validator-name>(...) -> bool:` (return annotation exactly `bool`).
//   PDV004  `cast(` / `<expr>.cast(` — outside parser modules.
// Line numbers follow `ast`: a Name is its own line, an Attribute or Call is the
// line its expression starts on, a `def` is the line of `def`.

const HARD_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async',
  'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or',
  'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
const COMPOUND = new Set(['if', 'elif', 'else', 'while', 'for', 'try', 'except', 'finally',
  'with', 'class']);
const DESERIALIZERS: Record<string, ReadonlySet<string>> = {
  json: new Set(['load', 'loads']),
  pickle: new Set(['load', 'loads']),
  marshal: new Set(['load', 'loads']),
  yaml: new Set(['load', 'safe_load']),
};

const isOp = (t: Tok | undefined, v: string): boolean => t?.kind === 'op' && t.value === v;
const isOpen = (t: Tok | undefined): boolean =>
  t?.kind === 'op' && (t.value === '(' || t.value === '[' || t.value === '{');
const isClose = (t: Tok | undefined): boolean =>
  t?.kind === 'op' && (t.value === ')' || t.value === ']' || t.value === '}');

/** Index of the bracket matching the opener at `i` (tokens are balanced). */
function matchForward(toks: Tok[], i: number): number {
  let d = 0;
  for (let k = i; k < toks.length; k++) {
    if (isOpen(toks[k])) d++;
    else if (isClose(toks[k]) && --d === 0) return k;
  }
  return toks.length - 1;
}

function matchBackward(toks: Tok[], i: number): number {
  let d = 0;
  for (let k = i; k >= 0; k--) {
    if (isClose(toks[k])) d++;
    else if (isOpen(toks[k]) && --d === 0) return k;
  }
  return 0;
}

/** Start index of the primary expression (`a.b(c)[d].e`) ending at token `i`. */
function chainStart(toks: Tok[], i: number): number {
  let k = i;
  for (;;) {
    const t = toks[k];
    if (isClose(t)) {
      const open = matchBackward(toks, k);
      const before = toks[open - 1];
      // `f(...)` / `x[...]`: the call or subscript continues the chain
      if (before && (before.kind === 'name' || before.kind === 'string' || isClose(before)) &&
          !(before.kind === 'name' && HARD_KEYWORDS.has(before.value))) {
        k = open - 1;
        continue;
      }
      k = open;
    }
    if (isOp(toks[k - 1], '.') && k - 2 >= 0) { k -= 2; continue; }
    return k;
  }
}

function pyCallHits(toks: Tok[], isParser: boolean, hits: Hit[]): void {
  if (isParser) return;
  for (let i = 0; i + 1 < toks.length; i++) {
    const t = toks[i] as Tok;
    if (t.kind !== 'name' || !isOp(toks[i + 1], '(')) continue;
    const prev = toks[i - 1];
    const dotted = isOp(prev, '.');
    if (!dotted && prev?.kind === 'name' && (prev.value === 'def' || prev.value === 'class')) {
      continue;
    }
    if (dotted) {
      const mod = toks[i - 2];
      if (mod?.kind === 'name' && !isOp(toks[i - 3], '.') &&
          DESERIALIZERS[mod.value]?.has(t.value)) {
        hits.push(['PDV002', mod.line]);
      }
    }
    if (t.value === 'cast') {
      const start = dotted ? chainStart(toks, i) : i;
      hits.push(['PDV004', (toks[start] as Tok).line]);
    }
  }
}

/** Flag `Any` Names/Attributes in toks[a, b). */
function flagAny(toks: Tok[], a: number, b: number, hits: Hit[]): void {
  let depth = 0;
  for (let k = a; k < b; k++) {
    const t = toks[k] as Tok;
    if (isOpen(t)) depth++;
    else if (isClose(t)) depth--;
    if (t.kind !== 'name' || t.value !== 'Any') continue;
    if (isOp(toks[k - 1], '.')) {
      hits.push(['PDV001', (toks[chainStart(toks, k)] as Tok).line]);
    } else if (!(depth > 0 && isOp(toks[k + 1], '='))) { // not a keyword-arg name
      hits.push(['PDV001', t.line]);
    }
  }
}

/** Index of the first token in [a, b) that is `v` at bracket depth 0, skipping lambda colons. */
function findTop(toks: Tok[], a: number, b: number, vs: readonly string[], lambdaAware = false): number {
  let depth = 0;
  let lambdas = 0;
  for (let k = a; k < b; k++) {
    const t = toks[k] as Tok;
    if (isOpen(t)) { depth++; continue; }
    if (isClose(t)) { depth--; continue; }
    if (depth !== 0) continue;
    if (lambdaAware && t.kind === 'name' && t.value === 'lambda') { lambdas++; continue; }
    if (t.kind === 'op' && vs.includes(t.value)) {
      if (lambdaAware && lambdas > 0 && t.value === ':') { lambdas--; continue; }
      return k;
    }
  }
  return -1;
}

/** Parameters between the parens toks[open] .. toks[close]. */
function scanParams(toks: Tok[], open: number, close: number, hits: Hit[]): void {
  let state: 'param' | 'ann' | 'default' = 'param';
  let depth = 0;
  let lambdas = 0;
  let annStart = -1;
  for (let k = open + 1; k < close; k++) {
    const t = toks[k] as Tok;
    if (isOpen(t)) { depth++; continue; }
    if (isClose(t)) { depth--; continue; }
    if (depth !== 0) continue;
    if (state === 'default' && t.kind === 'name' && t.value === 'lambda') { lambdas++; continue; }
    if (state === 'default' && lambdas > 0 && isOp(t, ':')) { lambdas--; continue; }
    if (isOp(t, ',')) {
      if (state === 'default' && lambdas > 0) continue;
      if (state === 'ann') flagAny(toks, annStart, k, hits);
      state = 'param';
      continue;
    }
    if (state === 'param' && isOp(t, ':')) { state = 'ann'; annStart = k + 1; continue; }
    if (isOp(t, '=')) {
      if (state === 'ann') flagAny(toks, annStart, k, hits);
      state = 'default';
      lambdas = 0;
    }
  }
  if (state === 'ann') flagAny(toks, annStart, close, hits);
}

/** Strip balanced outer parens: `(bool)` is the Name `bool`. */
function unparen(toks: Tok[], a: number, b: number): [number, number] {
  while (b - a >= 2 && isOp(toks[a], '(') && matchForward(toks, a) === b - 1) { a++; b--; }
  return [a, b];
}

/** One simple or compound statement in toks[a, b). */
function scanStatement(toks: Tok[], a: number, b: number, hits: Hit[]): void {
  while (a < b && isOp(toks[a], ';')) a++;
  if (a >= b) return;
  // split `x = 1; y: Any = 2` at top-level semicolons
  const semi = findTop(toks, a, b, [';']);
  if (semi !== -1) {
    scanStatement(toks, a, semi, hits);
    scanStatement(toks, semi + 1, b, hits);
    return;
  }
  const first = toks[a] as Tok;
  if (isOp(first, '@')) return; // decorator line; its calls are covered by the call scan

  let d = a;
  if (first.kind === 'name' && first.value === 'async') d = a + 1;
  const kw = toks[d];
  if (kw?.kind === 'name' && kw.value === 'def') {
    const nameTok = toks[d + 1];
    let k = d + 2;
    if (isOp(toks[k], '[')) k = matchForward(toks, k) + 1; // PEP 695 type params
    if (!nameTok || !isOp(toks[k], '(')) return;
    const close = matchForward(toks, k);
    scanParams(toks, k, close, hits);
    let colon = close + 1;
    if (isOp(toks[close + 1], '->')) {
      colon = findTop(toks, close + 2, b, [':']);
      if (colon === -1) colon = b;
      flagAny(toks, close + 2, colon, hits);
      const [ra, rb] = unparen(toks, close + 2, colon);
      const ret = toks[ra];
      if (rb - ra === 1 && ret?.kind === 'name' && ret.value === 'bool' &&
          VALIDATOR_NAME_RE.test(nameTok.value)) {
        hits.push(['PDV003', (toks[a] as Tok).line]);
      }
    }
    if (isOp(toks[colon], ':')) scanStatement(toks, colon + 1, b, hits);
    return;
  }

  if (first.kind === 'name') {
    const next = toks[a + 1];
    const softHeader = (first.value === 'match' || first.value === 'case') &&
      !(isOp(next, '.') || isOp(next, '=') || isOp(next, ':'));
    if (COMPOUND.has(first.value) || (d !== a && kw !== undefined) || softHeader) {
      const colon = findTop(toks, a + 1, b, [':'], true);
      if (colon !== -1) scanStatement(toks, colon + 1, b, hits);
      return;
    }
    if (HARD_KEYWORDS.has(first.value)) return;
  }

  // annotated assignment: a single primary target immediately followed by `:`
  let k = a;
  if (first.kind === 'name') k = a + 1;
  else if (isOp(first, '(')) k = matchForward(toks, a) + 1;
  else return;
  for (;;) {
    if (isOp(toks[k], '.') && toks[k + 1]?.kind === 'name') { k += 2; continue; }
    if (isOp(toks[k], '[') || isOp(toks[k], '(')) { k = matchForward(toks, k) + 1; continue; }
    break;
  }
  if (k < b && isOp(toks[k], ':')) {
    const eq = findTop(toks, k + 1, b, ['=']);
    flagAny(toks, k + 1, eq === -1 ? b : eq, hits);
  }
}

function pyHits(toks: Tok[], side: Tok[][], isParser: boolean): Hit[] {
  const hits: Hit[] = [];
  let start = 0;
  for (let i = 0; i < toks.length; i++) {
    if ((toks[i] as Tok).kind === 'newline') {
      scanStatement(toks, start, i, hits);
      start = i + 1;
    }
  }
  pyCallHits(toks.filter((t) => t.kind !== 'newline'), isParser, hits);
  for (const frag of side) pyCallHits(frag.filter((t) => t.kind !== 'newline'), isParser, hits);
  return hits;
}

function scanPython(paths: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const p of paths) {
    const lines = readLines(p);
    let toks: Tok[];
    const side: Tok[][] = [];
    try {
      toks = tokenizePython(lines.join('\n'), side);
    } catch (e) {
      if (e instanceof PySyntaxError) {
        throw new ScanError(`${p}:${e.lineno}: cannot parse Python source: ${e.message}`);
      }
      throw e;
    }
    const isParser = PARSER_FILE_RE.test(path.basename(p));
    findings.push(...finalize(p, lines, pyHits(toks, side, isParser)));
  }
  return findings;
}

// --- TypeScript: bun helper + oxc-parser --------------------------------

function scanTypescript(paths: string[]): Finding[] {
  if (!isFile(TS_HELPER)) throw new ScanError(`TypeScript scanner helper missing: ${TS_HELPER}`);
  const job = {
    files: paths.map((p) => ({ path: p, isParser: PARSER_FILE_RE.test(path.basename(p)) })),
  };
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync([process.execPath, TS_HELPER], {
      stdin: Buffer.from(JSON.stringify(job)), stdout: 'pipe', stderr: 'pipe',
    });
  } catch (e) {
    throw new ScanError(`failed to launch bun scanner: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (proc.exitCode !== 0) {
    throw new ScanError(proc.stderr?.toString().trim() || 'TypeScript scanner failed');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(proc.stdout?.toString() || '{}');
  } catch (e) {
    throw new ScanError(`malformed TypeScript scanner output: ${e instanceof Error ? e.message : String(e)}`);
  }
  const byFile = new Map<string, Hit[]>();
  const raw: unknown = typeof payload === 'object' && payload !== null
    ? (payload as { findings?: unknown }).findings : undefined;
  for (const fd of Array.isArray(raw) ? raw as unknown[] : []) {
    if (typeof fd !== 'object' || fd === null) continue;
    const { path: fp, rule, line } = fd as { path?: unknown; rule?: unknown; line?: unknown };
    if (typeof fp !== 'string' || typeof rule !== 'string' || typeof line !== 'number') continue;
    const list = byFile.get(fp) ?? [];
    list.push([rule, line]);
    byFile.set(fp, list);
  }
  const findings: Finding[] = [];
  for (const p of paths) {
    const hits = byFile.get(p);
    if (hits && hits.length) findings.push(...finalize(p, readLines(p), hits));
  }
  return findings;
}

// --- driver -----------------------------------------------------------------

function git(args: string[]): string[] {
  try {
    const r = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) return [];
    return splitLines(r.stdout?.toString() ?? '');
  } catch { return []; }
}

/** A base ref to diff the current branch against for committed feature work. */
function detectBase(): string | null {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  for (const ref of [...head, 'origin/main', 'origin/master', 'main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', ref]).length) return ref;
  }
  return null;
}

function gitRoot(): string | null {
  return git(['rev-parse', '--show-toplevel'])[0] ?? null;
}

/** The commit this branch forked from, to diff committed work against. */
function baseCommit(base: string | null): string | null {
  const ref = base || detectBase();
  if (!ref) return null;
  return git(['merge-base', ref, 'HEAD'])[0] ?? null;
}

function changedFiles(base: string | null): string[] {
  // Change-set detection is cwd-sensitive: `git diff --name-only` reports
  // root-relative paths while `git ls-files --others` is limited to the cwd
  // subtree, so from a subdirectory the whole diff silently collapses to the
  // handful of untracked files below it. Anchor at the worktree root.
  const root = gitRoot();
  if (root) process.chdir(root);

  // Working-tree state (before any auto-commit hook runs).
  const names: string[] = [
    ...git(['diff', '--name-only', '--diff-filter=d', 'HEAD']),
    ...git(['diff', '--name-only', '--diff-filter=d']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ];
  // Committed work on this branch — so the gate still sees the implementation
  // even after a post-implement hook has staged + committed it. Diff against
  // the merge-base with the branch's base ref.
  const mb = baseCommit(base);
  if (mb) names.push(...git(['diff', '--name-only', '--diff-filter=d', mb, 'HEAD']));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (!n || seen.has(n)) continue;
    seen.add(n);
    // Spec Kit's installed tooling (these very scripts among it) is vendored,
    // not the project's code; a reinstall must not read as new findings.
    if (n.startsWith('.specify/')) continue;
    const p = normPath(n);
    if (EXTENSIONS.has(suffixOf(p)) && isFile(p)) out.push(p);
  }
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = dir === '.' ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (EXTENSIONS.has(suffixOf(e.name)) && isFile(p)) out.push(p);
  }
}

const SKIP_PARTS = new Set(['node_modules', 'dist', '__pycache__', '.venv', 'venv', 'build']);

function expand(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const p = normPath(raw);
    if (isDir(p)) walk(p, out);
    else if (EXTENSIONS.has(suffixOf(p)) && isFile(p)) out.push(p);
  }
  return out.filter((p) => !p.split('/').some((part) => SKIP_PARTS.has(part)));
}

const byCodepoint = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort(byCodepoint);

function scan(targets: string[]): Finding[] {
  const py = targets.filter((p) => PY_EXTENSIONS.has(suffixOf(p)));
  const tsx = targets.filter((p) => TS_EXTENSIONS.has(suffixOf(p)));
  const findings = scanPython(py);
  if (tsx.length) findings.push(...scanTypescript(tsx));
  return findings;
}

/** Identity of a finding across revisions — line numbers shift, text doesn't. */
const fingerprint = (f: Finding, p: string): string => `${p}\0${f.rule}\0${f.text}`;

/** Fingerprints of the findings already present in `commit`'s copy of these files. */
function preexisting(targets: string[], commit: string): Set<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-'));
  try {
    const restored = new Map<string, string>();
    for (const p of targets) {
      const blob = Bun.spawnSync(['git', 'show', `${commit}:${p}`], { stdout: 'pipe', stderr: 'pipe' });
      if (blob.exitCode !== 0) continue; // added on this branch — all new
      const dest = path.join(tmp, p);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, blob.stdout ?? '');
      restored.set(dest, p);
    }
    if (!restored.size) return new Set();
    return new Set(scan([...restored.keys()].sort(byCodepoint))
      .map((f) => fingerprint(f, restored.get(f.path) ?? f.path)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Python's repr() for a str, as the old driver printed it. */
function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/\\/g, '\\\\').replace(q === "'" ? /'/g : /"/g, `\\${q}`);
  return q + body + q;
}

function cmdChecklist(): number {
  for (const [rule, title, why] of CHECKLIST) {
    console.log(`${rule}\t${title}`);
    console.log(`\t${why}`);
  }
  return 0;
}

function cmdScan(argv: string[]): number {
  let base: string | null = null;
  let newOnly = false;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--base') {
      // The next token is only a ref if it looks like one. `--base
      // --new-only` used to swallow the flag as the ref: the scan then ran
      // without --new-only against a ref git cannot resolve, so a branch
      // whose files were already committed found no change set and exited
      // 4 — an empty-input answer to what is really a usage error.
      const next = argv[++i];
      if (!next || next.startsWith('-')) {
        console.error('parse-dont-validate: --base needs a ref argument' +
          (next ? `, got ${pyRepr(next)}.\n` : '.\n') + USAGE);
        return 2;
      }
      base = next;
    } else if (arg.startsWith('--base=')) {
      base = arg.slice('--base='.length);
      if (!base) {
        console.error(`parse-dont-validate: --base needs a ref argument.\n${USAGE}`);
        return 2;
      }
    } else if (arg === '--new-only') {
      newOnly = true;
    } else if (arg.startsWith('-')) {
      // An unrecognised flag used to fall through into `paths`, where it
      // resolved to no files and the scan printed a clean, empty run — a
      // typo in the invocation was indistinguishable from a passing gate.
      console.error(`parse-dont-validate: unknown option ${pyRepr(arg)}.\n${USAGE}`);
      return 2;
    } else {
      paths.push(arg);
    }
  }

  // Zero files examined is never reported as a clean pass: an empty *result*
  // and an empty *input* are different answers and exit differently.
  let targets: string[];
  if (paths.length) {
    targets = uniqSorted(expand(paths));
    if (!targets.length) {
      console.error('parse-dont-validate: none of the given paths resolved to a ' +
        `${LANGS} file: ${paths.join(', ')}\n` +
        'Nothing was examined — this is NOT a clean scan.');
      return 3;
    }
  } else if (gitRoot() === null) {
    console.error('parse-dont-validate: no paths given and this is not a git ' +
      'worktree, so there is no change set to scan.\n' +
      'Nothing was examined — this is NOT a clean scan.');
    return 3;
  } else {
    targets = uniqSorted(changedFiles(base));
    if (!targets.length) {
      console.error('parse-dont-validate: nothing scanned — the change set holds ' +
        `no ${LANGS} files.\nThis is an empty input, not a ` +
        'clean scan. It is the expected outcome only when this run ' +
        `genuinely wrote no ${LANGS}; otherwise the ` +
        'invocation is wrong.');
      return 4;
    }
  }

  let findings: Finding[];
  let skipped = 0;
  let commit: string | null = null;
  try {
    findings = scan(targets);
    if (newOnly && findings.length) {
      commit = baseCommit(base);
      if (commit === null) {
        throw new ScanError('--new-only needs a base ref to compare against and none ' +
          'could be detected; pass --base <ref>.');
      }
      const old = preexisting(targets, commit);
      const kept = findings.filter((f) => !old.has(fingerprint(f, f.path)));
      skipped = findings.length - kept.length;
      findings = kept;
    }
  } catch (e) {
    if (e instanceof ScanError) {
      console.error(`parse-dont-validate: ${e.message}`);
      return 3;
    }
    throw e;
  }

  if (newOnly && skipped) {
    console.log(`parse-dont-validate: ignored ${skipped} pre-existing finding(s) ` +
      `already present in ${commit}.`);
  }
  if (!findings.length) {
    console.log(`parse-dont-validate: clean — scanned ${targets.length} file(s), no anti-patterns.`);
    return 0;
  }

  const titles = new Map(CHECKLIST.map(([r, t]) => [r, t] as const));
  findings.sort((x, y) => byCodepoint(x.path, y.path) || x.line - y.line || byCodepoint(x.rule, y.rule));
  for (const f of findings) {
    console.log(`${f.path}:${f.line}: ${f.rule} ${titles.get(f.rule) ?? ''}`);
    console.log(`    ${f.text}`);
  }
  console.log();
  console.log(`parse-dont-validate: ${findings.length} finding(s). Fix each, or waive ` +
    'at the parser boundary with a `parse-dont-validate: allow PDVxxx` comment.');
  return 1;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) {
    console.log(DOC);
    return 2;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help' || rest.includes('--help') ||
      rest.includes('-h')) {
    console.log(DOC);
    return 0;
  }
  if (cmd === 'checklist') return cmdChecklist();
  if (cmd === 'scan') return cmdScan(rest);
  console.error(`unknown command: ${pyRepr(cmd)} (expected 'checklist' or 'scan')`);
  return 2;
}

process.exit(main(process.argv.slice(2)));
