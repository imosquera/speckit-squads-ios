#!/usr/bin/env bun
/*
 * Parse, Don't Validate — deterministic anti-pattern scanner for Swift (driver
 * and scanner in one file).
 *
 * Run by bun, only bun/node built-ins. Swift sources are scanned in-process: a
 * lexer blanks comments and string literals (keeping `\(...)` interpolation
 * code), checks bracket balance, finds parser scopes, then matches the rules on
 * the sanitized text. See "Swift" below.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DOC = `Parse, Don't Validate — deterministic anti-pattern scanner (Swift).

Enforces the "parse, don't validate" discipline: push untrusted data through a
parser at the boundary that returns a *more precise type*, instead of scattering
re-validation (\`isValid...\`, defensive \`guard\`s) across the call stack. A
validator says "this is fine, continue" and throws the proof away the instant it
returns; a parser (a throwing/failable \`init\`, or \`Decodable\`) returns either
a precise type or a typed error, and the type carries the proof forward. This
script gives the preset teeth: an implementer can't claim "no validators left"
while a \`func isValidUser(_:) -> Bool\` still sits in the diff.

Swift sources (\`.swift\`) are scanned by an in-process lexer, not an AST: it
blanks comments (nested \`/* */\` included) and string literals (\`"..."\`,
\`"""..."""\`, raw \`#"..."#\`) while keeping \`\\(...)\` interpolation code,
checks that (), [] and {} balance, and finds parser scopes from declarations.
An unterminated string or comment, or unbalanced brackets, fails the scan
(exit 3) rather than under-reporting.

Parser scopes — where untyped data, casts and deserialization are sanctioned:
  * a file whose name says so (\`*Parser*\`, \`*Parsing*\`, \`*Decod*\`,
    \`*Codec*\`, \`*Schema*\`, \`*DTO*\`);
  * the body of a type named \`*Parser*\`, or a type/extension whose declaration
    conforms to \`Decodable\` or \`Codable\`;
  * the parameter list and body of \`init(from:)\`, \`init(parsing:)\`
    (incl. \`init?\`/\`init!\`) and any \`func parse...\`.

Runs under bun (\`#!/usr/bin/env bun\`); no dependencies beyond bun built-ins.

Subcommands
-----------
  checklist
      Print the discipline items an implementation audit must cover.

  scan [--base <ref>] [--new-only] [paths ...]
      Scan Swift sources for parse-don't-validate anti-patterns.
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
      files below it. Vendored trees (\`.specify/\`, \`Pods/\`, \`Carthage/\`,
      \`.build/\`, \`DerivedData/\`, \`SourcePackages/\`) are never scanned.

      Exit codes: 0 clean, 1 findings, 2 bad invocation (unknown option, or
      \`--base\` with no ref), 3 the scan could not run (unlexable source,
      given paths resolved to nothing, not a git worktree), 4 nothing was
      scanned because the change set holds no Swift. A scan that examined zero
      files never exits 0 — an empty input is not a clean result.

Waivers
-------
Any finding can be suppressed with a trailing or preceding \`//\` line comment:

      let raw = json as! [String: String] // parse-dont-validate: allow PDV004 (boundary)

The rule id is required; the parenthetical reason is for humans. Waive at the
*parser boundary* — that is the one place untyped data is legitimate. A waiver
that leaks outside a parser scope is the bug this scheme exists to prevent.
`;

// --- discipline items -------------------------------------------------------

const CHECKLIST: ReadonlyArray<readonly [string, string, string]> = [
  ['PDV001', 'No dynamic-typing escape hatch',
    '`Any` / `AnyObject` (and `[String: Any]` bags) erase the boundary. Untrusted ' +
    'input is `Data` handed straight to a parser, never `Any` passed around ' +
    'domain code. (`AnyObject` as a class constraint — `protocol P: AnyObject`, ' +
    '`<T: AnyObject>`, `& AnyObject` — is not flagged.)'],
  ['PDV002', 'Untyped deserialization stays at a parser boundary',
    '`JSONSerialization` / `PropertyListSerialization` / `unarchiveObject` and ' +
    '`decode([String: …].self, …)` produce untyped bags. Keep them inside a ' +
    'parser scope that hands back a domain type; decode `Decodable` domain ' +
    'types instead.'],
  ['PDV003', 'No boolean validators',
    'A `func isValid…(…) -> Bool` / `validate…` / `checkValid…` throws information ' +
    'away the instant it returns. Make it a throwing or failable `init` that ' +
    'returns the parsed type. Flagged everywhere, parser scopes included.'],
  ['PDV004', 'Force casts only inside parser scopes',
    '`x as! T` forges a type the compiler never granted and traps on bad input. ' +
    'Use `as?` inside a parser that throws a typed error.'],
  ['PDV005', 'No trapping on untrusted input',
    '`try!` turns a parse failure into a crash. Propagate the typed error ' +
    '(`try`) or handle it. Flagged everywhere, parser scopes included — a parser ' +
    'that traps is not a parser.'],
];

const USAGE = 'usage: parse_dont_validate.ts scan [--base <ref>] [--new-only] [paths ...]';

const WAIVER_RE = /parse-dont-validate:\s*allow\s+(PDV\d{3})/gi;

// A parser boundary file — the sanctioned home for casts and raw
// deserialization. Deliberately NOT `model`: `*ViewModel.swift` is everywhere
// in an iOS app and must not be exempt.
const PARSER_FILE_RE = /(pars(e|er|ing)|decod|codec|schema|dto)/i;

const EXTENSIONS = new Set(['.swift']);
const LANGS = 'Swift';

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

// Swift's own line breaks; the scanner numbers lines the same way.
const LINE_BREAK = /\r\n|\r|\n/;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(LINE_BREAK);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function readText(p: string): string {
  try { return new TextDecoder('utf-8').decode(fs.readFileSync(p)); } catch { return ''; }
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

// --- Swift: sanitizer ---------------------------------------------------------
//
// ponytail: no Swift AST parser runs under bun, so this is a lexer plus
// declaration heuristics, not SwiftSyntax. Known ceiling:
//   * bare regex literals (`/[a-z]+/`, Swift 5.7) are lexed as code, so a regex
//     holding `"`, `//` or an unbalanced bracket can mis-lex or fail the scan;
//   * `#if` branches that each open a brace (`#if A class X: P { #else class X {
//     #endif`) unbalance the braces and fail the scan (exit 3);
//   * parser scopes come from the declaration header text, so a conformance
//     added through a typealias or a macro is not seen;
//   * force unwraps (`x!`) are not flagged: telling a decoded/untrusted value's
//     `!` from every other postfix `!` needs type information.
// Upgrade path: a SwiftSyntax-based helper built by `swift build`, if the gate
// ever needs to be exact.

class SwiftSyntaxError extends Error {
  constructor(readonly offset: number, msg: string) { super(msg); }
}

/**
 * Same-length copy of `src` with comments and string-literal contents blanked to
 * spaces (newlines kept, so offsets and line numbers still line up). The code
 * inside `\(...)` interpolations is kept, so `"\(try! f())"` is still scanned.
 */
function sanitizeSwift(src: string): string {
  const out = src.split('');
  const n = src.length;
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };

  /** Code from `i`; with `interp`, stop at the `)` closing an interpolation. */
  const code = (i: number, interp: boolean): number => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') {
        let j = i;
        while (j < n && src[j] !== '\n' && src[j] !== '\r') j++;
        blank(i, j);
        i = j;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const start = i;
        let nest = 0;
        do {
          if (i >= n) throw new SwiftSyntaxError(start, 'unterminated block comment');
          if (src.startsWith('/*', i)) { nest++; i += 2; } else if (src.startsWith('*/', i)) { nest--; i += 2; } else i++;
        } while (nest > 0);
        blank(start, i);
        continue;
      }
      if (c === '"' || (c === '#' && /^#+"/.test(src.slice(i, i + 16)))) {
        i = str(i);
        continue;
      }
      if (interp) {
        if (c === '(') depth++;
        else if (c === ')') {
          if (depth === 0) return i;
          depth--;
        }
      }
      i++;
    }
    if (interp) throw new SwiftSyntaxError(n, 'unterminated string interpolation');
    return n;
  };

  /** One string literal starting at `i` (its `#`s or quote); index past it. */
  const str = (i: number): number => {
    let h = 0;
    while (src[i + h] === '#') h++;
    const q = i + h;
    const multi = src.startsWith('"""', q);
    const hashes = '#'.repeat(h);
    const close = (multi ? '"""' : '"') + hashes;
    let j = q + (multi ? 3 : 1);
    let seg = i;
    for (;;) {
      if (j >= n) throw new SwiftSyntaxError(i, 'unterminated string literal');
      const c = src[j];
      if (!multi && (c === '\n' || c === '\r')) throw new SwiftSyntaxError(i, 'unterminated string literal');
      if (c === '\\' && src.startsWith(hashes, j + 1)) {
        const k = j + 1 + h;
        if (src[k] === '(') {
          blank(seg, k + 1);
          const end = code(k + 1, true);
          seg = end;
          j = end + 1;
        } else {
          j = k + 1;
        }
        continue;
      }
      if (src.startsWith(close, j)) {
        blank(seg, j + close.length);
        return j + close.length;
      }
      j++;
    }
  };

  code(0, false);
  return out.join('');
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

/** Opener offset → matching closer offset; throws on unbalanced brackets. */
function matchBrackets(s: string): Map<number, number> {
  const match = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (OPENERS[c] !== undefined) stack.push(i);
    else if (CLOSERS.has(c)) {
      const open = stack.pop();
      if (open === undefined) throw new SwiftSyntaxError(i, `unmatched '${c}'`);
      if (OPENERS[s[open] as string] !== c) {
        throw new SwiftSyntaxError(i, `'${c}' does not match '${s[open]}'`);
      }
      match.set(open, i);
    }
  }
  const open = stack.pop();
  if (open !== undefined) throw new SwiftSyntaxError(open, `'${s[open]}' was never closed`);
  return match;
}

// --- Swift: parser scopes -------------------------------------------------------

const DECL_KEYWORDS = /\b(func|var|let|init|deinit|subscript|case|typealias|struct|class|enum|protocol|extension|actor|static)\b/;
const NOT_TYPE_NAMES = new Set(['func', 'var', 'let', 'init', 'deinit', 'subscript', 'override', 'final']);

/** Body `{`…`}` of a declaration whose header runs from `from`; null if it has none. */
function bodyAfter(s: string, from: number, match: Map<number, number>): [number, number] | null {
  const brace = s.indexOf('{', from);
  if (brace === -1) return null;
  const header = s.slice(from, brace);
  if (header.includes('}') || header.includes(';') || DECL_KEYWORDS.test(header)) return null;
  const end = match.get(brace);
  return end === undefined ? null : [brace, end];
}

/** Offset ranges (exclusive of their ends) that are parser scopes. */
function parserScopes(s: string, match: Map<number, number>): Array<[number, number]> {
  const scopes: Array<[number, number]> = [];
  for (const m of s.matchAll(/\b(struct|class|enum|actor|extension)\s+([A-Za-z_][\w.]*)/g)) {
    const name = m[2] as string;
    if (NOT_TYPE_NAMES.has(name)) continue;
    const from = (m.index ?? 0) + m[0].length;
    const brace = s.indexOf('{', from);
    if (brace === -1) continue;
    const header = s.slice(from, brace);
    if (header.includes('}') || header.includes(';')) continue;
    if (!/Parser/.test(name) && !/\b(Decodable|Codable)\b/.test(header)) continue;
    const end = match.get(brace);
    if (end !== undefined) scopes.push([brace, end]);
  }
  const fnRe = /\binit[?!]?\s*(<[^>{}]*>)?\s*\(\s*(from|parsing)\b|\bfunc\s+parse\w*\s*(<[^>{}]*>)?\s*\(/g;
  for (const m of s.matchAll(fnRe)) {
    const open = s.indexOf('(', m.index ?? 0);
    const close = match.get(open);
    if (close === undefined) continue;
    // From the parameter list on: the parser's input type (`[String: Any]`,
    // `Any`) is the boundary itself.
    const body = bodyAfter(s, close + 1, match);
    if (body) scopes.push([open, body[1]]);
  }
  return scopes;
}

// --- Swift: rules ----------------------------------------------------------------

/** `AnyObject` used as a class constraint rather than as a value type. */
function isClassConstraint(s: string, at: number, len: number): boolean {
  const lineStart = Math.max(s.lastIndexOf('\n', at - 1), s.lastIndexOf('\r', at - 1)) + 1;
  const before = s.slice(lineStart, at);
  if (/\b(protocol|where)\b/.test(before)) return true;
  if (/[<,]\s*\w+\s*:\s*$/.test(before)) return true; // `<T: AnyObject>`
  if (/&\s*$/.test(before) || /^\s*&/.test(s.slice(at + len, at + len + 8))) return true;
  return false;
}

const VALIDATOR_RE = /\bfunc\s+(isValid\w*|validate\w*|checkValid\w*)\s*(<[^>{}]*>)?\s*\(/g;
const RETURNS_BOOL_RE = /^\s*(async\s+)?((re)?throws(\s*\([^)]*\))?\s+)?(async\s+)?->\s*(Swift\.)?Bool\b(?!\s*[?!.<])/;

function swiftHits(src: string, fileIsParser: boolean): Hit[] {
  const s = sanitizeSwift(src);
  const match = matchBrackets(s);
  const scopes = fileIsParser ? [] : parserScopes(s, match);
  const inParser = (at: number): boolean => fileIsParser || scopes.some(([a, b]) => at > a && at < b);

  const starts = [0];
  for (const m of s.matchAll(/\r\n|\r|\n/g)) starts.push((m.index ?? 0) + m[0].length);
  const lineOf = (at: number): number => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= at) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const hits: Hit[] = [];
  const outside = (rule: string, re: RegExp, skip?: (at: number, len: number) => boolean): void => {
    for (const m of s.matchAll(re)) {
      const at = m.index ?? 0;
      if (inParser(at) || skip?.(at, m[0].length)) continue;
      hits.push([rule, lineOf(at)]);
    }
  };

  outside('PDV001', /(?<![\w.])Any\b/g);
  outside('PDV001', /(?<![\w.])AnyObject\b/g, (at, len) => isClassConstraint(s, at, len));
  outside('PDV002', /\b(JSONSerialization|PropertyListSerialization)\b|\bunarchiveObject\s*\(|\.decode\s*\(\s*\[\s*String\s*:/g);
  for (const m of s.matchAll(VALIDATOR_RE)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = match.get(open);
    if (close !== undefined && RETURNS_BOOL_RE.test(s.slice(close + 1, close + 200))) {
      hits.push(['PDV003', lineOf(m.index ?? 0)]);
    }
  }
  outside('PDV004', /\bas!/g);
  for (const m of s.matchAll(/\btry!/g)) hits.push(['PDV005', lineOf(m.index ?? 0)]);

  hits.sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return hits;
}

function scanSwift(paths: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const p of paths) {
    const text = readText(p);
    let hits: Hit[];
    try {
      hits = swiftHits(text, PARSER_FILE_RE.test(path.basename(p)));
    } catch (e) {
      if (e instanceof SwiftSyntaxError) {
        const line = (text.slice(0, e.offset).match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
        throw new ScanError(`${p}:${line}: cannot lex Swift source: ${e.message}`);
      }
      throw e;
    }
    findings.push(...finalize(p, splitLines(text), hits));
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
    if (vendored(p)) continue;
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

// Vendored or generated trees: CocoaPods, Carthage, SwiftPM checkouts, Xcode
// derived data. Their code is not the project's to fix.
const SKIP_PARTS = new Set(['Pods', 'Carthage', '.build', 'DerivedData', 'SourcePackages', 'node_modules']);
const vendored = (p: string): boolean => p.split('/').some((part) => SKIP_PARTS.has(part));

function expand(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const p = normPath(raw);
    if (isDir(p)) walk(p, out);
    else if (EXTENSIONS.has(suffixOf(p)) && isFile(p)) out.push(p);
  }
  return out.filter((p) => !vendored(p));
}

const byCodepoint = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort(byCodepoint);

function scan(targets: string[]): Finding[] {
  return scanSwift(targets);
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

/** repr()-style quoting of a user-supplied argument in error messages. */
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
