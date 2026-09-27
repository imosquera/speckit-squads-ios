#!/usr/bin/env bun
// git extension: sync-issue-body.ts
// Render a feature's spec.md into its tracking issue's body, preserving the
// human-written report below `<!-- speckit:original-report -->` verbatim (#61,
// #63) and keeping split-issue.ts's work-breakdown block last. Re-syncs are
// byte-stable. The render itself is render-spec.ts; this owns the surgery.
//
// Usage:
//   sync-issue-body.ts <issue-number> <spec-path> [--omit S]... [--include S]...
//   sync-issue-body.ts <issue-number> --body-file FILE|-      pre-rendered body
//   ... [--dry-run]           compose and print the body, edit nothing
//
//   --omit "<heading>"     drop a `## <heading>` section (default: Success Criteria)
//   --include "<heading>"  keep a section the default omit list drops
//   --body-file FILE       use FILE (or `-`, stdin) as the rendered region
//   --current-body FILE    read the current body from FILE, not gh (testing seam)
//   --render-only          print the rendered region for a spec and stop (the create path)
//   --dry-run              print the composed body to stdout, run no `gh edit`
//
// Exit codes: 0 ok, 1 usage/gh/spec error, 2 the composed body would not carry
// the preserved region through verbatim (never written — a refusal, not a fix).

import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG_BEGIN = "<!-- speckit:original-report -->";
const ORIG_END = "<!-- /speckit:original-report -->";
const WB_BEGIN = "<!-- speckit:work-breakdown -->";
const WB_END = "<!-- /speckit:work-breakdown -->";
// The stub /speckit-git-feature opens the issue with; keep in sync with
// `_issue_body` in create-new-feature. Only the placeholder is dropped.
const STUB_MARK = "Stub created by `/speckit-git-feature`";
const STUB_LEAD = "Tracking issue for feature: ";
const STUB_SENTENCE = "Stub created by `/speckit-git-feature`. The full spec body will be filled in by `/speckit-specify`.";

function die(msg: string): never {
  console.error(`[speckit-git-issue] error: ${msg}`);
  process.exit(1);
}
function refuse(msg: string): never {
  console.error(`[speckit-git-issue] error: ${msg}`);
  process.exit(2);
}

const USAGE = `usage: sync-issue-body.ts <issue-number> <spec-path> [--omit S]... [--include S]... [--dry-run]
       sync-issue-body.ts <issue-number> --body-file FILE|- [--dry-run]
       sync-issue-body.ts --render-only <spec-path>`;

let issue = "", spec = "", bodyFile = "", currentFile = "", dry = false, renderOnly = false;
let omit = ["Success Criteria"];
const argv = process.argv.slice(2);
const value = (i: number, flag: string, what: string) => {
  const v = argv[i + 1];
  if (!v) die(`${flag} needs ${what}`);
  return v;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? "";
  switch (a) {
    case "--omit": omit.push(value(i++, a, "a heading")); break;
    case "--include": { const keep = value(i++, a, "a heading"); omit = omit.filter((s) => s !== keep); break; }
    case "--body-file": bodyFile = value(i++, a, "a path"); break;
    case "--current-body": currentFile = value(i++, a, "a path"); break;
    case "--render-only": renderOnly = true; break;
    case "--dry-run": dry = true; break;
    case "-h": case "--help": console.log(USAGE); process.exit(0);
    default:
      if (a.startsWith("-")) die(`unknown flag: ${a}`);
      if (renderOnly && !spec) spec = a;
      else if (!issue) issue = a.replace(/^#/, "");
      else if (!spec) spec = a;
      else die(`unexpected argument: ${a}`);
  }
}

const readable = (p: string) => { try { accessSync(p, constants.R_OK); return true; } catch { return false; } };
if (!renderOnly) {
  if (!issue) die("usage: sync-issue-body.ts <issue-number> <spec-path> [--dry-run]");
  if (!/^[0-9]+$/.test(issue)) die(`issue number must be numeric (got '${issue}')`);
}
if (!bodyFile) {
  if (!spec) die("need a <spec-path> or --body-file");
  if (!readable(spec)) die(`spec not readable: ${spec}`);
}
if (!currentFile && !renderOnly && !Bun.which("gh")) die("gh not found — install it or run 'gh auth login'");

// Text helpers mirror the bash original: a "text" is a `$(…)` capture (no
// trailing newlines), and line tools see it as `printf '%s\n' "$text"`.
const cap = (lines: string[]) => lines.join("\n").replace(/\n+$/, "");
const lines = (t: string) => t.split("\n");

// sed '\|B|,\|E|p' (keep) or 'd' (!keep): E is looked for from the line after
// B, and an unclosed range runs to EOF.
function sedRange(t: string, b: string, e: string, keep: boolean): string[] {
  const out: string[] = [];
  let inside = false;
  for (const l of lines(t)) {
    const hit: boolean = inside || l.includes(b);
    if (hit === keep) out.push(l);
    inside = inside ? !l.includes(e) : hit;
  }
  return out;
}
const between = (b: string, e: string, t: string) => cap(sedRange(t, b, e, true));
// between, minus the sentinel lines themselves (sed '1d;$d')
const inner = (b: string, e: string, t: string) => { const r = sedRange(t, b, e, true); return cap(r.slice(1, r.length - 1)); };
const lineOf = (needle: string, t: string) => lines(t).findIndex((l) => l.includes(needle)) + 1; // 0 = absent
// Drop leading and trailing blank lines.
const trimBlank = (t: string) => { const l = lines(t); const i = l.findIndex((x) => x !== ""); return cap(i < 0 ? [] : l.slice(i)); };
// Remove the placeholder, keeping everything else a reporter added to the stub.
const stripStub = (t: string) => cap(lines(t).filter((l) => !l.startsWith(STUB_LEAD)).map((l) => l.replace(STUB_SENTENCE, "")));

let current = "";
if (renderOnly) {
  // nothing to preserve; nothing to read
} else if (currentFile) {
  if (!readable(currentFile)) die(`current body not readable: ${currentFile}`);
  current = readFileSync(currentFile, "utf8").replace(/\n+$/, "");
} else {
  const r = Bun.spawnSync(["gh", "issue", "view", issue, "--json", "body", "--jq", ".body"], { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) die(`could not read issue #${issue}`);
  current = r.stdout.toString().replace(/\n+$/, "");
}

const workbreakdown = current.includes(WB_BEGIN) ? between(WB_BEGIN, WB_END, current) : "";

// First sync: everything but the breakdown is the report. Later syncs: whatever
// is already inside the sentinels, byte for byte.
let preserved: string, hadSentinel: boolean;
if (current.includes(ORIG_BEGIN)) {
  // An unclosed region would run to EOF and silently lose the last line; refuse.
  const b = lineOf(ORIG_BEGIN, current), e = lineOf(ORIG_END, current);
  if (!e || e <= b) {
    refuse(`issue #${issue} body opens '${ORIG_BEGIN}' with no matching '${ORIG_END}' after it — refusing to guess where the original report ends; nothing written`);
  }
  preserved = inner(ORIG_BEGIN, ORIG_END, current);
  hadSentinel = true;
} else {
  hadSentinel = false;
  preserved = trimBlank(cap(sedRange(current, WB_BEGIN, WB_END, false)));
  if (preserved.includes(STUB_MARK)) preserved = trimBlank(stripStub(preserved));
}

// bun is already running us, so the renderer's runtime cannot be missing.
let render: string;
if (bodyFile) {
  if (bodyFile === "-") render = readFileSync(0, "utf8");
  else {
    if (!readable(bodyFile)) die(`body file not readable: ${bodyFile}`);
    render = readFileSync(bodyFile, "utf8");
  }
} else {
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "render-spec.ts"), spec, ...omit], { stdout: "pipe", stderr: "inherit" });
  if (r.exitCode !== 0) die(`could not render ${spec}`);
  render = r.stdout.toString();
}
if (!render) die("rendered body is empty — refusing to publish it");

if (renderOnly) {
  process.stdout.write(render);
  process.exit(0);
}

// The heading sits above the begin sentinel and nothing wraps the report, so
// the next run reads back exactly what this one wrote.
let composed = render;
if (preserved) composed += `\n## Original report (as filed)\n\n${ORIG_BEGIN}\n${preserved}\n${ORIG_END}\n`;
if (workbreakdown) composed += `\n${workbreakdown}\n`;

// Refuse rather than repair: losing the report is what this script prevents.
const composedText = composed.replace(/\n+$/, "");
if (preserved && inner(ORIG_BEGIN, ORIG_END, composedText) !== preserved) {
  refuse("composed body would not carry the original report through verbatim — nothing written");
}
if (workbreakdown && !composedText.includes(WB_BEGIN)) {
  refuse("composed body dropped the work-breakdown block — nothing written");
}

if (dry) {
  process.stdout.write(composed);
  process.exit(0);
}

const TMP = mkdtempSync(join(tmpdir(), "sync-issue-body-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
const newFile = join(TMP, "new.md");
writeFileSync(newFile, composed);
if (Bun.spawnSync(["gh", "issue", "edit", issue, "--body-file", newFile], { stdout: "ignore", stderr: "inherit" }).exitCode !== 0) {
  die(`gh issue edit failed for #${issue}`);
}

const url = Bun.spawnSync(["gh", "issue", "view", issue, "--json", "url", "--jq", ".url"], { stdout: "pipe", stderr: "ignore" })
  .stdout.toString().replace(/\n+$/, "");
const note = hadSentinel ? "report preserved"
  : preserved ? "original report preserved below the sentinel" : "no prior report to preserve";
console.log(`[speckit-git-issue] #${issue} body synced from ${spec || bodyFile} — ${note}${url ? ` — ${url}` : ""}`);
