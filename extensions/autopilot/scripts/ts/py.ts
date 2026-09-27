/**
 * Python-semantics helpers for the autopilot scripts' TypeScript port.
 *
 * `preflight-issues.ts` and `stream-decode.ts` were Python, and their output is a
 * contract: `PICK:`/`SKIP:` lines a wrapper greps, and a log whose exact shape
 * people read. The port is required to be byte-for-byte equivalent, and the
 * places JavaScript's built-ins quietly disagree with Python are exactly the
 * places that break that:
 *
 *   * `JSON.parse` reorders integer-like object keys, rejects `NaN`/`Infinity`,
 *     loses the int/float distinction (`1.0` prints as `1`), and words its errors
 *     differently — so `pyJsonLoads` is a port of CPython's `_json` scanner,
 *     including its error messages and positions.
 *   * `\s`, `.trim()` and `.split(/\s+/)` use a different whitespace set than
 *     `str.strip()`/`str.split()`; `.split(/\n/)` is not `str.splitlines()`.
 *   * String length and slicing count UTF-16 units, Python counts code points.
 *   * `toFixed` rounds exact ties up, Python's `format(x, ".1f")` rounds them to
 *     even (`1.25` → `1.2`), and `String(1e16)` is not `repr(1e16)`.
 *   * `str(x)` of a container is Python's repr, not `String(x)`.
 */

// ------------------------------------------------------------------ values ---

/** A JSON number that Python would have parsed as a `float`. */
export class PyFloat {
  constructor(readonly v: number) {}
}
export type PyDict = Map<string, PyValue>;
export type PyValue = null | boolean | number | bigint | PyFloat | string | PyValue[] | PyDict;

/** A Python exception, carried so the message reads the way Python's did. */
export class PyError extends Error {
  constructor(readonly pyName: string, message: string) {
    super(message);
  }
}

export function isDict(v: unknown): v is PyDict {
  return v instanceof Map;
}

export function pyType(v: PyValue): string {
  if (v === null) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number" || typeof v === "bigint") return "int";
  if (v instanceof PyFloat) return "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  return "dict";
}

export function pyTruthy(v: PyValue | undefined): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "bigint") return v !== 0n;
  if (v instanceof PyFloat) return v.v !== 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
  return v.size > 0;
}

/** Python's `a or b`. */
export function pyOr(a: PyValue | undefined, b: PyValue): PyValue {
  return pyTruthy(a) ? (a as PyValue) : b;
}

/** `d.get(key, default)` — AttributeError when `d` is not a dict, as in Python. */
export function pyGet(d: PyValue, key: string, dflt: PyValue = null): PyValue {
  if (!isDict(d)) throw new PyError("AttributeError", `'${pyType(d)}' object has no attribute 'get'`);
  return d.has(key) ? (d.get(key) as PyValue) : dflt;
}

/** `d[key]` on a dict — KeyError / TypeError the way Python raises them. */
export function pyItem(d: PyValue, key: string): PyValue {
  if (isDict(d)) {
    if (!d.has(key)) throw new PyError("KeyError", strRepr(key));
    return d.get(key) as PyValue;
  }
  if (typeof d === "string") throw new PyError("TypeError", "string indices must be integers, not 'str'");
  if (Array.isArray(d)) throw new PyError("TypeError", "list indices must be integers or slices, not str");
  throw new PyError("TypeError", `'${pyType(d)}' object is not subscriptable`);
}

/** Require a `str` receiver for a method call such as `.strip()`. */
export function asStr(v: PyValue, method: string): string {
  if (typeof v === "string") return v;
  throw new PyError("AttributeError", `'${pyType(v)}' object has no attribute '${method}'`);
}

export function pyLen(v: PyValue): number {
  if (typeof v === "string") return cpLen(v);
  if (Array.isArray(v)) return v.length;
  if (isDict(v)) return v.size;
  throw new PyError("TypeError", `object of type '${pyType(v)}' has no len()`);
}

/** What `for x in v` walks: list items, dict keys, string characters. */
export function pyIter(v: PyValue): PyValue[] {
  if (Array.isArray(v)) return v;
  if (isDict(v)) return [...v.keys()];
  if (typeof v === "string") return Array.from(v);
  throw new PyError("TypeError", `'${pyType(v)}' object is not iterable`);
}

/** Numeric value for `==`/hash purposes (True == 1 == 1.0), or null. */
export function pyNum(v: PyValue | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof PyFloat) return v.v;
  return null;
}

/** Python `==` for the scalar cases these scripts compare. */
export function pyEq(a: PyValue, b: PyValue): boolean {
  const na = pyNum(a), nb = pyNum(b);
  if (na !== null || nb !== null) return na !== null && nb !== null && na === nb;
  return a === b;
}

/** A dict/set key with Python's equality (1 == 1.0 == True); throws on unhashable. */
export function pyHashKey(v: PyValue, kind = "dict key"): string {
  if (v === null) return "N";
  if (typeof v === "string") return "s" + v;
  const n = pyNum(v);
  if (n !== null) return "n" + String(n);
  throw new PyError("TypeError", `cannot use '${pyType(v)}' as a ${kind} (unhashable type: '${pyType(v)}')`);
}

// ------------------------------------------------------------------ strings ---

/** Python's `str.isspace()` set — also what `\s` means in a Python `str` regex. */
export const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${WS}]+`, "g");
const WS_LEAD = new RegExp(`^[${WS}]+`);
const WS_TRAIL = new RegExp(`[${WS}]+$`);

export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** `s[start:end]` counting code points; a negative `start` counts from the end. */
export function cpSlice(s: string, start: number, end?: number): string {
  const cps = Array.from(s);
  return cps.slice(start, end).join("");
}

function escapeClass(chars: string): string {
  return chars.replace(/[\\\]\[^-]/g, (c) => "\\" + c);
}

/** `s.strip()` / `s.strip(chars)`. */
export function pyStrip(s: string, chars?: string): string {
  return pyRstrip(pyLstrip(s, chars), chars);
}

export function pyLstrip(s: string, chars?: string): string {
  if (chars === undefined) return s.replace(WS_LEAD, "");
  if (!chars) return s;
  return s.replace(new RegExp(`^[${escapeClass(chars)}]+`, "u"), "");
}

export function pyRstrip(s: string, chars?: string): string {
  if (chars === undefined) return s.replace(WS_TRAIL, "");
  if (!chars) return s;
  return s.replace(new RegExp(`[${escapeClass(chars)}]+$`, "u"), "");
}

/** `s.split()` — whitespace runs, no empty fields. */
export function pySplit(s: string): string[] {
  const t = pyStrip(s);
  return t ? t.split(WS_RUN) : [];
}

/** `s.splitlines()` — every Python line boundary, no trailing empty line. */
export function pySplitlines(s: string): string[] {
  if (!s) return [];
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** `str.zfill(width)`. */
export function pyZfill(s: string, width: number): string {
  const sign = s[0] === "-" || s[0] === "+" ? s[0] : "";
  const body = sign ? s.slice(1) : s;
  const pad = Math.max(0, width - cpLen(s));
  return sign + "0".repeat(pad) + body;
}

/** `f"{s:<width}"`. */
export function pyLjust(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - cpLen(s)));
}

const NON_PRINTABLE = /[\p{C}\p{Z}]/u;

/** `repr(s)` for a str. */
export function strRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === q || ch === "\\") out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch !== " " && NON_PRINTABLE.test(ch)) {
      if (cp < 0x100) out += "\\x" + cp.toString(16).padStart(2, "0");
      else if (cp < 0x10000) out += "\\u" + cp.toString(16).padStart(4, "0");
      else out += "\\U" + cp.toString(16).padStart(8, "0");
    } else out += ch;
  }
  return out + q;
}

/** `repr(x)` for a float. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant = "0", expStr = "0"] = Math.abs(x).toExponential().split("e");
  const digits = mant.replace(".", "");
  const exp = Number(expStr);
  let s: string;
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
      s = intPart + "." + (digits.slice(exp + 1) || "0");
    } else {
      s = "0." + "0".repeat(-exp - 1) + digits;
    }
  } else {
    s = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") +
      "e" + (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
  }
  return sign + s;
}

/** `repr(x)`. */
export function pyRepr(v: PyValue): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (v instanceof PyFloat) return floatRepr(v.v);
  if (typeof v === "string") return strRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  return "{" + [...v].map(([k, x]) => `${strRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
}

/** `str(x)` — what an f-string interpolates. */
export function pyStr(v: PyValue): string {
  return typeof v === "string" ? v : pyRepr(v);
}

/** `int(s)` for base 10 — ValueError worded as Python words it. */
export function pyInt(s: string): number {
  const t = pyStrip(s);
  if (!/^[+-]?\d+(?:_\d+)*$/.test(t)) {
    throw new PyError("ValueError", `invalid literal for int() with base 10: ${strRepr(s)}`);
  }
  return Number(t.replace(/_/g, ""));
}

// ---------------------------------------------------------------- numbers ---

/** `format(x, f".{digits}f")` — correctly rounded, exact ties to even. */
export function pyFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  // An exact tie at `digits` places means ax = odd / 2^(digits+1) exactly.
  // Multiplying by a power of two is exact, so this test is too.
  const y = ax * 2 ** (digits + 1);
  let body: string;
  if (Number.isInteger(y) && y % 2 === 1 && Number.isSafeInteger(y)) {
    const scaled = BigInt(y) * 5n ** BigInt(digits); // = 2 * ax * 10^digits, odd
    let n = (scaled - 1n) / 2n; // floor(ax * 10^digits)
    if (n % 2n === 1n) n += 1n;
    const s = n.toString().padStart(digits + 1, "0");
    body = digits ? s.slice(0, s.length - digits) + "." + s.slice(s.length - digits) : s;
  } else if (ax >= 1e21) {
    // Integral at this magnitude; toFixed would switch to exponent notation.
    body = BigInt(ax).toString() + (digits ? "." + "0".repeat(digits) : "");
  } else {
    body = ax.toFixed(digits);
  }
  return (neg ? "-" : "") + body;
}

/**
 * Strict UTF-8 decode — `bytes.decode("utf-8")` — raising Python's
 * `UnicodeDecodeError` wording (`'utf-8' codec can't decode byte 0xff in
 * position 1: invalid start byte`) rather than the platform's.
 */
export function pyDecodeUtf8(buf: Uint8Array): string {
  const n = buf.length;
  const fail = (start: number, end: number, reason: string): never => {
    const where = end > start
      ? `bytes in position ${start}-${end}`
      : `byte 0x${(buf[start] as number).toString(16).padStart(2, "0")} in position ${start}`;
    throw new PyError("UnicodeDecodeError", `'utf-8' codec can't decode ${where}: ${reason}`);
  };
  for (let i = 0; i < n;) {
    const b = buf[i] as number;
    if (b < 0x80) {
      i++;
      continue;
    }
    let need: number, lo = 0x80, hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lo = 0xa0;
      if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lo = 0x90;
      if (b === 0xf4) hi = 0x8f;
    } else return fail(i, i, "invalid start byte");
    for (let k = 1; k <= need; k++) {
      const j = i + k;
      if (j >= n) return fail(i, j - 1, "unexpected end of data");
      const c = buf[j] as number;
      const ok = k === 1 ? c >= lo && c <= hi : c >= 0x80 && c <= 0xbf;
      if (!ok) return fail(i, j - 1, "invalid continuation byte");
    }
    i += need + 1;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
}

// ------------------------------------------------------------------- json ---

/** `json.JSONDecodeError`, message formatted exactly as CPython formats it. */
export class JSONDecodeError extends PyError {
  constructor(msg: string, doc: string, pos: number) {
    const cpPos = cpLen(doc.slice(0, pos));
    const before = doc.slice(0, pos);
    const lineno = (before.match(/\n/g) || []).length + 1;
    const nl = before.lastIndexOf("\n");
    const colno = nl < 0 ? cpPos + 1 : cpPos - cpLen(doc.slice(0, nl));
    super("JSONDecodeError", `${msg}: line ${lineno} column ${colno} (char ${cpPos})`);
  }
}

class StopIter {
  constructor(readonly idx: number) {}
}

/** `json.loads(s)` — a port of CPython's C scanner (`Modules/_json.c`). */
export function pyJsonLoads(s: string): PyValue {
  if (s.startsWith("﻿")) {
    throw new JSONDecodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)", s, 0);
  }
  const len = s.length;
  const ws = (i: number): number => {
    while (i < len) {
      const c = s.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
    return i;
  };
  const isDigit = (i: number): boolean => {
    const c = s.charCodeAt(i);
    return c >= 0x30 && c <= 0x39;
  };

  const scanstring = (end: number): [string, number] => {
    const begin = end - 1;
    let out = "";
    for (;;) {
      let next = end;
      let c = -1;
      for (; next < len; next++) {
        c = s.charCodeAt(next);
        if (c === 0x22 || c === 0x5c) break;
        if (c <= 0x1f) throw new JSONDecodeError("Invalid control character at", s, next);
      }
      if (!(c === 0x22 || c === 0x5c) || next >= len) {
        throw new JSONDecodeError("Unterminated string starting at", s, begin);
      }
      out += s.slice(end, next);
      if (c === 0x22) return [out, next + 1];
      next++;
      if (next === len) throw new JSONDecodeError("Unterminated string starting at", s, begin);
      const e = s[next];
      if (e !== "u") {
        end = next + 1;
        const map: Record<string, string> = {
          '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
        };
        const m = e === undefined ? undefined : map[e];
        if (m === undefined) throw new JSONDecodeError("Invalid \\escape", s, end - 2);
        out += m;
      } else {
        next++;
        end = next + 4;
        if (end >= len) throw new JSONDecodeError("Invalid \\uXXXX escape", s, next - 1);
        const hex = (from: number, to: number): number => {
          const h = s.slice(from, to);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new JSONDecodeError("Invalid \\uXXXX escape", s, to - 4);
          return parseInt(h, 16);
        };
        let cp = hex(next, end);
        if (cp >= 0xd800 && cp <= 0xdbff && end + 6 < len && s[end] === "\\" && s[end + 1] === "u") {
          const c2 = hex(end + 2, end + 6);
          if (c2 >= 0xdc00 && c2 <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (c2 - 0xdc00);
            end += 6;
          }
        }
        out += String.fromCodePoint(cp);
      }
    }
  };

  const number = (start: number): [PyValue, number] => {
    let idx = start;
    if (s[idx] === "-") {
      idx++;
      if (idx >= len) throw new StopIter(start);
    }
    const c = s.charCodeAt(idx);
    if (c >= 0x31 && c <= 0x39) {
      idx++;
      while (idx < len && isDigit(idx)) idx++;
    } else if (c === 0x30) {
      idx++;
    } else {
      throw new StopIter(start);
    }
    let isFloat = false;
    if (idx < len - 1 && s[idx] === "." && isDigit(idx + 1)) {
      isFloat = true;
      idx += 2;
      while (idx < len && isDigit(idx)) idx++;
    }
    if (idx < len - 1 && (s[idx] === "e" || s[idx] === "E")) {
      const eStart = idx;
      idx++;
      if (idx < len - 1 && (s[idx] === "-" || s[idx] === "+")) idx++;
      const dStart = idx;
      while (idx < len && isDigit(idx)) idx++;
      if (idx > dStart) isFloat = true;
      else idx = eStart;
    }
    const text = s.slice(start, idx);
    if (isFloat) return [new PyFloat(Number(text)), idx];
    const n = Number(text);
    return [Number.isSafeInteger(n) ? (Object.is(n, -0) ? 0 : n) : BigInt(text), idx];
  };

  const scanOnce = (idx: number): [PyValue, number] => {
    if (idx >= len) throw new StopIter(idx);
    const c = s[idx];
    if (c === '"') return scanstring(idx + 1);
    if (c === "{") return object(idx + 1);
    if (c === "[") return array(idx + 1);
    if (s.startsWith("null", idx)) return [null, idx + 4];
    if (s.startsWith("true", idx)) return [true, idx + 4];
    if (s.startsWith("false", idx)) return [false, idx + 5];
    if (s.startsWith("NaN", idx)) return [new PyFloat(NaN), idx + 3];
    if (s.startsWith("Infinity", idx)) return [new PyFloat(Infinity), idx + 8];
    if (s.startsWith("-Infinity", idx)) return [new PyFloat(-Infinity), idx + 9];
    return number(idx);
  };

  const value = (idx: number): [PyValue, number] => {
    try {
      return scanOnce(idx);
    } catch (e) {
      if (e instanceof StopIter) throw new JSONDecodeError("Expecting value", s, e.idx);
      throw e;
    }
  };

  const object = (start: number): [PyValue, number] => {
    const d: PyDict = new Map();
    let idx = ws(start);
    if (idx >= len || s[idx] !== "}") {
      for (;;) {
        if (idx >= len || s[idx] !== '"') {
          throw new JSONDecodeError("Expecting property name enclosed in double quotes", s, idx);
        }
        let key: string;
        [key, idx] = scanstring(idx + 1);
        idx = ws(idx);
        if (idx >= len || s[idx] !== ":") throw new JSONDecodeError("Expecting ':' delimiter", s, idx);
        idx = ws(idx + 1);
        let val: PyValue;
        [val, idx] = value(idx);
        d.set(key, val);
        idx = ws(idx);
        if (idx < len && s[idx] === "}") break;
        if (idx >= len || s[idx] !== ",") throw new JSONDecodeError("Expecting ',' delimiter", s, idx);
        const comma = idx;
        idx = ws(idx + 1);
        if (idx < len && s[idx] === "}") {
          throw new JSONDecodeError("Illegal trailing comma before end of object", s, comma);
        }
      }
    }
    return [d, idx + 1];
  };

  const array = (start: number): [PyValue, number] => {
    const a: PyValue[] = [];
    let idx = ws(start);
    if (idx >= len || s[idx] !== "]") {
      for (;;) {
        let val: PyValue;
        [val, idx] = value(idx);
        a.push(val);
        idx = ws(idx);
        if (idx < len && s[idx] === "]") break;
        if (idx >= len || s[idx] !== ",") throw new JSONDecodeError("Expecting ',' delimiter", s, idx);
        const comma = idx;
        idx = ws(idx + 1);
        if (idx < len && s[idx] === "]") {
          throw new JSONDecodeError("Illegal trailing comma before end of array", s, comma);
        }
      }
    }
    return [a, idx + 1];
  };

  const [obj, end0] = value(ws(0));
  const end = ws(end0);
  if (end !== len) throw new JSONDecodeError("Extra data", s, end);
  return obj;
}

/** `json.dumps(v)` with Python's defaults: `", "`/`": "` separators, ensure_ascii. */
export function pyJsonDumps(v: PyValue): string {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (v instanceof PyFloat) {
    if (Number.isNaN(v.v)) return "NaN";
    if (!Number.isFinite(v.v)) return v.v > 0 ? "Infinity" : "-Infinity";
    return floatRepr(v.v);
  }
  if (typeof v === "string") return jsonStr(v);
  if (Array.isArray(v)) return "[" + v.map(pyJsonDumps).join(", ") + "]";
  return "{" + [...v].map(([k, x]) => `${jsonStr(k)}: ${pyJsonDumps(x)}`).join(", ") + "}";
}

function jsonStr(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    const c = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || c > 0x7e) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

// ------------------------------------------------------------------ stdout ---

import { writeSync } from "node:fs";

/** Unbuffered write to fd 1 — `print(..., flush=True)`. */
export function writeOut(text: string): void {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue;
      throw e;
    }
  }
}
