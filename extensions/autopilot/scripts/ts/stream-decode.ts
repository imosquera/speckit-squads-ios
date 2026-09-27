#!/usr/bin/env bun
/**
 * Decode Claude Code's `--output-format stream-json` into compact, human-readable
 * log lines, flushing each so `tail -f` shows a live pass.
 *
 * Read from STDIN (the pipe from `claude`), never from a heredoc — invoke as
 * `claude … --output-format stream-json --verbose | bun stream-decode.ts`.
 *
 * The stream is one JSON object per line. We surface the parts a human watching a log
 * cares about — assistant text, tool calls, tool results (truncated), subagent
 * start/finish, and the final result — and pass through anything unrecognized (incl.
 * stderr noise) verbatim so nothing is silently lost.
 *
 * Two properties the log depends on, both of which read straight off the stream:
 *
 *   * Honest timestamps. Every `assistant`/`user` event carries its own `timestamp`;
 *     we stamp the line with THAT, not with the wall clock at decode time. Events
 *     arrive in buffered bursts, so the decode-time clock collapsed a batch of turns
 *     minutes apart onto one second and printed them in an order that implied a
 *     history that never happened (the oldest statement printed last). Only events
 *     that genuinely lack a timestamp (`result`, some `system` frames) fall back to
 *     now, and those are stamped `~HH:MM:SS` so a reader can tell.
 *
 *   * Attribution. Once a pass fans out to subagents, interleaved lines are
 *     meaningless without knowing who spoke. `parent_tool_use_id` names the Task
 *     tool call that owns each line (null = the main session, which gets no tag);
 *     `system/task_started` gives us `subagent_type`/`description` for that same id,
 *     so lines read `[review-tests]` rather than `[sub:a1b2c3]`.
 *
 * Ported from `stream-decode.py` with byte-identical output: the Python semantics
 * it relied on (json key order, `json.dumps` spacing and ASCII escaping, `str()`
 * of containers, float formatting, universal newlines) come from `./py.ts`.
 */
import {
  PyError, PyFloat, type PyValue,
  asStr, cpLen, cpSlice, isDict, pyFixed, pyGet, pyHashKey, pyItem, pyIter, pyJsonDumps,
  pyJsonLoads, pyLen, pyLjust, pyNum, pyOr, pyRstrip, pySplit, pyStr, pyStrip, pyTruthy,
  pyType, JSONDecodeError, writeOut,
} from "./py.ts";

const MAX = 220; // truncate long blobs so the log stays scannable
const INDENT = " ".repeat(20); // continuation/detail lines align under the message column

// tool_use_id -> attribution, learned from task_started / subagent-tagged events.
// Keyed by Python hash equality, so `1`, `1.0` and `True` are one id as they were.
const _subtypes = new Map<string, string>(); // tool_use_id -> subagent_type   (authoritative)
const _descs = new Map<string, string>(); // tool_use_id -> slugged description (fallback)
const _task_ids = new Map<string, PyValue>(); // task_id -> tool_use_id (task_notification may carry only task_id)
const _aliased = new Set<string>(); // ids whose desc-derived tag we already reconciled with its type

function clip(s: PyValue, limit = MAX): string {
  const t = pySplit(pyStr(s)).join(" "); // collapse whitespace/newlines to one line
  return cpLen(t) <= limit ? t : cpSlice(t, 0, limit) + " …";
}

function slug(s: PyValue, limit = 18): string {
  const t = pyStrip(pyStr(s).toLowerCase().replace(/[^a-z0-9]+/g, "-"), "-");
  return pyRstrip(cpSlice(t, 0, limit), "-");
}

/**
 * Record what we know about a subagent's owning tool call. Called from
 * task_started and from any child event that names its own subagent_type.
 */
function remember(tool_use_id: PyValue, subagent_type: PyValue = null, description: PyValue = null): void {
  if (!pyTruthy(tool_use_id)) return;
  const key = pyHashKey(tool_use_id);
  if (pyTruthy(subagent_type)) {
    const neu = slug(subagent_type);
    const old = _descs.get(key);
    // task_started only carries a description, so the first lines for a
    // subagent may be tagged with its slugged description and later ones with
    // its type. Say so once, rather than leaving two tags for one agent.
    if (old && old !== neu && !_aliased.has(key)) {
      _aliased.add(key);
      emit("≡", "", `= [${old}]`, { cont: true, tag: neu });
    }
    _subtypes.set(key, neu);
  }
  if (pyTruthy(description) && !_descs.has(key)) {
    const d = slug(description);
    if (d) _descs.set(key, d);
  }
}

/** Short, stable tag for a subagent. null for the main session. */
function label_for(tool_use_id: PyValue): string | null {
  if (!pyTruthy(tool_use_id)) return null;
  const key = pyHashKey(tool_use_id);
  return _subtypes.get(key) || _descs.get(key) || "sub:" + cpSlice(pyStr(tool_use_id), -6);
}

const two = (n: number): string => String(n).padStart(2, "0");
const hms = (d: Date): string => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

/** Round half to even, as CPython's timestamp → microsecond conversion does. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** `datetime.fromtimestamp(secs).strftime("%H:%M:%S")`, or null where Python raised. */
function fromTimestamp(secs: number): string | null {
  if (!Number.isFinite(secs)) return null;
  let t = Math.trunc(secs);
  const us = roundHalfEven((secs - t) * 1e6);
  if (us >= 1e6) t += 1;
  else if (us < 0) t -= 1;
  const d = new Date(t * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  if (y < 1 || y > 9999) return null;
  return hms(d);
}

function daysInMonth(y: number, m: number): number {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return m === 2 ? (leap ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
}

/** Monday of ISO week 1 of `y`, as [y, m, d] shifted by `week`/`day`. */
function isoWeekDate(y: number, week: number, day: number): [number, number, number] | null {
  if (week < 1 || week > 53 || day < 1 || day > 7) return null;
  const jan4 = new Date(Date.UTC(2000, 0, 4));
  jan4.setUTCFullYear(y);
  const wd = (jan4.getUTCDay() + 6) % 7; // Monday = 0
  const week1 = jan4.getTime() - wd * 86400000;
  if (week === 53) {
    // Only years whose 1 Jan is a Thursday (or a Wednesday in a leap year) have one.
    const jan1 = new Date(Date.UTC(2000, 0, 1));
    jan1.setUTCFullYear(y);
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const j = jan1.getUTCDay();
    if (!(j === 4 || (leap && j === 3))) return null;
  }
  const d = new Date(week1 + ((week - 1) * 7 + (day - 1)) * 86400000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** Fractional-second digits → microseconds, truncated past six as Python does. */
function micros(frac: string | undefined): number {
  return frac === undefined ? 0 : Number(frac.slice(0, 6).padEnd(6, "0"));
}

const ISO_DATE = /^(\d{4})(?:-(\d{2})-(\d{2})|(\d{2})(\d{2})|-W(\d{2})(?:-(\d))?|W(\d{2})(\d)?)/;
const ISO_TIME = /^(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?/;
const ISO_TZ = /^[+-](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?$/;

/**
 * `datetime.fromisoformat(s)` (3.11+ grammar) → [H, M, S] as `strftime` would
 * print it after `astimezone()` for an aware value; null where Python raises.
 */
function fromIso(s: string): string | null {
  const dm = ISO_DATE.exec(s);
  if (!dm) return null;
  let y = Number(dm[1]), mo: number, da: number;
  if (dm[2] !== undefined) {
    mo = Number(dm[2]);
    da = Number(dm[3]);
  } else if (dm[4] !== undefined) {
    mo = Number(dm[4]);
    da = Number(dm[5]);
  } else {
    const wk = Number(dm[6] ?? dm[8]);
    const dayStr = dm[7] ?? dm[9];
    const r = isoWeekDate(y, wk, dayStr === undefined ? 1 : Number(dayStr));
    if (!r) return null;
    [y, mo, da] = r;
  }
  if (y < 1 || mo < 1 || mo > 12 || da < 1 || da > daysInMonth(y, mo)) return null;
  let rest = s.slice(dm[0].length);
  let h = 0, mi = 0, se = 0, us = 0, tz: number | null = null, tzUs = 0;
  if (rest) {
    // Any single character separates date from time.
    const sep = Array.from(rest)[0] as string;
    rest = rest.slice(sep.length);
    const tm = ISO_TIME.exec(rest);
    if (!tm) return null;
    h = Number(tm[1]);
    mi = Number(tm[2] ?? 0);
    se = Number(tm[3] ?? 0);
    us = micros(tm[4]);
    rest = rest.slice(tm[0].length);
    if (rest) {
      if (rest === "Z") tz = 0;
      else {
        const zm = ISO_TZ.exec(rest);
        if (!zm) return null;
        const oh = Number(zm[1]), om = Number(zm[2] ?? 0), os = Number(zm[3] ?? 0);
        if (oh > 23 || om > 59 || os > 59) return null;
        const sign = rest[0] === "-" ? -1 : 1;
        tz = sign * (oh * 3600 + om * 60 + os);
        tzUs = sign * micros(zm[4]);
      }
    }
    if (h > 23 || mi > 59 || se > 59) {
      // 24:00:00 is accepted and means midnight of the next day.
      if (!(h === 24 && mi === 0 && se === 0 && (tm[4] === undefined || /^0+$/.test(tm[4])))) return null;
    }
  }
  if (tz === null) {
    return `${two(h % 24)}:${two(mi)}:${two(se)}`;
  }
  const d = new Date(0);
  d.setUTCFullYear(y, mo - 1, da);
  d.setUTCHours(h, mi, se, 0);
  // Sub-second parts of the time and the offset can borrow a whole second.
  const local = new Date(d.getTime() - tz * 1000 + Math.floor((us - tzUs) / 1e6) * 1000);
  if (Number.isNaN(local.getTime())) return null;
  // `astimezone()` goes through UTC, so both the UTC and the local value must
  // fit datetime's year range, or Python raises and the stamp falls back.
  for (const yr of [local.getUTCFullYear(), local.getFullYear()]) if (yr < 1 || yr > 9999) return null;
  return hms(local);
}

/**
 * `HH:MM:SS` from the event's own timestamp; `~HH:MM:SS` (decode time) when
 * the event has none, so an inferred time is never mistaken for a real one.
 */
function stamp(raw: PyValue): string {
  if (raw !== null) {
    const n = typeof raw === "string" || Array.isArray(raw) || isDict(raw) ? null : pyNum(raw);
    if (n !== null) {
      // epoch seconds or milliseconds
      const secs = n > 1e11 ? n / 1000.0 : n;
      const r = fromTimestamp(secs);
      if (r !== null) return r;
    } else {
      const r = fromIso(pyStr(raw).replaceAll("Z", "+00:00"));
      if (r !== null) return r;
    }
  }
  return "~" + hms(new Date());
}

interface EmitOpts {
  cont?: boolean;
  when?: PyValue;
  tag?: string | null;
}

/**
 * One pretty line: `HH:MM:SS  <icon> LABEL  [tag] text`. `cont` indents a
 * detail line under the previous message instead of re-stamping it. The tag is
 * repeated on continuation lines because subagent output interleaves — the line
 * above may belong to someone else.
 */
function emit(icon: string, label: string, text: string, { cont = false, when = null, tag = null }: EmitOpts = {}): void {
  const prefix = tag ? `[${tag}] ` : "";
  const line = cont ? `${INDENT}${icon} ${prefix}${text}` : `${stamp(when)}  ${icon} ${pyLjust(label, 7)} ${prefix}${text}`;
  checkEncodable(line);
  writeOut(line + "\n");
}

/**
 * Python's stdout is strict UTF-8: a lone surrogate (reachable through a JSON
 * `\ud83d` escape) makes `print` raise before writing anything, and `handle()`'s
 * caller reports that as a decode error line. Mirror it rather than printing U+FFFD.
 */
function checkEncodable(line: string): void {
  const cps = Array.from(line);
  const lone = (c: string): boolean => {
    const u = c.charCodeAt(0);
    return c.length === 1 && u >= 0xd800 && u <= 0xdfff;
  };
  const i = cps.findIndex(lone);
  if (i < 0) return;
  let j = i;
  while (j + 1 < cps.length && lone(cps[j + 1] as string)) j++;
  const hex = (cps[i] as string).charCodeAt(0).toString(16);
  const what = j > i
    ? `characters in position ${i}-${j}`
    : `character '\\u${hex}' in position ${i}`;
  throw new PyError("UnicodeEncodeError", `'utf-8' codec can't encode ${what}: surrogates not allowed`);
}

/** `x / 1000` with Python's TypeError for a non-number. */
function divide(v: PyValue, by: number): number {
  const n = typeof v === "string" || Array.isArray(v) || isDict(v) ? null : pyNum(v);
  if (n === null) throw new PyError("TypeError", `unsupported operand type(s) for /: '${pyType(v)}' and 'int'`);
  return n / by;
}

/** `format(v, ".{digits}f")` with Python's errors for a non-number. */
function fixed(v: PyValue, digits: number): string {
  if (typeof v === "string") throw new PyError("ValueError", "Unknown format code 'f' for object of type 'str'");
  const n = Array.isArray(v) || isDict(v) ? null : pyNum(v);
  if (n === null) throw new PyError("TypeError", `unsupported format string passed to ${pyType(v)}.__format__`);
  return pyFixed(n, digits);
}

function handle(obj: PyValue): void {
  const typ = pyGet(obj, "type");
  const when = pyGet(obj, "timestamp");

  if (typ === "system") {
    const sub = pyGet(obj, "subtype");
    if (sub === "init") {
      const model = pyGet(obj, "model", "?");
      const n = pyLen(pyOr(pyGet(obj, "tools", []), []));
      emit("⚙", "init", `model=${pyStr(model)} · ${n} tools`, { when });
    } else if (sub === "task_started") {
      const tuid = pyGet(obj, "tool_use_id");
      const tid = pyGet(obj, "task_id");
      if (pyTruthy(tid) && pyTruthy(tuid)) _task_ids.set(pyHashKey(tid), tuid);
      remember(tuid, pyGet(obj, "subagent_type"), pyGet(obj, "description"));
      const desc = clip(pyOr(pyGet(obj, "description"), "(no description)"));
      emit("▶", "task", `started · ${desc}`, { when, tag: label_for(tuid) });
    } else if (sub === "task_notification") {
      let tuid = pyGet(obj, "tool_use_id");
      if (!pyTruthy(tuid)) tuid = _task_ids.get(pyHashKey(pyGet(obj, "task_id"))) ?? null;
      const status = pyOr(pyGet(obj, "status"), "update");
      const summary = clip(pyOr(pyGet(obj, "summary"), ""));
      const body = summary ? `${pyStr(status)} · ${summary}` : pyStr(status);
      emit("⏹", "task", body, { when, tag: label_for(tuid) });
    }
    return;
  }

  if (typ === "assistant" || typ === "user") {
    const parent = pyGet(obj, "parent_tool_use_id");
    // A subagent's own events name their type; task_started may not have fired
    // yet (or may have been missed), so learn attribution from here too.
    remember(parent, pyGet(obj, "subagent_type"), pyGet(obj, "task_description"));
    const tag = label_for(parent);
    const msg = pyOr(pyGet(obj, "message", new Map()), new Map());
    const content = pyGet(msg, "content");
    if (typeof content === "string") {
      if (pyStrip(content)) emit("💬", "claude", clip(content), { when, tag });
      return;
    }
    for (const b of pyIter(pyOr(content, []))) {
      const bt = pyGet(b, "type");
      if (bt === "text") {
        if (pyStrip(asStr(pyGet(b, "text", ""), "strip"))) {
          emit("💬", "claude", clip(pyItem(b, "text")), { when, tag });
        }
      } else if (bt === "tool_use") {
        const name = pyGet(b, "name", "?");
        emit("🔧", "tool", `${pyStr(name)}  ${clip(pyJsonDumps(pyGet(b, "input", new Map())), 140)}`, { when, tag });
      } else if (bt === "tool_result") {
        let r = pyGet(b, "content");
        if (Array.isArray(r)) {
          let joined = "";
          let k = 0;
          for (const x of r) {
            if (!isDict(x)) continue;
            const t = pyGet(x, "text", "");
            if (typeof t !== "string") {
              throw new PyError("TypeError", `sequence item ${k}: expected str instance, ${pyType(t)} found`);
            }
            joined += t;
            k++;
          }
          r = joined;
        }
        if (pyStrip(pyStr(r))) emit("↳", "", clip(r, 160), { cont: true, tag });
      }
    }
    return;
  }

  if (typ === "result") {
    const dur = pyGet(obj, "duration_ms");
    const cost = pyGet(obj, "total_cost_usd");
    const sub = pyGet(obj, "subtype", "");
    const meta: string[] = [];
    if (dur !== null) meta.push(`${fixed(new PyFloat(divide(dur, 1000)), 1)}s`);
    if (cost !== null) meta.push(`$${fixed(cost, 4)}`);
    const suffix = meta.length ? ` (${meta.join(" · ")})` : "";
    const tag = label_for(pyGet(obj, "parent_tool_use_id"));
    emit("✅", "done", pyStrip(`${pyStr(sub)}${suffix}`), { when, tag });
    if (pyTruthy(pyGet(obj, "result"))) emit("→", "", clip(pyItem(obj, "result")), { cont: true, tag });
    return;
  }
}

function processLine(line: string): void {
  if (!pyStrip(line)) return;
  let obj: PyValue;
  try {
    obj = pyJsonLoads(line);
  } catch (e) {
    if (e instanceof JSONDecodeError) {
      writeOut(line + "\n"); // non-JSON (e.g. stderr) — pass through
      return;
    }
    throw e;
  }
  try {
    handle(obj);
  } catch (e) {
    // never let a decode bug drop the pass's output
    const msg = e instanceof Error ? e.message : String(e);
    writeOut(`[stream-decode: ${msg}] ${clip(line)}\n`);
  }
}

async function main(): Promise<void> {
  // Python's POSIX `sys.stdin` splits lines at "\n" only — no universal
  // newlines, so a CR stays in the line (json.loads treats a trailing one as
  // whitespace; a passed-through line keeps it) — and keeps a BOM as a character.
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      processLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  buf += dec.decode();
  if (buf) processLine(buf);
}

await main();
