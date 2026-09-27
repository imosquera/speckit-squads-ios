// diff-minimal preset: shared parsing for the two scope checkers.
//
// One job: read the machine-checkable half of a spec's `## Scope discipline`
// section out of a `spec.md`. Both `check-scope-sections.ts` (does the section
// exist and say anything) and `check-plan-scope.ts` (does a later artifact touch
// what it forbade) parse the same shape, so the shape is spelled once here.
//
// The shape it parses:
//
//     ## Scope discipline
//
//     **MUST NOT touch:**
//
//     - `path/or/glob` — reason
//     - `another/path`
//
//     **Scope justification:** <only when the change is inherently wide>
//
// Ported from scope-common.py. Semantics are held to the Python original, so a
// few helpers (splitLines, strip, pyPath) reproduce Python behaviour rather than
// JavaScript's nearest equivalent.

import { readFileSync } from "node:fs";

// Python's `str.isspace()` set, which is what its `\s`/`strip()` use. JS `\s`
// differs at the edges (it adds U+FEFF and lacks U+001C-U+001F).
const WS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export const S = `[${WS}]`;
const NS = `[^${WS}]`;

export const strip = (s: string): string => s.replace(new RegExp(`^${S}+|${S}+$`, "g"), "");
export const rstrip = (s: string): string => s.replace(new RegExp(`${S}+$`), "");
const stripChars = (s: string, chars: string): string => {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
};

/** Python's `str.splitlines()`: every line boundary it knows, no trailing empty entry. */
export function splitLines(text: string): string[] {
  const out = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Python's `pathlib.Path(p)` string form: redundant `/`, `.` segments and trailing `/` dropped. */
export function pyPath(p: string): string {
  const lead = p.startsWith("//") && !p.startsWith("///") ? "//" : p.startsWith("/") ? "/" : "";
  const parts = p.split("/").filter((x) => x !== "" && x !== ".");
  const body = parts.join("/");
  return lead + body || ".";
}

/** Python's `Path.read_text().splitlines()`. */
export const readLines = (path: string): string[] => splitLines(readFileSync(path, "utf8"));

// A heading at any level: (level, title)
export const HEADING = new RegExp(`^(#{1,6})${S}+(.+?)${S}*$`);
export const BULLET = new RegExp(`^${S}*[-*+]${S}+(.*)$`);

export const CORRECTIONS_TITLE = /^corrections to the issue as filed$/i;
export const SCOPE_TITLE = /^scope discipline$/i;
export const MUST_NOT_MARKER = new RegExp(`must${S}+not${S}+touch`, "i");
export const JUSTIFICATION_MARKER = new RegExp(`scope${S}+justification`, "i");

// An explicit "the issue was right" answer. Without this a spec that legitimately
// has no corrections has to invent one, which is worse than no rule at all.
// The trailing lookahead is Python's Unicode `\b` (JS `\b` is ASCII-only).
export const NONE_ANSWER = new RegExp(
  `^${S}*(?:[-*+]${S}+)?(?:\\*{0,2}|_{0,2})none[.!]?(?:\\*{0,2}|_{0,2})(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])`,
  "iu",
);

export type Heading = [level: number, title: string];

/** (level, title) for a heading line, else null. */
export function heading(line: string): Heading | null {
  const m = HEADING.exec(line);
  return m ? [m[1]!.length, m[2]!] : null;
}

/**
 * Body lines of the first section whose title matches, else null.
 *
 * A section runs from its heading to the next heading of the same or a
 * shallower level, or EOF — the same boundary rule spec-minimal's stripper
 * uses, so the two presets agree on where a section ends.
 */
export function section(lines: string[], titleRe: RegExp): string[] | null {
  for (let i = 0; i < lines.length; i++) {
    const h = heading(lines[i]!);
    if (!h || !titleRe.test(h[1])) continue;
    const level = h[0];
    const body: string[] = [];
    for (const line of lines.slice(i + 1)) {
      const hh = heading(line);
      if (hh && hh[0] <= level) break;
      body.push(line);
    }
    return body;
  }
  return null;
}

// A line that starts something of its own, so it never folds into its predecessor.
const MARKER_LINE = new RegExp(`^${S}*\\*{2}[^*]+\\*{2}${S}*:?${S}*$`);
export const FENCE = new RegExp(`^${S}*(?:\`\`\`|~~~)`);
// Ordered-list items, blockquote lines, table rows and thematic breaks are each
// their own line of markdown. Folding them into their predecessor merged whole
// numbered plans and whole tables into one entry, which both misreported the
// line number and — worse — let a negation anywhere in the block exempt every
// forbidden path in it.
const OTHER_BLOCK = new RegExp(
  `^${S}*(?:\\d+[.)]${S}+|>|\\||-{3,}${S}*$|={3,}${S}*$|\\*{3,}${S}*$|_{3,}${S}*$)`,
);

const opensBlock = (line: string): boolean =>
  HEADING.test(line) || BULLET.test(line) || MARKER_LINE.test(line) || OTHER_BLOCK.test(line);

/**
 * Only a list item or a `**marker:**` line can have a wrapped tail.
 *
 * Narrow on purpose: see `logicalLines`. Anything wider merges independent
 * prose sentences, and one sentence's negation then exempts the next
 * sentence's forbidden path.
 */
const acceptsContinuation = (line: string): boolean => BULLET.test(line) || MARKER_LINE.test(line);

export type LogicalLine = [lineno: number, text: string];

/**
 * [(lineno, text)] with wrapped continuations folded into what they continue.
 *
 * The artifacts these checkers read are prose, and every editor wraps prose.
 * Matching physical lines meant a bullet that wrapped ended the MUST-NOT list
 * at its first continuation line — 9 forbidden paths silently became 1, and
 * the gate passed (issue #68). A wrapped bullet is one bullet.
 *
 * Only a BULLET or a `**marker:**` line absorbs a continuation — plus whatever
 * has already been folded onto one. Every other line, prose included, stands
 * alone. Letting any non-blank line absorb its successor merged two sentences
 * of one paragraph into a single logical line, and a negation in the first
 * sentence then exempted a forbidden path named in the second — a real
 * violation silently passing `check-plan-scope.ts`, which is worse than the
 * truncation issue #68 fixed. Both of #68's defects were wrapped BULLETS
 * (a truncated `MUST NOT touch:` list, a restatement bullet losing its
 * negation); prose never needed folding.
 *
 * A continuation is a non-blank line that does not itself open something (see
 * `opensBlock`); a blank line closes the block, and nothing inside a ```
 * fence ever folds. `lineno` is the line the block STARTED on, so a report
 * still points at the bullet rather than at its tail.
 *
 * `opensBlock`'s ordered items, blockquotes and table rows are belt-and-
 * braces now that only bullets fold, but they still earn their keep for a
 * numbered list or a table written directly under a bullet.
 */
export function logicalLines(lines: string[], start = 1): LogicalLine[] {
  const out: LogicalLine[] = [];
  let inFence = false;
  let accepting = false; // does out[-1] take a wrapped continuation?
  lines.forEach((line, i) => {
    const n = i + start;
    // Code is not prose: nothing inside a fence wraps, so a fenced line is
    // always its own entry and never absorbs the line after the fence.
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push([n, line]);
      accepting = false;
      return;
    }
    if (inFence || !strip(line)) {
      out.push([n, line]);
      accepting = false;
      return;
    }
    if (accepting && !opensBlock(line)) {
      const last = out[out.length - 1]!;
      last[1] = rstrip(last[1]) + " " + strip(line);
      // The folded block keeps taking further wrapped lines: a bullet may
      // wrap onto three physical lines as readily as two.
      return;
    }
    out.push([n, line]);
    accepting = acceptsContinuation(line);
  });
  return out;
}

/** True when a section body says anything at all (blank lines don't count). */
export const hasContent = (body: string[] | null): boolean => (body ?? []).some((l) => strip(l) !== "");

/**
 * The path a MUST-NOT bullet names, else null.
 *
 * Whichever candidate comes FIRST in the text wins — a backticked token (the
 * documented spelling) or a path-shaped bare one (the fallback, so a spec that
 * forgot the backticks is still checked rather than silently passing). Ties go
 * to the backticks, so a bullet that opens with a backticked path is unchanged.
 *
 * Position, not preference, because the bullet's wrapped tail is now part of
 * this text: preferring backticks unconditionally made a bare-spelled bullet
 * return a backticked path out of its own prose, inverting enforcement — the
 * forbidden path passes and a permitted one is blocked.
 */
export function bulletPath(text: string): string | null {
  let best: [number, string] | null = null;
  const m = /`([^`]+)`/.exec(text);
  if (m) best = [m.index, strip(m[1]!)];
  for (const tm of text.matchAll(new RegExp(`${NS}+`, "g"))) {
    if (best && tm.index >= best[0]) break;
    const token = stripChars(tm[0], ".,;:()[]\"'");
    // A token carrying a backtick belongs to the backticked candidate above.
    if (!token || token.includes("`")) continue;
    if (token.includes("/") || token.startsWith("*") || /\.[A-Za-z0-9]{1,6}$/.test(token)) return token;
  }
  return best ? best[1] : null;
}

/**
 * Every path listed under a `MUST NOT touch` marker in `## Scope discipline`.
 *
 * Returns [] when the section is absent — the caller decides whether that is a
 * failure, because the two checkers answer that differently.
 */
export function mustNotPaths(lines: string[]): string[] {
  const body = section(lines, SCOPE_TITLE);
  if (body === null) return [];
  const paths: string[] = [];
  let collecting = false;
  for (const [, line] of logicalLines(body)) {
    if (MUST_NOT_MARKER.test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (!strip(line)) continue;
    const m = BULLET.exec(line);
    // A non-bullet, non-blank line ends the list (e.g. the justification
    // paragraph, or free prose after it).
    if (!m) break;
    if (NONE_ANSWER.test(line)) continue;
    const p = bulletPath(m[1]!);
    if (p) paths.push(p);
  }
  return paths;
}

/**
 * Compile a listed path into a substring regex.
 *
 * `**` spans directory separators, a lone `*` does not — glob semantics, so a
 * spec can forbid `infra/**` without also forbidding `infrastructure`.
 * Trailing `/` means "this directory and everything under it".
 */
export function pathPattern(path: string): RegExp {
  let p = rstrip(path);
  if (p.endsWith("/")) p += "**";
  let out = "";
  const chars = Array.from(p);
  for (let i = 0; i < chars.length; ) {
    if (chars[i] === "*" && chars[i + 1] === "*") {
      out += ".*";
      i += 2;
    } else if (chars[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else {
      out += chars[i]!.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(out, "u");
}
