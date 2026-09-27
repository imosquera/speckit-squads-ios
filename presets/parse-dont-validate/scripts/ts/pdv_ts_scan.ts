#!/usr/bin/env bun
/*
 * Parse, Don't Validate — TypeScript AST scanner.
 *
 * Parses with `oxc-parser` (Rust, TS/TSX → ESTree) and walks the real AST — no
 * regex. Reads a JSON job on stdin:
 *
 *     { "files": [ { "path": "src/user.ts", "isParser": false }, ... ] }
 *
 * and writes findings to stdout:
 *
 *     { "findings": [ { "rule": "PDV004", "path": "src/user.ts", "line": 12 }, ... ] }
 *
 * Waiver comments and result presentation are handled by the driver
 * (`parse_dont_validate.ts`, next to this file);
 * this helper only reports structural findings. It never prints an empty
 * findings list for an input it could not use: a missing/empty/malformed job,
 * file arguments (which it ignores), an unreadable or unparseable source, or a
 * parser it cannot load all exit non-zero with a message on stderr. An empty
 * result and an empty input must not look alike.
 *
 * The scan is syntax only, so it needs no TypeScript at all (issue #115): the
 * project may have TS 7, TS 5, or none. `oxc-parser` is never resolved from the
 * project — a pinned copy is used from a machine-level cache that the first run
 * fills with bun (never `.specify/`, which consumers commit), or from beside
 * this file in a speckit-squads checkout when that copy is the pinned version.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const OXC = 'oxc-parser';
const OXC_VERSION = '0.151.0';

interface JobFile { path: string; isParser?: unknown }
interface Finding { rule: string; path: string; line: number }
// The ESTree slice this scanner reads. Offsets are UTF-16, like JS strings.
interface N { type: string; start: number; end: number; [k: string]: unknown }
// The native binding's answer: the program as ESTree JSON, plus syntax errors.
type Parse = (filename: string, text: string) => { program: string; errors: { message: string }[] };

function fail(code: number, msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

/** A per-file failure, thrown so a worker can hand it to the main thread. */
class ScanError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// --- loading the parser -----------------------------------------------------

const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'speckit-squads', 'pdv');

/**
 * The pinned oxc-parser's native binding in the nearest `node_modules` at or
 * above `base`, or null. A plain walk, not `Bun.resolveSync`: from a directory
 * with no `node_modules`, bun auto-installs whatever version the registry has.
 */
function pinned(base: string): string | null {
  for (let dir = base; ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'node_modules', OXC);
    try {
      const p = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')) as { version?: unknown };
      return p.version === OXC_VERSION ? path.join(pkg, 'src-js', 'bindings.js') : null;
    } catch { /* keep walking */ }
    if (dir === path.dirname(dir)) return null;
  }
}

/** The binding to load, installing the pinned version into the cache first if need be. */
function locateParser(): string {
  let entry = pinned(CACHE) ?? pinned(import.meta.dir);
  if (!entry) {
    try {
      fs.mkdirSync(CACHE, { recursive: true });
      if (!fs.existsSync(path.join(CACHE, 'package.json'))) fs.writeFileSync(path.join(CACHE, 'package.json'), '{"private":true}\n');
      Bun.spawnSync([process.execPath, 'add', '--silent', `${OXC}@${OXC_VERSION}`],
        { cwd: CACHE, stdout: 'ignore', stderr: 'ignore', timeout: 120_000 });
    } catch { /* reported below */ }
    entry = pinned(CACHE);
  }
  if (!entry) {
    throw new ScanError(3, `cannot scan TypeScript — ${OXC}@${OXC_VERSION} is not in ${CACHE} and ` +
      `\`bun add\` could not install it there. Run \`cd ${CACHE} && bun add ${OXC}@${OXC_VERSION}\` and re-run.`);
  }
  return entry;
}

async function loadParser(entry: string): Promise<Parse> {
  try {
    // The native binding, not the package entry: the entry eagerly loads its
    // raw-transfer and visitor modules (~130 ms), which Bun cannot use anyway —
    // raw transfer needs a >4 GiB ArrayBuffer and JavaScriptCore caps it. Safe
    // because the version is pinned; the selftest fails first if a bump moves it.
    const mod = (await import(entry)) as { parseSync: (f: string, t: string, o: object) => ReturnType<Parse> };
    return (f, t) => mod.parseSync(f, t, {});
  } catch (e) {
    throw new ScanError(3, `cannot scan TypeScript — ${OXC} failed to load: ${errMsg(e)}`);
  }
}

// --- rules ------------------------------------------------------------------

// Casts to these types are ordinary structural narrowing (built-ins, DOM/BOM,
// standard-library globals), NOT domain-brand forging — PDV004 ignores them.
// A cast to a project brand like `Email`/`UserId` is not in this set and still
// flags outside a parser module.
const IGNORE = new Set([
  // language / utility types
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Record', 'Readonly',
  'Partial', 'Required', 'Pick', 'Omit', 'Promise', 'Error', 'Function',
  'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt',
  'ArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint16Array',
  'Uint32Array', 'Float32Array', 'Float64Array',
  // DOM / BOM / web-platform globals
  'Node', 'Element', 'Event', 'EventTarget', 'Document', 'Window', 'Text',
  'Blob', 'File', 'FormData', 'URL', 'URLSearchParams', 'Headers', 'Request',
  'Response', 'FileList', 'DataTransfer', 'MouseEvent', 'KeyboardEvent',
  'PointerEvent', 'FocusEvent', 'InputEvent', 'DragEvent', 'TouchEvent',
  'CustomEvent', 'ErrorEvent', 'MessageEvent', 'Storage', 'Location',
]);
// Whole families of platform types that are always structural narrowing.
const IGNORE_PREFIX = /^(HTML|SVG|CSS|WebGL|Audio|Video|Media|Canvas|RTCP?|IDB)/;
const VALIDATOR = /^(is[A-Z]\w*|validate\w*|checkValid\w*)$/;

const isNode = (v: unknown): v is N =>
  typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
const child = (n: N, k: string): N | undefined => (isNode(n[k]) ? n[k] : undefined);
/** The type inside a `: T` annotation. */
const annotated = (n: N | undefined): N | undefined =>
  n ? child(n, 'typeAnnotation') : undefined;

/** Line starts as TypeScript counted them: CR, LF, CRLF, LS and PS. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
    if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) out.push(i + 1);
  }
  return out;
}

function scanFile(parseSync: Parse, file: JobFile, findings: Finding[]): void {
  let text: string;
  try {
    text = fs.readFileSync(file.path, 'utf8');
  } catch (e) {
    // Never skip silently: an unread file would drop out of the results and
    // read as a file with no findings.
    throw new ScanError(3, 'pdv_ts_scan: cannot read ' + file.path + ': ' + errMsg(e));
  }
  const r = parseSync(file.path, text);
  // A file that does not parse yields no tree to walk, which would read as a
  // file with no findings.
  if (r.errors.length) {
    throw new ScanError(3, `pdv_ts_scan: cannot parse ${file.path}: ${r.errors.map((e) => e.message).join('; ')}`);
  }
  // The program arrives as JSON. The package entry would also rebuild BigInt
  // and RegExp literal values; no rule reads a literal value, so that is skipped.
  const program = (JSON.parse(r.program) as { node: N }).node;

  const starts = lineStarts(text);
  const lineOf = (node: N): number => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= node.start) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const add = (rule: string, node: N): void => {
    findings.push({ rule, path: file.path, line: lineOf(node) });
  };
  const isUnknown = (t: N | undefined): boolean => t?.type === 'TSUnknownKeyword';

  // The name as written (a private `#isX` or a quoted `'isX'` keeps its sigil
  // or quotes, so neither reads as a validator name).
  const checkValidator = (name: N | undefined, fn: N | undefined): void => {
    if (name && fn && annotated(child(fn, 'returnType'))?.type === 'TSBooleanKeyword' &&
        VALIDATOR.test(text.slice(name.start, name.end))) {
      add('PDV003', name);
    }
  };

  const visit = (node: N, parent: N | undefined): void => {
    // PDV001 — the `any` type, wherever it appears (`: any`, `as any`, `T<any>`).
    if (node.type === 'TSAnyKeyword') add('PDV001', node);

    // PDV002 — JSON.parse whose result is not immediately typed `unknown`.
    const callee = node.type === 'CallExpression' ? child(node, 'callee') : undefined;
    if (callee?.type === 'MemberExpression' && !callee.computed) {
      const obj = child(callee, 'object'), prop = child(callee, 'property');
      if (obj?.type === 'Identifier' && obj.name === 'JSON' && prop?.name === 'parse') {
        const typedUnknown =
          (parent?.type === 'TSAsExpression' && isUnknown(child(parent, 'typeAnnotation'))) ||
          (parent?.type === 'VariableDeclarator' && isUnknown(annotated(annotated(child(parent, 'id')))));
        if (!typedUnknown) add('PDV002', node);
      }
    }

    // PDV003 — boolean validator (function decl, method, or arrow/fn expr).
    if (node.type === 'FunctionDeclaration' || node.type === 'TSDeclareFunction') {
      checkValidator(child(node, 'id'), node);
    }
    if (((node.type === 'MethodDefinition' || node.type === 'TSAbstractMethodDefinition') && node.kind === 'method') ||
        (node.type === 'Property' && node.method === true)) {
      checkValidator(child(node, 'key'), child(node, 'value'));
    }
    if (node.type === 'VariableDeclarator') {
      const init = child(node, 'init');
      if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
        checkValidator(child(node, 'id'), init);
      }
    }

    // PDV004 — brand cast (`x as Brand` / `<Brand>x`) outside a parser module.
    if (!file.isParser && (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion')) {
      const t = child(node, 'typeAnnotation'), name = t && child(t, 'typeName');
      if (t?.type === 'TSTypeReference' && name?.type === 'Identifier') {
        const n = String(name.name);
        if (!IGNORE.has(n) && !IGNORE_PREFIX.test(n)) add('PDV004', node);
      }
    }

    // for-in, not Object.entries: this loop runs once per node (a million on a
    // 10 MB corpus) and the entries arrays were most of the scan's time.
    for (const k in node) {
      const v = node[k];
      if (typeof v !== 'object' || v === null) continue;
      if (Array.isArray(v)) { for (const c of v) if (isNode(c)) visit(c, node); }
      else if (isNode(v)) visit(v, node);
    }
  };
  visit(program, undefined);
}

const STDIN_HINT =
  'pdv_ts_scan reads a JSON job on stdin — {"files":[{"path":"src/a.ts",' +
  '"isParser":false}]} — and ignores file arguments. It is not the entry ' +
  'point: run `parse_dont_validate.ts scan` instead.';

async function main(): Promise<void> {
  // Every path out of here that examined nothing exits non-zero. Printing
  // {"findings":[]} for a mis-invocation is what made a wrong call read
  // exactly like a clean scan.
  if (process.argv.length > 2) fail(2, STDIN_HINT);
  if (process.stdin.isTTY) fail(2, STDIN_HINT);

  let raw: string;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (e) {
    fail(2, 'pdv_ts_scan: cannot read stdin: ' + errMsg(e) + '\n' + STDIN_HINT);
  }
  if (!raw.trim()) fail(2, 'pdv_ts_scan: empty stdin.\n' + STDIN_HINT);

  let job: unknown;
  try {
    job = JSON.parse(raw);
  } catch (e) {
    fail(2, 'pdv_ts_scan: malformed JSON job on stdin: ' + errMsg(e) + '\n' +
            STDIN_HINT);
  }
  const rawFiles: unknown =
    typeof job === 'object' && job !== null ? (job as { files?: unknown }).files : undefined;
  if (!Array.isArray(rawFiles)) {
    fail(2, 'pdv_ts_scan: JSON job has no "files" array.\n' + STDIN_HINT);
  }
  if (rawFiles.length === 0) {
    fail(2, 'pdv_ts_scan: JSON job listed zero files — nothing was examined, ' +
            'which is not the same as a clean scan.');
  }

  const files: JobFile[] = [];
  for (const entry of rawFiles as unknown[]) {
    const p: unknown =
      typeof entry === 'object' && entry !== null ? (entry as { path?: unknown }).path : undefined;
    if (typeof p !== 'string') {
      fail(2, 'pdv_ts_scan: every entry of "files" needs a string "path".');
    }
    files.push({ path: p, isParser: (entry as { isParser?: unknown }).isParser });
  }

  let findings: Finding[];
  try {
    const entry = locateParser();
    // Chunks across worker threads: each parse is native, but turning its JSON
    // into objects and walking them is JS, and that is most of a big job. A
    // small job stays on this thread, where a worker's startup would dominate.
    const n = Math.min(os.availableParallelism(), Math.floor(files.length / CHUNK_MIN));
    if (n < 2) {
      findings = scanFiles(await loadParser(entry), files);
    } else {
      const size = Math.ceil(files.length / n);
      const chunks = Array.from({ length: n }, (_, i) => files.slice(i * size, (i + 1) * size));
      findings = (await Promise.all(chunks.map((chunk) => inWorker(entry, chunk)))).flat();
    }
  } catch (e) {
    if (e instanceof ScanError) fail(e.code, e.message);
    throw e;
  }
  process.stdout.write(JSON.stringify({ findings }));
}

const CHUNK_MIN = 50; // files per worker below which a worker costs more than it saves

function scanFiles(parseSync: Parse, files: JobFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) scanFile(parseSync, file, findings);
  return findings;
}

type Reply = { findings: Finding[] } | { error: { code: number; message: string } };

function inWorker(entry: string, files: JobFile[]): Promise<Finding[]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(import.meta.path, { workerData: { entry, files } });
    w.once('message', (r: Reply) => {
      void w.terminate();
      if ('error' in r) reject(new ScanError(r.error.code, r.error.message));
      else resolve(r.findings);
    });
    w.once('error', reject);
  });
}

if (isMainThread) {
  await main();
} else {
  const { entry, files } = workerData as { entry: string; files: JobFile[] };
  let reply: Reply;
  try {
    reply = { findings: scanFiles(await loadParser(entry), files) };
  } catch (e) {
    reply = { error: e instanceof ScanError ? { code: e.code, message: e.message } : { code: 3, message: errMsg(e) } };
  }
  parentPort?.postMessage(reply);
}
